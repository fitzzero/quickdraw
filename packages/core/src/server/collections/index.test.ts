// The collection index (RFC 0003 section 7.4) through a real server against
// PGlite: the first page of an indexed scope carries one index row per
// member in order, beyond the page; `added` deltas carry index rows and
// `patched` and `updated` deltas the changed index fields, so a client that
// applies the deltas holds the index a fresh snapshot returns; a scope above
// the cap says `indexTruncated`; and what each read costs.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { inCluster } from "../../../test/cluster/mode";
import type { PrismaClient } from "../../../test/prisma/setup";
import type { CollectionFrame, WireIndexRow } from "../../index";
import type { Logger } from "../../contract/logger";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, type TestApp } from "../../testing/index";
import { as, seedBoard, type Board } from "../access/__tests__/board";
import { projectService } from "../emit/__tests__/live";
import type { Principal, StorageAdapter } from "../index";
import { createRegistry } from "../registry";
import {
  addTasks,
  BOARD_INDEX,
  colSub,
  defineTaskService,
  labelService,
  receiveScopes,
  type TaskServiceOptions,
} from "./__tests__/fixture";
import { bindCollections } from "./bind";
import { INDEX_MAX_ROWS, readIndex } from "./index";

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

/** A storage adapter that counts the reads (statements) the framework makes through it. */
function countingStorage(storage: StorageAdapter) {
  const reads: string[] = [];
  const counting: StorageAdapter = Object.freeze({
    ...storage,
    findMany: async (model: string, args?: Parameters<StorageAdapter["findMany"]>[1]) => {
      reads.push(`findMany ${model}`);
      return await storage.findMany(model, args);
    },
    count: async (model: string, args?: Parameters<StorageAdapter["count"]>[1]) => {
      reads.push(`count ${model}`);
      return await storage.count(model, args);
    },
  });
  return { storage: counting, reads };
}

async function start(options: TaskServiceOptions & { readonly logger?: Logger } = {}) {
  const counted = countingStorage(h.storage);
  const app = await createTestApp({
    services: [projectService, labelService, defineTaskService(options)],
    db: h.db,
    storage: counted.storage,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  apps.push(app as unknown as TestApp);
  return { app, reads: counted.reads };
}

type App = Awaited<ReturnType<typeof start>>["app"];

async function connect(app: App, principal: Principal) {
  const connection = await app.connect(principal);
  return { connection, scopes: receiveScopes(connection) };
}

function write<T>(app: App, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  return app.server.dispatcher.run(async () => await fn(h.db));
}

/**
 * The time a task's `updatedAt` holds, as an index row's `rev` with
 * `versionColumn: "updatedAt"`: in microseconds, as revisions are.
 */
async function versionOf(id: string): Promise<number> {
  const task = await h.prisma.task.findUniqueOrThrow({ where: { id } });
  return task.updatedAt.getTime() * 1000;
}

/** The board's order: ordinal, then id. */
function byOrder(a: WireIndexRow, b: WireIndexRow): number {
  const [aId, , , aOrdinal] = a;
  const [bId, , , bOrdinal] = b;
  if (aOrdinal !== bOrdinal) {
    return (aOrdinal as number) - (bOrdinal as number);
  }
  return aId < bId ? -1 : 1;
}

type Values = Readonly<Record<string, unknown>>;

/**
 * A client's index after `frames`, applied as RFC 0003 section 7.4 and
 * `envelope.ts` describe: `added` puts its index row, `patched` and
 * `updated` set the index fields they carry and the frame's `rev`,
 * `removed` drops the row; then the rows are placed in the board's order.
 */
function applyFrames(index: readonly WireIndexRow[], frames: readonly CollectionFrame[]) {
  const rows = new Map<string, WireIndexRow>(index.map((row) => [row[0], row]));
  const fieldsFrom = (row: WireIndexRow | undefined, values: Values): unknown[] =>
    BOARD_INDEX.map((field, position) =>
      Object.hasOwn(values, field) ? values[field] : row?.[position + 2],
    );
  for (const frame of frames) {
    for (const delta of frame.deltas) {
      if (delta.t === "added" && delta.index !== undefined) {
        rows.set(delta.index[0], delta.index);
      } else if (delta.t === "removed") {
        rows.delete(delta.id);
      } else if (delta.t === "patched") {
        const row = rows.get(delta.id);
        rows.set(delta.id, [delta.id, frame.rev, ...fieldsFrom(row, delta.d as Values)]);
      } else if (delta.t === "updated") {
        const item = delta.item as Values & { readonly id: string };
        rows.set(item.id, [item.id, frame.rev, ...fieldsFrom(rows.get(item.id), item)]);
      } else {
        throw new Error(`a delta the test did not expect: ${JSON.stringify(delta)}`);
      }
    }
  }
  return [...rows.values()].sort(byOrder);
}

function withoutRev(rows: readonly WireIndexRow[]): unknown[][] {
  return rows.map(([id, , ...fields]) => [id, ...fields]);
}

describe("the first page of an indexed scope", () => {
  it("carries one index row per member, in order, beyond the page of 10 items", async () => {
    const { app } = await start({ versionColumn: "updatedAt" });
    const ordinals = [7, 3, 15, 1, 12, 9, 4, 14, 2, 11, 6, 13, 5, 10, 8];
    await addTasks(h.prisma, board.p1, ordinals);
    await h.prisma.task.update({
      where: { id: board.t1 },
      data: { status: "done", assigneeId: board.bo },
    });
    const { connection } = await connect(app, as(board.ada));
    const page = await colSub(connection, "board", board.p1);
    expect(page).toMatchObject({ ok: true, total: 16, limit: 10, cursor: expect.any(String) });
    expect(page.items as unknown[]).toHaveLength(10);
    const index = page.index as WireIndexRow[];
    expect(index).toHaveLength(16);
    expect(index.map(([, , , ordinal]) => ordinal)).toEqual([...Array(16).keys()]);
    expect(index[0]).toEqual([board.t1, await versionOf(board.t1), "done", 0, board.bo]);
    expect(index.slice(1).map(([, , status, , assignee]) => [status, assignee])).toEqual(
      Array.from({ length: 15 }, () => ["open", null]),
    );
    // The page is the first 10 members of the index, in the same order.
    expect((page.items as { id: string }[]).map(({ id }) => id)).toEqual(
      index.slice(0, 10).map(([id]) => id),
    );
    expect(page).not.toHaveProperty("indexTruncated");
  });

  it("gives every row the snapshot's revision without a versionColumn", async () => {
    const { app } = await start();
    await addTasks(h.prisma, board.p1, [1, 2]);
    const { connection } = await connect(app, as(board.ada));
    const page = await colSub(connection, "board", board.p1);
    const revs = (page.index as WireIndexRow[]).map(([, rev]) => rev);
    expect(revs).toEqual([page.rev, page.rev, page.rev]);
  });

  it("is left out of a page read with a cursor, and of a collection without an index", async () => {
    const { app } = await start();
    await addTasks(
      h.prisma,
      board.p1,
      Array.from({ length: 11 }, (_, index) => index + 1),
    );
    const { connection } = await connect(app, as(board.ada));
    const first = await colSub(connection, "board", board.p1);
    const next = await colSub(connection, "board", board.p1, { cursor: first.cursor as string });
    expect(next).toMatchObject({ ok: true, items: [{ ordinal: 10 }, { ordinal: 11 }] });
    expect(next).not.toHaveProperty("index");
    expect(await colSub(connection, "byProject", board.p1)).not.toHaveProperty("index");
  });

  it("is sent again with the page a resume falls back to", async () => {
    const { app } = await start();
    const { connection } = await connect(app, as(board.ada));
    const first = await colSub(connection, "board", board.p1);
    const old = await colSub(connection, "board", board.p1, {
      since: (first.rev as number) - 600_000_000,
    });
    expect(old).not.toHaveProperty("resumed");
    expect(old.index).toEqual([[board.t1, old.rev, "open", 0, null]]);
  });

  it("takes a mapped item's index fields from its map", async () => {
    const { app } = await start();
    await h.prisma.task.update({ where: { id: board.t1 }, data: { status: "done" } });
    const { connection } = await connect(app, as(board.ada));
    const page = await colSub(connection, "labelBoard", board.p1);
    expect(page.index).toEqual([[board.t1, page.rev, "done: T1"]]);
  });

  it("is an empty index for a scope without members", async () => {
    const { app } = await start();
    await h.prisma.task.delete({ where: { id: board.t1 } });
    const { connection } = await connect(app, as(board.ada));
    expect(await colSub(connection, "board", board.p1)).toMatchObject({
      items: [],
      total: 0,
      index: [],
    });
  });

  it("costs one statement beside the page and the count", async () => {
    const { app, reads } = await start();
    await addTasks(h.prisma, board.p1, [1, 2, 3]);
    const { connection } = await connect(app, as(board.ada));
    // Warm the anchor's access lookups, which are not the snapshot's.
    await colSub(connection, "byProject", board.p1);
    reads.length = 0;
    await colSub(connection, "byProject", board.p1);
    const unindexed = reads.filter((read) => read.endsWith(" task")).length;
    reads.length = 0;
    await colSub(connection, "board", board.p1);
    expect(reads.filter((read) => read.endsWith(" task")).sort()).toEqual([
      "count task",
      "findMany task",
      "findMany task",
    ]);
    expect(unindexed).toBe(2);
  });
});

describe("the cap", () => {
  it(`says indexTruncated and sends no index above ${INDEX_MAX_ROWS} members`, async () => {
    const { app } = await start();
    await h.prisma.$executeRawUnsafe(
      `INSERT INTO "Task" ("id", "projectId", "title", "ordinal", "updatedAt")
       SELECT 'bulk' || g, $1, 'Bulk ' || g, g, CURRENT_TIMESTAMP
       FROM generate_series(1, ${INDEX_MAX_ROWS}) AS g`,
      board.p2,
    );
    const { connection } = await connect(app, as(board.ed));
    const page = await colSub(connection, "board", board.p2);
    expect(page).toMatchObject({ ok: true, total: INDEX_MAX_ROWS + 1, indexTruncated: true });
    expect(page).not.toHaveProperty("index");
    expect(page.items as unknown[]).toHaveLength(10);
  }, 60_000);

  it("holds a scope of exactly the cap, and truncates one more", async () => {
    await addTasks(h.prisma, board.p1, [1, 2, 3]);
    const services = [projectService, labelService, defineTaskService()];
    const collection = bindCollections(createRegistry(services), h.storage).find(
      "taskService",
      "board",
    );
    if (collection === undefined) {
      throw new Error("the board collection is not bound");
    }
    const members = { projectId: board.p1 };
    const four = await readIndex(h.storage, collection, members, new Set(), 7, 4);
    expect(four).toMatchObject({ index: [[board.t1, 7, "open", 0, null], {}, {}, {}] });
    expect(await readIndex(h.storage, collection, members, new Set(), 7, 3)).toEqual({
      indexTruncated: true,
    });
  });
});

describe("index rows after a flush", () => {
  it("come with an added row, built from its item; patched and updated carry the changed index fields", async () => {
    const { app } = await start({ versionColumn: "updatedAt" });
    const { connection, scopes } = await connect(app, as(board.ada));
    await colSub(connection, "board", board.p1);
    const created = await write(app, (db) =>
      db.task.create({ data: { projectId: board.p1, title: "New", ordinal: 4 } }),
    );
    await write(app, (db) =>
      db.task.update({ where: { id: created.id }, data: { status: "doing" } }),
    );
    await write(app, (db) =>
      db.task.update({ where: { id: created.id }, data: { notes: "outside the item" } }),
    );
    await scopes.settle();
    const updatedAt = new Date((await versionOf(created.id)) / 1000).toISOString();
    expect(scopes.frames.map(({ deltas }) => deltas)).toEqual([
      [
        {
          t: "added",
          item: {
            id: created.id,
            projectId: board.p1,
            title: "New",
            status: "open",
            ordinal: 4,
            assigneeId: null,
            updatedAt: created.updatedAt.toISOString(),
          },
          index: [created.id, created.updatedAt.getTime() * 1000, "open", 4, null],
        },
      ],
      [
        // Behind a cluster adapter a change in place goes out whole.
        inCluster()
          ? { t: "updated", item: expect.objectContaining({ id: created.id, status: "doing" }) }
          : { t: "patched", id: created.id, d: { status: "doing", updatedAt: expect.any(String) } },
      ],
      [
        {
          t: "updated",
          item: expect.objectContaining({ id: created.id, status: "doing", updatedAt }),
        },
      ],
    ]);
  });

  it("are applied by a client into the index a fresh snapshot returns", async () => {
    const { app } = await start({ versionColumn: "updatedAt" });
    const [a = "", b = "", c = ""] = await addTasks(h.prisma, board.p1, [1, 2, 3]);
    const [d = ""] = await addTasks(h.prisma, board.p2, [5]);
    const { connection, scopes } = await connect(app, as(board.ada));
    const first = await colSub(connection, "board", board.p1);
    const touch = h.storage.unitOfWork.touch;
    const created = await write(app, (db) =>
      db.task.create({ data: { projectId: board.p1, title: "E", ordinal: 4 } }),
    );
    await write(app, (db) => db.task.update({ where: { id: a }, data: { status: "done" } }));
    await write(app, (db) => db.task.update({ where: { id: b }, data: { ordinal: 10 } }));
    await write(app, (db) => db.task.update({ where: { id: c }, data: { projectId: board.p2 } }));
    await write(app, (db) => db.task.update({ where: { id: d }, data: { projectId: board.p1 } }));
    await write(app, (db) => db.task.delete({ where: { id: board.t1 } }));
    await write(app, (db) =>
      db.task.update({ where: { id: created.id }, data: { assigneeId: board.bo } }),
    );
    await write(app, (db) => db.task.update({ where: { id: a }, data: { notes: "n" } }));
    await write(app, () => Promise.resolve(touch?.("task", [b])));
    await write(app, (db) =>
      db.task.create({ data: { projectId: board.p1, parentTaskId: a, title: "Child" } }),
    );
    await write(app, async (db) => {
      const made = await db.task.create({ data: { projectId: board.p1, title: "F", ordinal: 6 } });
      await db.task.update({ where: { id: made.id }, data: { status: "doing", ordinal: 7 } });
    });
    await scopes.settle();
    const kinds = [
      "added",
      "patched",
      "patched",
      "removed",
      "added",
      "removed",
      "patched",
      "updated",
      "added",
      "added",
      "updated",
      "added",
    ];
    // Behind a cluster adapter a change in place goes out whole: the index ends the same.
    expect(scopes.frames.flatMap(({ deltas }) => deltas.map(({ t }) => t))).toEqual(
      inCluster() ? kinds.map((t) => (t === "patched" ? "updated" : t)) : kinds,
    );
    const held = applyFrames(first.index as WireIndexRow[], scopes.frames);
    const fresh = (await colSub(connection, "board", board.p1)).index as WireIndexRow[];
    expect(withoutRev(held)).toEqual(withoutRev(fresh));
    expect(fresh).toHaveLength(6);
    // A row's rev: the row's version where an added row carried it, else the
    // revision of the frame that changed it, which is never older.
    for (const [position, [id, rev]] of fresh.entries()) {
      const kept = held[position]?.[1] ?? 0;
      expect(kept, id).toBeGreaterThanOrEqual(rev);
    }
    const added = new Set(
      scopes.frames.flatMap(({ deltas }) =>
        deltas.flatMap((delta) => (delta.t === "added" ? [delta.index?.[0]] : [])),
      ),
    );
    const changedLater = new Set(
      scopes.frames.flatMap(({ deltas }) =>
        deltas.flatMap((delta) =>
          delta.t === "patched"
            ? [delta.id]
            : delta.t === "updated"
              ? [(delta.item as Values).id]
              : [],
        ),
      ),
    );
    for (const [position, [id, rev]] of fresh.entries()) {
      if (added.has(id) && !changedLater.has(id)) {
        expect(held[position]?.[1], id).toBe(rev);
      }
    }
  });

  it("sends a resumed client the index rows of the rows added while it was away", async () => {
    const { app } = await start();
    const watcher = await connect(app, as(board.ada));
    await colSub(watcher.connection, "board", board.p1);
    const away = await connect(app, as(board.ada));
    const first = await colSub(away.connection, "board", board.p1);
    const created = await write(app, (db) =>
      db.task.create({ data: { projectId: board.p1, title: "While away", ordinal: 3 } }),
    );
    const resumed = await colSub(away.connection, "board", board.p1, {
      since: first.rev as number,
    });
    const row = [created.id, expect.any(Number), "open", 3, null];
    // Behind a cluster adapter a resume reads a page: a process's buffer sees its own flushes only.
    expect(resumed).toMatchObject(
      inCluster()
        ? { index: expect.arrayContaining([row]) as unknown }
        : { resumed: true, deltas: [{ t: "added", index: row }] },
    );
  });
});

describe("a crafted cursor", () => {
  it("whose values do not fit the order columns is VALIDATION, not a logged INTERNAL", async () => {
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
    const { app } = await start({ logger });
    const { connection } = await connect(app, as(board.ada));
    const crafted = (values: unknown[]) =>
      Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
    for (const values of [
      ["three", board.t1],
      [1e30, board.t1],
      [{ $date: "2026-01-01T00:00:00.000Z" }, board.t1],
      [{ $bigint: "1" }, board.t1],
      [true, board.t1],
      [1, 42],
    ]) {
      expect(
        await colSub(connection, "byProject", board.p1, { cursor: crafted(values) }),
        JSON.stringify(values),
      ).toMatchObject({
        ok: false,
        e: { code: "VALIDATION", data: { issues: [{ path: ["cursor"] }] } },
      });
    }
    expect(errors).toEqual([]);
  });
});
