// A `via` list over the item service's own `members` table counts only the
// links whose role gives at least the list's access (the 5.1 audit's
// COLL-1, its `via` variant): a member demoted to a role below `Read` kept
// the project in their list, with its updates. The list here is anchored on
// a directory of users, so only this rule decides, not the self scope's
// policy filter; a self list over the same table checks that the flush's
// removal reaches it once.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../../test/prisma/setup";
import { defineContract, mutation, via, type CollectionFrame } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { as, projectMembers, seedBoard, type Board } from "../access/__tests__/board";
import { qd, recordingStorage } from "../emit/__tests__/live";
import { anyOf, everyone, jsonAcl } from "../index";
import { receiveScopes } from "./__tests__/fixture";

let h: Harness;
let board: Board;
const apps: TestApp[] = [];

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
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

/** Every user, readable by everyone: what the lists are anchored on; `touchMember` touches a junction row. */
const directory = defineContract("directoryService", {
  entity: z.object({ id: z.string(), name: z.string() }),
  methods: {
    touchMember: mutation({ input: z.object({ id: z.string() }), output: z.null() }),
  },
});

const directoryService = qd.defineService(directory, {
  model: "user",
  access: everyone("Read"),
  methods: {
    touchMember: {
      access: "authenticated",
      rowless: true,
      handler: ({ input, ctx }) => {
        ctx.touch("projectMember", [input.id]);
        return null;
      },
    },
  },
});

/** Each user's projects, through the very membership table the projects' policy reads. */
const projectsOf = defineContract("projectsOfService", {
  entity: z.object({ id: z.string(), name: z.string() }),
  methods: {},
  collections: {
    of: {
      scope: via({ model: "projectMember", entry: "projectId", scope: "userId" }),
      item: "entity",
      order: [["id", "asc"]],
    },
  },
});

const projectsOfService = qd.defineService(projectsOf, {
  model: "project",
  access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
  collections: { of: { anchor: directory } },
  methods: {},
});

/** Each user's own list of their projects, through the same table. */
const myProjects = defineContract("myProjectsService", {
  entity: z.object({ id: z.string(), name: z.string() }),
  methods: {},
  collections: {
    mine: {
      scope: via({ model: "projectMember", entry: "projectId", scope: "userId" }),
      item: "entity",
      order: [["id", "asc"]],
    },
  },
});

const myProjectsService = qd.defineService(myProjects, {
  model: "project",
  access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
  collections: { mine: { scopeAccess: "self" } },
  methods: {},
});

const recorded = () => recordingStorage(h.storage);
let reads: ReturnType<typeof recorded>["reads"] = [];

async function start() {
  const storage = recorded();
  reads = storage.reads;
  const app = await createTestApp({
    services: [directoryService, projectsOfService, myProjectsService],
    db: h.db,
    storage: storage.storage,
  });
  apps.push(app as unknown as TestApp);
  return app;
}

type App = Awaited<ReturnType<typeof start>>;

/** Runs `fn` in a unit of work of the app's dispatcher: its tracked writes flush to the sinks. */
function write<T>(app: App, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  return app.server.dispatcher.run(async () => await fn(h.db));
}

/** ada, watching cy's list. */
async function watcher(app: App) {
  const connection = await app.connect(as(board.ada));
  const scopes = receiveScopes(connection);
  const request = { s: "projectsOfService", c: "of", scope: board.cy };
  return {
    scopes,
    subscribe: () => emitWithAck(connection.socket, "qd:col:sub", request),
    items: (ids: readonly string[]) =>
      emitWithAck(connection.socket, "qd:col:items", { ...request, ids }),
    deltas: () => scopes.frames.map((frame: CollectionFrame) => frame.deltas),
  };
}

describe("a via list over the item service's members table", () => {
  it("drops a member whose role falls below the list's access, and adds them back", async () => {
    const app = await start();
    const ada = await watcher(app);
    expect(await ada.subscribe()).toMatchObject({ ok: true, items: [{ id: board.p1 }] });
    await write(app, (db) =>
      db.projectMember.updateMany({
        where: { projectId: board.p1, userId: board.cy },
        data: { role: "Public" },
      }),
    );
    await ada.scopes.settle();
    expect(ada.deltas()).toEqual([[{ t: "removed", id: board.p1 }]]);
    expect(await ada.subscribe()).toMatchObject({ ok: true, items: [], total: 0 });
    expect(await ada.items([board.p1])).toMatchObject({ ok: true, items: [] });
    ada.scopes.clear();
    await write(app, (db) =>
      db.projectMember.updateMany({
        where: { projectId: board.p1, userId: board.cy },
        data: { role: "Read" },
      }),
    );
    await ada.scopes.settle();
    expect(ada.deltas()).toEqual([[{ t: "added", item: { id: board.p1, name: "P1" } }]]);
  });

  it("tells a deleted project only to the lists its counted links put it in (COLL-3)", async () => {
    const app = await start();
    await h.prisma.projectMember.updateMany({
      where: { projectId: board.p1, userId: board.cy },
      data: { role: "Public" },
    });
    const connection = await app.connect(as(board.ada));
    const scopes = receiveScopes(connection);
    const subscribe = (scope: string) =>
      emitWithAck(connection.socket, "qd:col:sub", { s: "projectsOfService", c: "of", scope });
    // cy's Public link never counted, so her list never held P1; bo's Moderate one did.
    expect(await subscribe(board.cy)).toMatchObject({ ok: true, items: [] });
    expect(await subscribe(board.bo)).toMatchObject({ ok: true, items: [{ id: board.p1 }] });
    await write(app, (db) => db.project.delete({ where: { id: board.p1 } }));
    await scopes.settle();
    expect(scopes.frames.map((frame: CollectionFrame) => [frame.scope, frame.deltas])).toEqual([
      [board.bo, [{ t: "removed", id: board.p1 }]],
    ]);
  });

  it("does not add a link created below the list's access", async () => {
    const app = await start();
    const ada = await watcher(app);
    await ada.subscribe();
    await write(app, (db) =>
      db.projectMember.create({ data: { projectId: board.p2, userId: board.cy, role: "Public" } }),
    );
    await ada.scopes.settle();
    expect(ada.deltas()).toEqual([]);
  });

  it("reads nothing for a role change that keeps the link counted, and the junction once for one that does not", async () => {
    const app = await start();
    const ada = await watcher(app);
    await ada.subscribe();
    const junctionReads = () => reads.filter((read) => read.model === "projectMember");
    const setRole = (role: string) =>
      write(app, (db) =>
        db.projectMember.updateMany({
          where: { projectId: board.p1, userId: board.cy },
          data: { role },
        }),
      );
    reads.length = 0;
    await setRole("Moderate");
    await ada.scopes.settle();
    expect(junctionReads()).toEqual([]);
    expect(ada.deltas()).toEqual([]);
    await setRole("Public");
    await ada.scopes.settle();
    expect(junctionReads()).toHaveLength(1);
    expect(ada.deltas()).toEqual([[{ t: "removed", id: board.p1 }]]);
  });
});

describe("a demotion the write does not carry whole", () => {
  /** cy's membership of P1. */
  const membership = () =>
    h.prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: board.p1, userId: board.cy } },
    });

  it.each([
    [
      "a batch transaction, which reports no values",
      async (app: App) => {
        await write(app, (db) =>
          db.$transaction([
            db.projectMember.updateMany({
              where: { projectId: board.p1, userId: board.cy },
              data: { role: "Public" },
            }),
          ]),
        );
      },
    ],
    [
      "an untracked write and a touch of the row",
      async (app: App) => {
        const { id } = await membership();
        await h.prisma.projectMember.update({ where: { id }, data: { role: "Public" } });
        await app.as(as(board.ada)).directoryService.touchMember({ id });
      },
    ],
    [
      "the row deleted and created again with its id in one unit",
      async (app: App) => {
        const row = await membership();
        await write(app, async (db) => {
          await db.projectMember.delete({ where: { id: row.id } });
          await db.projectMember.create({ data: { ...row, role: "Public" } });
        });
      },
    ],
  ])("removes the project from the list: %s", async (_name, demote) => {
    const app = await start();
    const ada = await watcher(app);
    expect(await ada.subscribe()).toMatchObject({ ok: true, items: [{ id: board.p1 }] });
    await demote(app);
    await ada.scopes.settle();
    expect(ada.deltas()).toEqual([[{ t: "removed", id: board.p1 }]]);
  });

  it("removes it from the member's own list once, when the row is created again", async () => {
    const app = await start();
    const connection = await app.connect(as(board.cy));
    const scopes = receiveScopes(connection);
    const request = { s: "myProjectsService", c: "mine", scope: board.cy };
    expect(await emitWithAck(connection.socket, "qd:col:sub", request)).toMatchObject({
      ok: true,
      items: [{ id: board.p1 }],
    });
    const row = await membership();
    await write(app, async (db) => {
      await db.projectMember.delete({ where: { id: row.id } });
      await db.projectMember.create({ data: { ...row, role: "Public" } });
    });
    await scopes.settle();
    const deltas = scopes.frames.flatMap((frame: CollectionFrame) => frame.deltas);
    expect(deltas).toEqual([{ t: "removed", id: board.p1 }]);
  });
});
