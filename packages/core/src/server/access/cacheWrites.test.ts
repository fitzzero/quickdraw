// The access cache evicts what a tracked write changes as soon as the write
// is durable (RFC 0003 section 4.2), not when its call's unit of work
// flushes after the response. With `cacheMs` on, a check later in the same
// call (`ctx.access`, a `ctx.services` call's authorization) sees the call's
// own write, and so does another request on the node while that call runs
// on. A write outside a transaction is durable at once, a transaction's
// writes at its commit (a savepoint's when the transaction around it
// commits), and a rolled-back write never: the cache then keeps what it
// held, which is still right. A closed server stops hearing the client's
// writes, and so does one that fails to start (one whose options are
// refused never starts hearing them); a dispatcher whose construction
// throws never starts, and `cacheMs` refuses a storage adapter that cannot
// report them.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -
//   T1 in P1, T2 in P2

import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../../test/prisma/setup";
import { defineContract, mutation, query } from "../../index";
import { QuickdrawError } from "../../protocol/errors";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, type TestApp } from "../../testing/index";
import { deferred, type Deferred } from "../__tests__/fixtures";
import type { BaseContext } from "../context";
import { detachDispatcher } from "../dispatcher";
import { anyOf, initQuickdraw, jsonAcl, type Principal, type StorageAdapter } from "../index";
import type { WriteRecord } from "../uow/types";
import { as, projectMembers, seedBoard, type Board } from "./__tests__/board";
import type { ContextAccess } from "./api";

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
    // The caller deletes the project (the database deletes its memberships, unseen), then asks
    // ctx.access for their level on it.
    remove: mutation({ input: z.object({ id: z.string() }), output: seen }),
    // The caller creates a project with the id given, owned by Ed, then asks ctx.access for their
    // level on it.
    recreate: mutation({ input: z.object({ projectId: z.string() }), output: seen }),
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

/** The caller's level on `id` through ctx.access, and the statements it read that with. */
async function levelAfter(access: ContextAccess, id: string): Promise<z.infer<typeof seen>> {
  const { value, statements } = await h.storage.countStatements(() =>
    access.levelsFor(projects, [id]),
  );
  return { level: value.get(id) ?? null, reads: statements };
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
        return await levelAfter(ctx.access, input.id);
      },
    },
    remove: {
      access: { entry: "Moderate" },
      handler: async ({ input, ctx, db }) => {
        await db.project.delete({ where: { id: input.id } });
        return await levelAfter(ctx.access, input.id);
      },
    },
    recreate: {
      access: "authenticated",
      handler: async ({ input, ctx, db }) => {
        await db.project.create({ data: { id: input.projectId, name: "P1", ownerId: board.ed } });
        return await levelAfter(ctx.access, input.projectId);
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

describe("a row with memberships, created or deleted in the call", () => {
  it("evicts every member's level on it when it is deleted, with the memberships it cascades to", async () => {
    const app = await start();
    // The method's own check kept Bo's Moderate. The database deletes his membership with the
    // row, unseen: the row's delete evicts it, so both the row and the membership are read again.
    expect(await app.as(as(board.bo)).projectService.remove({ id: board.p1 })).toEqual({
      level: null,
      reads: 2,
    });
  });

  it("evicts every level kept for its id when it is created again", async () => {
    const app = await start();
    expect(await lookupOf(app, board.cy, board.p1)).toEqual([2, "Read"]);
    // A delete the tracked client does not see leaves Cy's Read on P1 in the cache...
    await h.prisma.project.delete({ where: { id: board.p1 } });
    expect(await lookupOf(app, board.cy, board.p1)).toEqual([0, "Read"]);
    // ...until a row with that id is created again: Cy has no level on the new one.
    expect(await app.as(as(board.cy)).projectService.recreate({ projectId: board.p1 })).toEqual({
      level: null,
      reads: 2,
    });
  });
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
  /**
   * The board's storage adapter, recording what `onWrite` registers and each write it delivers,
   * the detach of each dispatcher attached to the tracked client, and the startup check's probes.
   */
  function spiedStorage() {
    const heard: WriteRecord[] = [];
    const stops: ReturnType<typeof vi.fn<() => void>>[] = [];
    const detaches: ReturnType<typeof vi.fn<() => void>>[] = [];
    const trackable = vi.fn(h.storage.trackable);
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
      unitOfWork: {
        ...h.storage.unitOfWork,
        attach(sink, logger, warnings) {
          const detach = h.storage.unitOfWork.attach?.(sink, logger, warnings);
          const spy = vi.fn(() => {
            if (typeof detach === "function") {
              detach();
            }
          });
          detaches.push(spy);
          return spy;
        },
      },
      trackable,
    };
    return { storage, heard, stops, detaches, trackable };
  }

  /** A Socket.IO adapter that cannot be made, as a misconfigured cluster adapter fails. */
  function brokenAdapter(): never {
    throw new Error("adapter broke");
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

  describe("of a createServer that fails to start", () => {
    it.each([
      [{ maxBodyBytes: 0 }, "http.maxBodyBytes must be a whole number of bytes, 1 or more"],
      [{ rateLimit: 5 as never }, "http.rateLimit must be an Express middleware"],
    ])("is never added when it refuses http %j, nor the dispatcher attached", (http, refusal) => {
      const spied = spiedStorage();
      expect(() =>
        qd.createServer({
          services: [projectService],
          db: h.db,
          storage: spied.storage,
          access: { cacheMs: 60_000 },
          http,
        }),
      ).toThrow(refusal);
      expect(spied.stops).toHaveLength(0);
      expect(spied.detaches).toHaveLength(0);
    });

    it("is removed with the dispatcher when it fails once that is made, before anything that cannot be undone", () => {
      const spied = spiedStorage();
      const app = Object.assign(
        (_req: IncomingMessage, res: ServerResponse) => {
          res.end();
        },
        { use: vi.fn() },
      );
      const httpServer = createHttpServer(app);
      expect(() =>
        qd.createServer({
          services: [projectService],
          db: h.db,
          storage: spied.storage,
          access: { cacheMs: 60_000 },
          app,
          httpServer,
          socket: { adapter: brokenAdapter },
        }),
      ).toThrow("adapter broke");
      // The dispatcher was attached, with the listener, and detached again...
      expect(spied.stops).toHaveLength(1);
      expect(spied.stops[0]).toHaveBeenCalledOnce();
      expect(spied.detaches).toHaveLength(1);
      expect(spied.detaches[0]).toHaveBeenCalledOnce();
      // ...and the app has no router of it, its HTTP server no Socket.IO, and no check started.
      expect(app.use).not.toHaveBeenCalled();
      expect(httpServer.listeners("request")).toEqual([app]);
      expect(httpServer.listenerCount("upgrade")).toBe(0);
      expect(spied.trackable).not.toHaveBeenCalled();
    });

    it("is not left beside the one a valid createServer adds on the same tracked client", async () => {
      const spied = spiedStorage();
      const options = {
        services: [projectService],
        db: h.db,
        storage: spied.storage,
        access: { cacheMs: 60_000 },
      };
      expect(() => qd.createServer({ ...options, http: { maxBodyBytes: 0 } })).toThrow(
        "http.maxBodyBytes",
      );
      expect(() => qd.createServer({ ...options, socket: { adapter: brokenAdapter } })).toThrow(
        "adapter broke",
      );
      const app = await createTestApp(options);
      try {
        expect(spied.trackable).toHaveBeenCalled();
        await app.server.dispatcher.run(() =>
          h.db.project.update({ where: { id: board.p1 }, data: { name: "Renamed" } }),
        );
        expect(spied.heard).toHaveLength(1);
      } finally {
        await app.close();
      }
      // Each dispatcher attached to the tracked client, the failed one's and the server's, was
      // detached once, with its listener.
      expect(spied.detaches).toHaveLength(2);
      for (const detach of [...spied.stops, ...spied.detaches]) {
        expect(detach).toHaveBeenCalledOnce();
      }
      await h.inUnit(() =>
        h.db.project.update({ where: { id: board.p1 }, data: { name: "Again" } }),
      );
      expect(spied.heard).toHaveLength(1);
    });

    it("leaves it its own error when removing the listener throws too, and the dispatcher detached", () => {
      const spied = spiedStorage();
      expect(() =>
        qd.createServer({
          services: [projectService],
          db: h.db,
          storage: {
            ...spied.storage,
            onWrite: () => () => {
              throw new Error("unsubscribe broke");
            },
          },
          access: { cacheMs: 60_000 },
          socket: { adapter: brokenAdapter },
        }),
      ).toThrow("adapter broke");
      expect(spied.detaches).toHaveLength(1);
      expect(spied.detaches[0]).toHaveBeenCalledOnce();
    });
  });

  it("is never added by a dispatcher whose construction throws, so none is left behind", () => {
    const spied = spiedStorage();
    expect(() =>
      qd.createDispatcher({
        services: [projectService],
        db: h.db,
        storage: spied.storage,
        access: { cacheMs: 60_000 },
        limits: { maxInFlightQueries: -1 },
      }),
    ).toThrow("limits.maxInFlightQueries");
    expect(spied.stops).toHaveLength(0);
  });

  it("is removed once, however often the dispatcher is detached", () => {
    const spied = spiedStorage();
    const dispatcher = qd.createDispatcher({
      services: [projectService],
      db: h.db,
      storage: spied.storage,
      access: { cacheMs: 60_000 },
    });
    expect(spied.stops).toHaveLength(1);
    detachDispatcher(dispatcher);
    detachDispatcher(dispatcher);
    expect(spied.stops[0]).toHaveBeenCalledOnce();
  });

  it("detaches the dispatcher from the tracked client even when removing the listener throws", () => {
    const detached = vi.fn();
    const storage: StorageAdapter = {
      ...h.storage,
      onWrite: () => () => {
        throw new Error("unsubscribe broke");
      },
      unitOfWork: {
        ...h.storage.unitOfWork,
        attach(sink, logger, warnings) {
          const detach = h.storage.unitOfWork.attach?.(sink, logger, warnings);
          return () => {
            detached();
            if (typeof detach === "function") {
              detach();
            }
          };
        },
      },
    };
    const dispatcher = qd.createDispatcher({
      services: [projectService],
      db: h.db,
      storage,
      access: { cacheMs: 60_000 },
    });
    expect(() => detachDispatcher(dispatcher)).toThrow("unsubscribe broke");
    expect(detached).toHaveBeenCalledOnce();
  });

  it("needs the storage adapter's onWrite with cacheMs, and only then", () => {
    const storage = { ...h.storage, onWrite: undefined } as unknown as StorageAdapter;
    const make = (cacheMs?: number) =>
      qd.createDispatcher({
        services: [projectService],
        db: h.db,
        storage,
        ...(cacheMs === undefined ? {} : { access: { cacheMs } }),
      });
    expect(() => make(60_000)).toThrow(
      new TypeError(
        "createDispatcher: access.cacheMs needs the storage adapter's onWrite(listener) (trackPrisma's has it); an adapter that cannot report writes can pass onWrite: () => () => {} to evict only at the flush",
      ),
    );
    // Without the cache nothing listens, and the dispatcher is made.
    detachDispatcher(make());
  });
});
