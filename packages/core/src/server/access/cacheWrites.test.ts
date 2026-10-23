// The access cache evicts what a tracked write changes as soon as the write
// is durable (RFC 0003 section 4.2), not when its call's unit of work
// flushes after the response. With `cacheMs` on, a check later in the same
// call (`ctx.access`, a `ctx.services` call's authorization) sees the call's
// own write, and so does another request on the node while that call runs
// on. A write outside a transaction is durable at once, a transaction's
// writes at its commit (a savepoint's when the transaction around it
// commits), and a rolled-back write never: the cache then keeps what it
// held, which is still right. A closed server stops hearing the client's
// writes.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -
//   T1 in P1, T2 in P2

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../../test/prisma/setup";
import { defineContract, mutation, query } from "../../index";
import { QuickdrawError } from "../../protocol/errors";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, type TestApp } from "../../testing/index";
import { deferred, type Deferred } from "../__tests__/fixtures";
import type { BaseContext } from "../context";
import { anyOf, initQuickdraw, jsonAcl, type Principal, type StorageAdapter } from "../index";
import type { WriteRecord } from "../uow/types";
import { as, projectMembers, seedBoard, type Board } from "./__tests__/board";

/** How `leave` deletes the caller's membership row. */
const how = z.enum([
  // the root client, outside any transaction: durable at once
  "root",
  // an interactive transaction that commits
  "transaction",
  // an interactive transaction that rolls back
  "rolledBack",
  // a savepoint that commits, in a transaction that commits
  "savepoint",
  // a savepoint that rolls back, in a transaction that commits
  "savepointRolledBack",
  // a savepoint that commits, in a transaction that rolls back
  "savepointInRolledBack",
  // the untracked client, then ctx.touch: a write the tracked client cannot see
  "touch",
]);

type How = z.infer<typeof how>;

/** What `ctx.access` gives the caller after the write, and the statements it read that with. */
const seen = z.object({ level: z.string().nullable(), reads: z.number() });

const projects = defineContract("projectService", {
  entity: z.object({ id: z.string(), name: z.string() }),
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    // Admin only: what a call nested in giveAway asks for.
    administer: mutation({ input: z.object({ id: z.string() }), output: z.literal(true) }),
    // The caller leaves the project as `how` says, then asks ctx.access for their level on it.
    leave: mutation({ input: z.object({ id: z.string(), how }), output: seen }),
    // The caller leaves the project, then reads it through ctx.services: how that call ended.
    leaveThenGet: mutation({ input: z.object({ id: z.string() }), output: z.string() }),
    // The owner gives the project away, then administers it through ctx.services: how that ended.
    giveAway: mutation({ input: z.object({ id: z.string(), to: z.string() }), output: z.string() }),
    // An Admin removes a member, then waits for `held` before the call returns and flushes.
    removeMember: mutation({
      input: z.object({ id: z.string(), userId: z.string() }),
      output: z.null(),
    }),
  },
});

// The contract typed: a call through ctx.services is typed as a client's.
const qd = initQuickdraw<{
  db: PrismaClient;
  principal: Principal;
  contracts: { readonly project: typeof projects };
}>();

let h: Harness;
let board: Board;
const apps: TestApp[] = [];

/** Holds `removeMember` between its write and its return, when set. */
let held: { readonly written: Deferred<void>; readonly release: Deferred<void> } | undefined;

const UNDONE = "roll the transaction back";

/** Resolves once `transaction` rejected with {@link UNDONE}: a rollback the test asked for. */
async function undone(transaction: Promise<unknown>): Promise<void> {
  await expect(transaction).rejects.toThrow(UNDONE);
}

type Member = { readonly projectId: string; readonly userId: string };

/** Deletes `member`'s membership row as `way` says. */
async function leave(db: PrismaClient, touch: BaseContext["touch"], member: Member, way: How) {
  const where = { projectId_userId: member };
  const remove = async (client: Pick<PrismaClient, "projectMember">): Promise<void> => {
    await client.projectMember.delete({ where });
  };
  const removeThenFail = async (client: Pick<PrismaClient, "projectMember">): Promise<void> => {
    await remove(client);
    throw new Error(UNDONE);
  };
  const ways: Record<How, () => Promise<unknown>> = {
    root: () => remove(db),
    transaction: () => db.$transaction(remove),
    rolledBack: () => undone(db.$transaction(removeThenFail)),
    savepoint: () => db.$transaction((tx) => tx.$transaction(remove)),
    savepointRolledBack: () => db.$transaction((tx) => undone(tx.$transaction(removeThenFail))),
    savepointInRolledBack: () =>
      undone(
        db.$transaction(async (tx) => {
          await tx.$transaction(remove);
          throw new Error(UNDONE);
        }),
      ),
    touch: async () => {
      const row = await h.prisma.projectMember.delete({ where });
      touch("projectMember", row.id, { removed: true });
    },
  };
  await ways[way]();
}

/** How a call ended: `"passed"`, or the code of its error. */
async function outcome(call: Promise<unknown>): Promise<string> {
  try {
    await call;
    return "passed";
  } catch (error) {
    return error instanceof QuickdrawError ? error.code : "threw";
  }
}

const projectService = qd.defineService(projects, {
  model: "project",
  access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
  methods: {
    get: {
      access: { entry: "Read" },
      handler: ({ input, db }) =>
        db.project.findUniqueOrThrow({ where: { id: input.id }, select: { id: true, name: true } }),
    },
    administer: { access: { entry: "Admin" }, handler: () => true as const },
    leave: {
      access: { entry: "Read" },
      handler: async ({ input, ctx, db }) => {
        const member = { projectId: input.id, userId: ctx.principal.userId };
        await leave(db, ctx.touch, member, input.how);
        const { value, statements } = await h.storage.countStatements(() =>
          ctx.access.levelsFor(projects, [input.id]),
        );
        return { level: value.get(input.id) ?? null, reads: statements };
      },
    },
    leaveThenGet: {
      access: { entry: "Read" },
      handler: async ({ input, ctx, db }) => {
        await db.projectMember.delete({
          where: { projectId_userId: { projectId: input.id, userId: ctx.principal.userId } },
        });
        return await outcome(ctx.services.projectService.get({ id: input.id }));
      },
    },
    giveAway: {
      access: { entry: "Admin" },
      handler: async ({ input, ctx, db }) => {
        await db.project.update({ where: { id: input.id }, data: { ownerId: input.to } });
        return await outcome(ctx.services.projectService.administer({ id: input.id }));
      },
    },
    removeMember: {
      access: { entry: "Admin" },
      handler: async ({ input, db }) => {
        await db.projectMember.delete({
          where: { projectId_userId: { projectId: input.id, userId: input.userId } },
        });
        held?.written.resolve();
        await held?.release.promise;
        return null;
      },
    },
  },
});

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.database.reset();
  board = await seedBoard(h.prisma);
});

afterEach(async () => {
  held?.release.resolve();
  held = undefined;
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

/** A test app on the board that keeps policy lookups for a minute. */
async function start() {
  const app = await createTestApp({
    services: [projectService],
    db: h.db,
    access: { cacheMs: 60_000 },
  });
  apps.push(app as unknown as TestApp);
  return app;
}

type App = Awaited<ReturnType<typeof start>>;

/** The statements one `levelsFor` of the project service issued, and the level it found. */
async function lookupOf(app: App, userId: string, id: string): Promise<[number, string | null]> {
  const counted = await h.storage.countStatements(() =>
    app.server.dispatcher.access.levelsFor("projectService", as(userId), [id]),
  );
  return [counted.statements, counted.value.get(id) ?? null];
}

describe("a check later in the same call", () => {
  it("sees through ctx.access that the call removed its caller's membership", async () => {
    const app = await start();
    // The method's own check kept Cy's Read; the delete evicts it, so the membership is read again.
    expect(await app.as(as(board.cy)).projectService.leave({ id: board.p1, how: "root" })).toEqual({
      level: null,
      reads: 1,
    });
  });

  it("refuses a nested ctx.services call the removed membership allowed", async () => {
    const app = await start();
    expect(await app.as(as(board.cy)).projectService.leaveThenGet({ id: board.p1 })).toBe(
      "FORBIDDEN",
    );
  });

  it("refuses an Admin-only nested call once the call gave its row away (the row's columns)", async () => {
    const app = await start();
    const ada = app.as(as(board.ada)).projectService;
    expect(await ada.giveAway({ id: board.p1, to: board.ed })).toBe("FORBIDDEN");
    // The nested call kept the row as it read it; the flush evicted it again after the response.
    expect(await lookupOf(app, board.ed, board.p1)).toEqual([2, "Admin"]);
  });

  it("evicts what ctx.touch records, the whole membership table", async () => {
    const app = await start();
    expect(await lookupOf(app, board.bo, board.p1)).toEqual([2, "Moderate"]);
    expect(await app.as(as(board.cy)).projectService.leave({ id: board.p1, how: "touch" })).toEqual(
      { level: null, reads: 1 },
    );
    // A touch names no member: every member's level on every row is read again.
    expect(await lookupOf(app, board.bo, board.p1)).toEqual([1, "Moderate"]);
  });
});

describe("a transaction's writes", () => {
  it.each(["transaction", "savepoint"] as const)(
    "evict at the commit, before a check after it in the same call (%s)",
    async (way) => {
      const app = await start();
      expect(await app.as(as(board.cy)).projectService.leave({ id: board.p1, how: way })).toEqual({
        level: null,
        reads: 1,
      });
      expect(await h.prisma.projectMember.count({ where: { userId: board.cy } })).toBe(0);
    },
  );

  it.each(["rolledBack", "savepointRolledBack", "savepointInRolledBack"] as const)(
    "evict nothing when they roll back: the cache keeps the level, which is still right (%s)",
    async (way) => {
      const app = await start();
      expect(await app.as(as(board.cy)).projectService.leave({ id: board.p1, how: way })).toEqual({
        level: "Read",
        reads: 0,
      });
      expect(await h.prisma.projectMember.count({ where: { userId: board.cy } })).toBe(1);
      expect(await lookupOf(app, board.cy, board.p1)).toEqual([0, "Read"]);
    },
  );
});

describe("another request on the node", () => {
  it("is refused while the call that removed its membership runs on, before that call flushes", async () => {
    const app = await start();
    const cy = app.as(as(board.cy)).projectService;
    await expect(cy.get({ id: board.p1 })).resolves.toMatchObject({ id: board.p1 });
    held = { written: deferred(), release: deferred() };
    const removing = app
      .as(as(board.ada))
      .projectService.removeMember({ id: board.p1, userId: board.cy });
    await held.written.promise;
    await expect(cy.get({ id: board.p1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    held.release.resolve();
    await expect(removing).resolves.toBeNull();
  });

  it("is refused after a write made through another dispatcher on the same tracked client", async () => {
    const app = await start();
    const other = await start();
    const cy = app.as(as(board.cy)).projectService;
    await expect(cy.get({ id: board.p1 })).resolves.toMatchObject({ id: board.p1 });
    // The other server's flush reaches only its own sinks: the write itself evicts here.
    await other.server.dispatcher.run(() =>
      h.db.projectMember.delete({
        where: { projectId_userId: { projectId: board.p1, userId: board.cy } },
      }),
    );
    await expect(cy.get({ id: board.p1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("the flush", () => {
  it("still evicts after the response, for a storage adapter whose onWrite reports nothing", async () => {
    const app = await createTestApp({
      services: [projectService],
      db: h.db,
      storage: { ...h.storage, onWrite: () => () => undefined },
      access: { cacheMs: 60_000 },
    });
    apps.push(app as unknown as TestApp);
    const cy = app.as(as(board.cy)).projectService;
    // No write is reported, so the call's own check still finds the level it kept...
    expect(await cy.leave({ id: board.p1, how: "root" })).toEqual({ level: "Read", reads: 0 });
    // ...and the call's flush evicts it.
    await expect(cy.get({ id: board.p1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("the write listener", () => {
  /** The board's storage adapter, recording what `onWrite` registers and each write it delivers. */
  function spiedStorage() {
    const heard: WriteRecord[] = [];
    const stops: ReturnType<typeof vi.fn<() => void>>[] = [];
    const storage: StorageAdapter = {
      ...h.storage,
      onWrite: (listener) => {
        const stop = vi.fn(
          h.storage.onWrite((write) => {
            heard.push(write);
            listener(write);
          }),
        );
        stops.push(stop);
        return stop;
      },
    };
    return { storage, heard, stops };
  }

  it("is removed when the server closes, and never added without cacheMs", async () => {
    const spied = spiedStorage();
    const plain = await createTestApp({
      services: [projectService],
      db: h.db,
      storage: spied.storage,
    });
    await plain.close();
    expect(spied.stops).toHaveLength(0);

    const app = await createTestApp({
      services: [projectService],
      db: h.db,
      storage: spied.storage,
      access: { cacheMs: 60_000 },
    });
    try {
      expect(spied.stops).toHaveLength(1);
      await app.server.dispatcher.run(() =>
        h.db.project.update({ where: { id: board.p1 }, data: { name: "Renamed" } }),
      );
      expect(spied.heard).toHaveLength(1);
    } finally {
      await app.close();
    }
    expect(spied.stops[0]).toHaveBeenCalledOnce();
    // The tracked client serves other dispatchers on: their writes no longer reach this one.
    await h.inUnit(() => h.db.project.update({ where: { id: board.p1 }, data: { name: "Again" } }));
    expect(spied.heard).toHaveLength(1);
  });
});
