// Collections (RFC 0003 section 7) through a real server against PGlite:
// subscribing to a scope and paging it, and the deltas raw tracked writes
// produce, asserting the exact replies and frames real socket clients
// receive. The delta cases port 4.1's (`legacy-src/server/collections.test.ts:274-367`),
// driven by tracked writes instead of `BaseService.create/update/delete`.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PrismaClient } from "../../../test/prisma/setup";
import { collectionRoom } from "../../index";
import type { Logger } from "../../contract/logger";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { as, seedBoard, type Board } from "../access/__tests__/board";
import { projectService, recordingStorage, type Read } from "../emit/__tests__/live";
import type { FlushSink, Principal } from "../index";
import {
  addTasks,
  CARD_KEYS,
  colSub,
  colUnsub,
  defineTaskService,
  labelService,
  receiveScopes,
} from "./__tests__/fixture";

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

interface StartOptions {
  readonly bulkThreshold?: number;
  readonly flushSink?: FlushSink;
  readonly logger?: Logger;
}

async function start(options: StartOptions = {}) {
  const recorded = recordingStorage(h.storage);
  const app = await createTestApp({
    services: [
      projectService,
      labelService,
      defineTaskService({ bulkThreshold: options.bulkThreshold }),
    ],
    db: h.db,
    storage: recorded.storage,
    ...(options.flushSink === undefined ? {} : { flushSink: options.flushSink }),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  apps.push(app as unknown as TestApp);
  return { app, reads: recorded.reads };
}

type App = Awaited<ReturnType<typeof start>>["app"];

async function connect(app: App, principal: Principal) {
  const connection = await app.connect(principal);
  return { connection, scopes: receiveScopes(connection) };
}

/** Runs `fn` in a unit of work of the app's dispatcher: its tracked writes flush to the sinks. */
function write<T>(app: App, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  return app.server.dispatcher.run(async () => await fn(h.db));
}

/** How many sockets are in a scope's room. */
function inRoom(app: App, collection: string, scope: string): number {
  const room = collectionRoom("taskService", collection, scope);
  return app.server.io.sockets.adapter.rooms.get(room)?.size ?? 0;
}

/** Reads of task rows with an item's select: a page, or a flush's items. */
function itemReads(reads: readonly Read[]): Read[] {
  return reads.filter(
    (read) =>
      read.model === "task" &&
      typeof read.args.select === "object" &&
      read.args.select !== null &&
      "title" in read.args.select,
  );
}

function card(id: string, projectId: string, title: string, ordinal = 0, status = "open") {
  return { id, projectId, title, status, ordinal };
}

describe("qd:col:sub", () => {
  it("answers the first page in order, with the total, the next cursor and the revision, and joins", async () => {
    const { app } = await start();
    const [one, two] = await addTasks(h.prisma, board.p1, [1, 2, 3]);
    const { connection } = await connect(app, as(board.ada));
    const page = await colSub(connection, "byProject", board.p1, { limit: 2 });
    expect(page).toEqual({
      ok: true,
      rev: expect.any(Number),
      items: [card(board.t1, board.p1, "T1"), card(one ?? "", board.p1, "Task 1", 1)],
      total: 4,
      cursor: expect.any(String),
      limit: 2,
    });
    expect(Object.keys((page.items as object[])[0] ?? {})).toEqual(CARD_KEYS);
    expect(inRoom(app, "byProject", board.p1)).toBe(1);
    const next = await colSub(connection, "byProject", board.p1, {
      cursor: page.cursor as string,
      limit: 2,
    });
    expect(next).toMatchObject({ items: [{ ordinal: 2 }, { ordinal: 3 }], cursor: null });
    expect((next.items as { id: string }[])[0]?.id).toBe(two);
  });

  it("pages with a cursor without joining the scope's room", async () => {
    const { app } = await start();
    await addTasks(h.prisma, board.p1, [1, 2]);
    const reader = await connect(app, as(board.ada));
    const first = await colSub(reader.connection, "byProject", board.p1, { limit: 1 });
    const pager = await connect(app, as(board.ada));
    const page = await colSub(pager.connection, "byProject", board.p1, {
      cursor: first.cursor as string,
      limit: 1,
    });
    expect(page).toMatchObject({ ok: true, items: [{ ordinal: 1 }], limit: 1 });
    expect(inRoom(app, "byProject", board.p1)).toBe(1);
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { title: "Seen" } }));
    await Promise.all([reader.scopes.settle(), pager.scopes.settle()]);
    expect(reader.scopes.frames).toHaveLength(1);
    expect(pager.scopes.frames).toEqual([]);
  });

  it("clamps a page above maxLimit and says so, and uses the collection's limit when none is asked", async () => {
    const { app } = await start();
    await addTasks(h.prisma, board.p1, [1, 2, 3, 4]);
    const { connection } = await connect(app, as(board.ada));
    expect(await colSub(connection, "openByProject", board.p1)).toMatchObject({
      limit: 2,
      items: [{}, {}],
    });
    expect(await colSub(connection, "openByProject", board.p1)).not.toHaveProperty("clamped");
    expect(await colSub(connection, "openByProject", board.p1, { limit: 5 })).toMatchObject({
      limit: 3,
      clamped: true,
      items: [{}, {}, {}],
      total: 5,
    });
    expect(await colSub(connection, "byProject", board.p1, { limit: 9999 })).toMatchObject({
      limit: 500,
      clamped: true,
      total: 5,
    });
  });

  it("counts only the rows its where matches", async () => {
    const { app } = await start();
    await addTasks(h.prisma, board.p1, [1, 2], { status: "done" });
    const { connection } = await connect(app, as(board.ada));
    expect(await colSub(connection, "openByProject", board.p1)).toMatchObject({
      items: [{ id: board.t1 }],
      total: 1,
      cursor: null,
    });
  });

  it("keeps a cursor on its row when rows are inserted before it", async () => {
    const { app } = await start();
    const [, , three, four] = await addTasks(h.prisma, board.p1, [1, 2, 3, 4]);
    const { connection } = await connect(app, as(board.ada));
    const first = await colSub(connection, "byProject", board.p1, { limit: 3 });
    expect((first.items as { ordinal: number }[]).map(({ ordinal }) => ordinal)).toEqual([0, 1, 2]);
    await addTasks(h.prisma, board.p1, [0, 1, -5]);
    const next = await colSub(connection, "byProject", board.p1, {
      cursor: first.cursor as string,
      limit: 3,
    });
    expect((next.items as { id: string }[]).map(({ id }) => id)).toEqual([three, four]);
    expect(next).toMatchObject({ total: 8, cursor: null });
  });

  it("pages a column that may hold null with its nulls last, every member once", async () => {
    const { app } = await start();
    const [a, b] = await addTasks(h.prisma, board.p1, [1, 2]);
    const [c] = await addTasks(h.prisma, board.p1, [3]);
    await h.prisma.task.updateMany({
      where: { id: { in: [a ?? "", b ?? ""] } },
      data: { parentTaskId: board.t1 },
    });
    const { connection } = await connect(app, as(board.ada));
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 6; page += 1) {
      const reply = await colSub(connection, "byParent", board.p1, {
        limit: 1,
        ...(cursor === undefined ? {} : { cursor }),
      });
      seen.push(...(reply.items as { id: string }[]).map(({ id }) => id));
      if (reply.cursor === null) {
        break;
      }
      cursor = reply.cursor as string;
    }
    const parented = [a ?? "", b ?? ""].sort();
    const orphans = [board.t1, c ?? ""].sort();
    expect(seen).toEqual([...parented, ...orphans]);
  });

  it("answers a via scope from its junction's links", async () => {
    const { app } = await start();
    const [other] = await addTasks(h.prisma, board.p1, [1]);
    const label = await h.prisma.label.create({ data: { projectId: board.p1, name: "Bug" } });
    const empty = await h.prisma.label.create({ data: { projectId: board.p1, name: "Idea" } });
    await h.prisma.taskLabel.createMany({
      data: [
        { taskId: board.t1, labelId: label.id },
        { taskId: other ?? "", labelId: label.id },
      ],
    });
    const { connection } = await connect(app, as(board.cy));
    const page = await colSub(connection, "byLabel", label.id);
    expect((page.items as { id: string }[]).map(({ id }) => id)).toEqual(
      [board.t1, other ?? ""].sort(),
    );
    expect(page).toMatchObject({ total: 2, cursor: null });
    expect(await colSub(connection, "byLabel", empty.id)).toMatchObject({
      items: [],
      total: 0,
      cursor: null,
    });
  });

  it("authorizes the scope through its anchor's policy, without the anchor service's grants", async () => {
    const { app } = await start();
    const forbidden = { ok: false, e: { code: "FORBIDDEN", message: "Insufficient permissions" } };
    const outsider = await connect(app, as(board.ed));
    expect(await colSub(outsider.connection, "byProject", board.p1)).toEqual(forbidden);
    const owner = await connect(app, as(board.ada));
    expect(await colSub(owner.connection, "byProject", "missing")).toEqual(forbidden);
    const listed = await connect(app, as(board.di));
    expect(await colSub(listed.connection, "byProject", board.p1)).toMatchObject({ ok: true });
    const projectAdmin = await connect(app, as(board.ed, { projectService: "Admin" }));
    expect(await colSub(projectAdmin.connection, "byProject", board.p1)).toEqual(forbidden);
    expect(inRoom(app, "byProject", board.p1)).toBe(1);
  });

  it("lets a service-wide Admin grant on the collection's service through, even for a missing anchor row", async () => {
    const { app } = await start();
    const admin = await connect(app, as(board.ed, { taskService: "Admin" }));
    expect(await colSub(admin.connection, "byProject", board.p1)).toMatchObject({
      ok: true,
      total: 1,
    });
    expect(await colSub(admin.connection, "byProject", "missing")).toMatchObject({
      ok: true,
      items: [],
      total: 0,
    });
  });

  it("answers a self scope for the subscriber's own user id only", async () => {
    const { app } = await start();
    const [mine] = await addTasks(h.prisma, board.p2, [4], { assigneeId: board.ada });
    const { connection } = await connect(app, as(board.ada));
    expect(await colSub(connection, "mine", board.ada)).toMatchObject({
      ok: true,
      items: [{ id: mine }],
      total: 1,
    });
    expect(await colSub(connection, "mine", board.bo)).toMatchObject({
      ok: false,
      e: { code: "FORBIDDEN" },
    });
  });

  it("refuses an unknown collection or service as NOT_FOUND, an anonymous socket, and malformed frames", async () => {
    const { app } = await start();
    const { connection } = await connect(app, as(board.ada));
    expect(await colSub(connection, "nope", board.p1)).toEqual({
      ok: false,
      e: { code: "NOT_FOUND", message: 'taskService has no collection "nope"' },
    });
    expect(
      await emitWithAck(connection.socket, "qd:col:sub", { s: "nothing", c: "x", scope: "y" }),
    ).toMatchObject({ ok: false, e: { code: "NOT_FOUND" } });
    const anonymous = await app.connect(null);
    expect(await colSub(anonymous, "byProject", board.p1)).toMatchObject({
      ok: false,
      e: { code: "UNAUTHENTICATED" },
    });
    const refusal = (path: string) => ({
      ok: false,
      e: { code: "VALIDATION", data: { issues: [{ path: path === "" ? [] : [path] }] } },
    });
    expect(
      await emitWithAck(connection.socket, "qd:col:sub", { s: "taskService", c: "byProject" }),
    ).toMatchObject(refusal(""));
    expect(await colSub(connection, "byProject", board.p1, { limit: 0 })).toMatchObject(
      refusal("limit"),
    );
    expect(
      await colSub(connection, "byProject", board.p1, { since: 1, cursor: "x" }),
    ).toMatchObject(refusal("cursor"));
    expect(await colSub(connection, "byProject", board.p1, { cursor: "garbage" })).toMatchObject(
      refusal("cursor"),
    );
    expect(inRoom(app, "byProject", board.p1)).toBe(0);
  });

  it("sends items the same for everyone in the scope: no field above the collection's level", async () => {
    const { app } = await start();
    await h.prisma.task.update({ where: { id: board.t1 }, data: { notes: "secret" } });
    const { connection } = await connect(app, as(board.ada));
    const page = await colSub(connection, "rows", board.p1);
    expect(page).toMatchObject({ items: [{ id: board.t1, title: "T1" }] });
    expect((page.items as object[])[0]).not.toHaveProperty("notes");
  });
});

describe("deltas after a flush", () => {
  it("sends a created row as added, with the full item", async () => {
    const { app } = await start();
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "byProject", board.p1);
    const created = await write(app, (db) =>
      db.task.create({ data: { projectId: board.p1, title: "Delta", ordinal: 5 } }),
    );
    await scopes.settle();
    expect(scopes.frames).toEqual([
      {
        s: "taskService",
        c: "byProject",
        scope: board.p1,
        rev: expect.any(Number),
        deltas: [{ t: "added", item: card(created.id, board.p1, "Delta", 5) }],
      },
    ]);
  });

  it("sends an update in place as a patch of the changed item fields, and a change outside the item whole", async () => {
    const { app } = await start();
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "byProject", board.p1);
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { title: "Prime" } }));
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { notes: "n" } }));
    await scopes.settle();
    expect(scopes.frames.map(({ deltas }) => deltas)).toEqual([
      [{ t: "patched", id: board.t1, d: { title: "Prime" } }],
      [{ t: "updated", item: card(board.t1, board.p1, "Prime") }],
    ]);
  });

  it("sends a change to a mapped item whole", async () => {
    const { app } = await start();
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "labelled", board.p1);
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { status: "done" } }));
    await scopes.settle();
    expect(scopes.frames.map(({ deltas }) => deltas)).toEqual([
      [{ t: "updated", item: { id: board.t1, label: "done: T1" } }],
    ]);
  });

  it("moves a row between scopes as removed from the old one and added to the new one", async () => {
    const { app } = await start();
    const left = await connect(app, as(board.ada));
    const entered = await connect(app, as(board.ed));
    await colSub(left.connection, "byProject", board.p1);
    await colSub(entered.connection, "byProject", board.p2);
    await write(app, (db) =>
      db.task.update({ where: { id: board.t1 }, data: { projectId: board.p2 } }),
    );
    await Promise.all([left.scopes.settle(), entered.scopes.settle()]);
    expect(left.scopes.frames).toEqual([
      expect.objectContaining({ scope: board.p1, deltas: [{ t: "removed", id: board.t1 }] }),
    ]);
    expect(entered.scopes.frames).toEqual([
      expect.objectContaining({
        scope: board.p2,
        deltas: [{ t: "added", item: card(board.t1, board.p2, "T1") }],
      }),
    ]);
  });

  it("moves a row deleted and created again in one unit: removed where it was, added where it is", async () => {
    const { app } = await start();
    const left = await connect(app, as(board.ada));
    const entered = await connect(app, as(board.ed));
    await colSub(left.connection, "byProject", board.p1);
    await colSub(entered.connection, "byProject", board.p2);
    // The merged write is a create that keeps the deleted row's values as before.
    await write(app, async (db) => {
      const old = await db.task.delete({ where: { id: board.t1 } });
      await db.task.create({ data: { id: old.id, projectId: board.p2, title: "Now in P2" } });
    });
    await Promise.all([left.scopes.settle(), entered.scopes.settle()]);
    expect(left.scopes.frames).toEqual([
      expect.objectContaining({ scope: board.p1, deltas: [{ t: "removed", id: board.t1 }] }),
    ]);
    expect(entered.scopes.frames).toEqual([
      expect.objectContaining({
        scope: board.p2,
        deltas: [{ t: "added", item: card(board.t1, board.p2, "Now in P2") }],
      }),
    ]);
    left.scopes.clear();
    entered.scopes.clear();
    await write(app, async (db) => {
      await db.task.delete({ where: { id: board.t2 } });
      await db.task.create({ data: { id: board.t2, projectId: board.p1, title: "Back" } });
    });
    await Promise.all([left.scopes.settle(), entered.scopes.settle()]);
    expect(left.scopes.frames.map(({ deltas }) => deltas)).toEqual([
      [{ t: "added", item: card(board.t2, board.p1, "Back") }],
    ]);
    expect(entered.scopes.frames.map(({ deltas }) => deltas)).toEqual([
      [{ t: "removed", id: board.t2 }],
    ]);
    // Created again in the same scope, it is sent whole in place.
    left.scopes.clear();
    await write(app, async (db) => {
      await db.task.delete({ where: { id: board.t2 } });
      await db.task.create({ data: { id: board.t2, projectId: board.p1, title: "Again" } });
    });
    await left.scopes.settle();
    expect(left.scopes.frames.map(({ deltas }) => deltas)).toEqual([
      [{ t: "updated", item: card(board.t2, board.p1, "Again") }],
    ]);
  });

  it("removes a row that leaves by where, and adds it back when it enters again", async () => {
    const { app } = await start();
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "openByProject", board.p1);
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { status: "done" } }));
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { status: "open" } }));
    await scopes.settle();
    expect(scopes.frames.map(({ deltas }) => deltas)).toEqual([
      [{ t: "removed", id: board.t1 }],
      [{ t: "added", item: card(board.t1, board.p1, "T1") }],
    ]);
  });

  it("sends a deleted row as removed", async () => {
    const { app } = await start();
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "byProject", board.p1);
    await write(app, (db) => db.task.delete({ where: { id: board.t1 } }));
    await scopes.settle();
    expect(scopes.frames.map(({ deltas }) => deltas)).toEqual([[{ t: "removed", id: board.t1 }]]);
  });

  it("adds and removes a via entry as its junction rows come and go, for that scope only", async () => {
    const { app } = await start();
    const bug = await h.prisma.label.create({ data: { projectId: board.p1, name: "Bug" } });
    const idea = await h.prisma.label.create({ data: { projectId: board.p1, name: "Idea" } });
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "byLabel", bug.id);
    await colSub(connection, "byLabel", idea.id);
    const link = await write(app, (db) =>
      db.taskLabel.create({ data: { taskId: board.t1, labelId: bug.id } }),
    );
    await write(app, (db) =>
      db.task.update({ where: { id: board.t1 }, data: { title: "Linked" } }),
    );
    await write(app, (db) => db.taskLabel.delete({ where: { id: link.id } }));
    await scopes.settle();
    expect(scopes.frames.map(({ scope, deltas }) => ({ scope, deltas }))).toEqual([
      { scope: bug.id, deltas: [{ t: "added", item: card(board.t1, board.p1, "T1") }] },
      { scope: bug.id, deltas: [{ t: "patched", id: board.t1, d: { title: "Linked" } }] },
      { scope: bug.id, deltas: [{ t: "removed", id: board.t1 }] },
    ]);
  });

  it("removes a via entry whose links a cascade deleted from the scopes subscribed here", async () => {
    const { app } = await start();
    const bug = await h.prisma.label.create({ data: { projectId: board.p1, name: "Bug" } });
    await h.prisma.taskLabel.create({ data: { taskId: board.t1, labelId: bug.id } });
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "byLabel", bug.id);
    await write(app, (db) => db.task.delete({ where: { id: board.t1 } }));
    await scopes.settle();
    expect(scopes.frames).toEqual([
      expect.objectContaining({ scope: bug.id, deltas: [{ t: "removed", id: board.t1 }] }),
    ]);
  });

  it("adds a touched row to its scope, and removes a row touched as removed from every subscribed scope", async () => {
    const { app } = await start();
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "byProject", board.p1);
    const touch = h.storage.unitOfWork.touch;
    await write(app, () => Promise.resolve(touch?.("task", [board.t1])));
    await write(app, () => Promise.resolve(touch?.("task", [board.t1], { removed: true })));
    await scopes.settle();
    expect(scopes.frames.map(({ deltas }) => deltas)).toEqual([
      [{ t: "added", item: card(board.t1, board.p1, "T1") }],
      [{ t: "removed", id: board.t1 }],
    ]);
  });

  it("sends a row again, whole, when a write to another row affects it", async () => {
    const { app } = await start();
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "byProject", board.p1);
    const child = await write(app, (db) =>
      db.task.create({ data: { projectId: board.p1, parentTaskId: board.t1, title: "Child" } }),
    );
    await scopes.settle();
    expect(scopes.frames.map(({ deltas }) => deltas)).toEqual([
      [
        { t: "added", item: card(child.id, board.p1, "Child") },
        { t: "updated", item: card(board.t1, board.p1, "T1") },
      ],
    ]);
  });
});

describe("batches, bulk writes and statements", () => {
  it("sends ten writes to one scope in one call as one frame, in write order", async () => {
    const { app } = await start();
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "byProject", board.p1);
    const ids = await write(app, async (db) => {
      const created: string[] = [];
      for (let ordinal = 1; ordinal <= 10; ordinal += 1) {
        const task = await db.task.create({
          data: { projectId: board.p1, title: `Batch ${ordinal}`, ordinal },
        });
        created.push(task.id);
      }
      return created;
    });
    await scopes.settle();
    expect(scopes.frames).toHaveLength(1);
    expect(
      scopes.frames[0]?.deltas.map((delta) => (delta.t === "added" ? delta.item : delta)),
    ).toEqual(ids.map((id, index) => card(id, board.p1, `Batch ${index + 1}`, index + 1)));
  });

  it("sends more than bulkThreshold rows of one scope as one reset, reading no items", async () => {
    const { app, reads } = await start();
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "byProject", board.p1);
    reads.length = 0;
    await write(app, (db) =>
      db.task.createMany({
        data: Array.from({ length: 201 }, (_, index) => ({
          projectId: board.p1,
          title: `Bulk ${index}`,
        })),
      }),
    );
    await scopes.settle();
    expect(scopes.frames).toEqual([
      expect.objectContaining({ scope: board.p1, deltas: [{ t: "reset" }] }),
    ]);
    expect(itemReads(reads)).toEqual([]);
  });

  it("uses the collection's bulkThreshold", async () => {
    const { app } = await start({ bulkThreshold: 2 });
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "byProject", board.p1);
    await colSub(connection, "openByProject", board.p1);
    await write(app, async (db) => {
      await db.task.create({ data: { projectId: board.p1, title: "A" } });
      await db.task.create({ data: { projectId: board.p1, title: "B" } });
      await db.task.create({ data: { projectId: board.p1, title: "C" } });
    });
    await scopes.settle();
    const byCollection = Object.fromEntries(scopes.frames.map(({ c, deltas }) => [c, deltas]));
    expect(byCollection.byProject).toEqual([{ t: "reset" }]);
    expect(byCollection.openByProject).toHaveLength(3);
  });

  it("reads nothing for a scope nobody subscribes to, and one item read for one that has subscribers", async () => {
    const { app, reads } = await start();
    reads.length = 0;
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { title: "Alone" } }));
    expect(reads).toEqual([]);
    const { connection } = await connect(app, as(board.ada));
    await colSub(connection, "byProject", board.p1);
    reads.length = 0;
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { title: "Seen" } }));
    expect(reads).toEqual([
      {
        model: "task",
        args: { where: { id: { in: [board.t1] } }, select: { id: true, title: true } },
      },
    ]);
  });

  it("reads a row's old scope first only when the write sets a membership column", async () => {
    const { app } = await start();
    const count = async (data: Record<string, unknown>) =>
      (
        await h.storage.countStatements(() =>
          write(app, (db) => db.task.update({ where: { id: board.t1 }, data })),
        )
      ).statements;
    expect(await count({ title: "No read" })).toBe(1);
    expect(await count({ ordinal: 7 })).toBe(1);
    expect(await count({ status: "done" })).toBe(2);
    expect(await count({ projectId: board.p2 })).toBe(2);
  });

  it("sends a reset to the touched scopes when a flush sink fails", async () => {
    const failing: FlushSink = { flush: () => Promise.reject(new Error("sink down")) };
    const errors: string[] = [];
    const logger: Logger = {
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: (message) => {
        errors.push(message);
      },
      child: () => logger,
    };
    const { app } = await start({ flushSink: failing, logger });
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "byProject", board.p1);
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { title: "Then" } }));
    await scopes.settle();
    expect(scopes.frames.map(({ deltas }) => deltas)).toEqual([
      [{ t: "patched", id: board.t1, d: { title: "Then" } }],
      [{ t: "reset" }],
    ]);
    expect(errors).toEqual(["A flush sink failed; the response was already sent"]);
  });

  it("sends one scope a reset on dispatcher.collections.reset", async () => {
    const { app } = await start();
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "byProject", board.p1);
    const { taskContract } = await import("./__tests__/fixture");
    app.server.dispatcher.collections.reset(taskContract, "byProject", board.p1);
    await scopes.settle();
    expect(scopes.frames).toEqual([
      {
        s: "taskService",
        c: "byProject",
        scope: board.p1,
        rev: expect.any(Number),
        deltas: [{ t: "reset" }],
      },
    ]);
    expect(() =>
      app.server.dispatcher.collections.reset(taskContract, "nope" as "byProject", board.p1),
    ).toThrow('collections.reset: taskService has no collection "nope" this dispatcher serves');
  });

  it("stops sending after qd:col:unsub", async () => {
    const { app } = await start();
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "byProject", board.p1);
    expect(await colUnsub(connection, "byProject", board.p1)).toEqual({ ok: true });
    await write(app, (db) =>
      db.task.update({ where: { id: board.t1 }, data: { title: "Unseen" } }),
    );
    await scopes.settle();
    expect(scopes.frames).toEqual([]);
    expect(inRoom(app, "byProject", board.p1)).toBe(0);
  });
});
