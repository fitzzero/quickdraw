// Writes that commit in one order and flush in the other, on two nodes (the
// pack H finale review). A flush takes its revision when it flushes: after
// its handler settled, and behind a cluster once the shared counter
// answered, not when its write committed. So a move out of a scope, or a
// delete, can commit first and flush last, with the higher revision, and a
// client applying frames by revision would let it win over a later move back
// in, or a later create of the same id. Behind a cluster adapter each frame
// is decided by its row as read at flush time instead, which every write
// with a lower revision committed before: the client ends at the database's
// state.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applySnapshot } from "../../src/client/live/collectionSnapshot";
import { applyFrames, applyItems } from "../../src/client/live/collectionStore";
import {
  applyEntityFrame,
  applyEntityResult,
  type EntityEntry,
} from "../../src/client/live/entities";
import type { EntityResult } from "../../src/index";
import { createHarness, type Harness } from "../../src/prisma/__tests__/harness";
import { deferred } from "../../src/server/__tests__/fixtures";
import { as, seedBoard, type Board } from "../../src/server/access/__tests__/board";
import {
  addTasks,
  colItems,
  colSub,
  defineTaskService as defineCollectionTasks,
  labelService,
  receiveScopes,
} from "../../src/server/collections/__tests__/fixture";
import {
  defineTaskService,
  projectService,
  receive,
  sub,
} from "../../src/server/emit/__tests__/live";
import type { AnyService } from "../../src/server/index";
import type * as Testing from "../../src/testing/createTestApp";
import { createBarrier, startNode, stopNodes, type ClusterNode, type CreateTestApp } from "./nodes";
import { uniquePrefix } from "./valkey";

// The single-server `createTestApp`: these tests boot each node themselves.
const { createTestApp } = await vi.importActual<typeof Testing>("../../src/testing/createTestApp");

let h: Harness;
let board: Board;
const running: ClusterNode[][] = [];

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
  await Promise.all(running.splice(0).map(stopNodes));
});

async function cluster(services: readonly AnyService[]) {
  const prefix = uniquePrefix("races");
  const options = { services, db: h.db };
  const a = await startNode(createTestApp as CreateTestApp, options, { prefix });
  const b = await startNode(createTestApp as CreateTestApp, options, { prefix });
  running.push([a, b]);
  /** Waits until each node received everything the other published before. */
  const settle = async (): Promise<void> => {
    await createBarrier(b.app.server.io, a.app.server.io)();
    await createBarrier(a.app.server.io, b.app.server.io)();
  };
  return { a, b, settle };
}

/**
 * Runs `write` on `node` in a unit whose handler goes on after it until
 * `release` (an API call, more reads): resolves once the write committed,
 * with the unit's end.
 */
async function writeThenWait(node: ClusterNode, write: () => Promise<unknown>) {
  const committed = deferred();
  const release = deferred();
  const done = node.app.server.dispatcher.run(async () => {
    await write();
    committed.resolve();
    await release.promise;
  });
  await committed.promise;
  return {
    finish: async (): Promise<void> => {
      release.resolve();
      await done;
    },
  };
}

const ORDER = {
  order: [
    ["ordinal", "asc"],
    ["id", "asc"],
  ],
} as never;

describe("a write that commits first and flushes last", () => {
  it("leaves a member in its scope: a move out flushed after the later move back in", async () => {
    const { a, b, settle } = await cluster([projectService, labelService, defineCollectionTasks()]);
    const [moved = ""] = await addTasks(h.prisma, board.p1, [1]);
    const reader = await a.app.connect(as(board.ada));
    const scopes = receiveScopes(reader);
    const page = await colSub(reader, "byProject", board.p1, { limit: 100 });
    // Node B moves the task out of P1, and its handler goes on.
    const out = await writeThenWait(b, () =>
      h.db.task.update({ where: { id: moved }, data: { projectId: board.p2 } }),
    );
    // Node A moves it back in meanwhile, and flushes at once.
    await a.app.server.dispatcher.run(() =>
      h.db.task.update({ where: { id: moved }, data: { projectId: board.p1, title: "Back" } }),
    );
    await out.finish();
    await settle();
    await scopes.settle();
    const frames = scopes.frames.filter((frame) => frame.c === "byProject");
    // The later flush carries the higher revision; it went out as the row stood at its read.
    expect(frames.map((frame) => frame.deltas.map((delta) => delta.t))).toEqual([
      ["added"],
      ["updated"],
    ]);
    const { state } = applyFrames(applySnapshot(null, page as never, ORDER), frames, ORDER);
    expect(state.byId.get(moved)).toMatchObject({ id: moved, title: "Back" });
    const row = await h.prisma.task.findUniqueOrThrow({ where: { id: moved } });
    expect(row.projectId).toBe(board.p1);
  });

  it("leaves a row its subscribers: a delete flushed after a create of the same id", async () => {
    const { a, b, settle } = await cluster([projectService, defineTaskService()]);
    const reader = await a.app.connect(as(board.ada));
    const frames = receive(reader);
    await sub(reader, "taskService", [board.t1]);
    const old = await h.prisma.task.findUniqueOrThrow({ where: { id: board.t1 } });
    const deleting = await writeThenWait(b, () => h.db.task.delete({ where: { id: board.t1 } }));
    await a.app.server.dispatcher.run(() =>
      h.db.task.create({ data: { id: old.id, projectId: old.projectId, title: "Created again" } }),
    );
    await deleting.finish();
    await settle();
    await frames.settle();
    expect(frames.entity.map((frame) => frame.t)).toEqual(["u", "u"]);
    let entry: EntityEntry<unknown> | undefined;
    for (const frame of frames.entity) {
      entry = applyEntityFrame(entry, frame).entry;
    }
    expect(entry).toMatchObject({ removed: false, data: { title: "Created again" } });
    // Node B, whose delete went out whole, knows the row exists again.
    const again = await b.app.connect(as(board.ada));
    const reply = (await sub(again, "taskService", [board.t1])) as { r: EntityResult[] };
    expect(applyEntityResult(entry, reply.r[0] as EntityResult, undefined).entry).toMatchObject({
      data: { title: "Created again" },
    });
  });

  it("keeps a member in its scope: a delete flushed after a create of the same id", async () => {
    const { a, b, settle } = await cluster([projectService, labelService, defineCollectionTasks()]);
    const reader = await a.app.connect(as(board.ada));
    const scopes = receiveScopes(reader);
    const page = await colSub(reader, "byProject", board.p1, { limit: 100 });
    const old = await h.prisma.task.findUniqueOrThrow({ where: { id: board.t1 } });
    const deleting = await writeThenWait(b, () => h.db.task.delete({ where: { id: board.t1 } }));
    await a.app.server.dispatcher.run(() =>
      h.db.task.create({ data: { id: old.id, projectId: old.projectId, title: "Created again" } }),
    );
    await deleting.finish();
    await settle();
    await scopes.settle();
    const frames = scopes.frames.filter((frame) => frame.c === "byProject");
    const { state } = applyFrames(applySnapshot(null, page as never, ORDER), frames, ORDER);
    expect(state.byId.get(board.t1)).toMatchObject({ title: "Created again" });
  });
});

describe("moves in and out of one scope from both nodes at once", () => {
  it("end every subscriber at the database's scope", async () => {
    const { a, b, settle } = await cluster([projectService, labelService, defineCollectionTasks()]);
    const ids = await addTasks(h.prisma, board.p1, [1, 2, 3, 4, 5]);
    const onA = await a.app.connect(as(board.ada));
    const onB = await b.app.connect(as(board.ada));
    const subscribers = [
      {
        connection: onA,
        scopes: receiveScopes(onA),
        page: await colSub(onA, "byProject", board.p1, { limit: 100 }),
      },
      {
        connection: onB,
        scopes: receiveScopes(onB),
        page: await colSub(onB, "byProject", board.p1, { limit: 100 }),
      },
    ];
    const write = (node: ClusterNode, id: string, data: Record<string, unknown>) =>
      node.app.server.dispatcher.run(() => h.db.task.update({ where: { id }, data }));
    for (let round = 0; round < 100; round += 1) {
      const id = ids[round % ids.length] ?? "";
      const other = ids[(round + 2) % ids.length] ?? "";
      await Promise.all([
        write(a, id, { title: `A${round}` }),
        write(b, id, { ordinal: round }),
        // One node moves a task out of the scope (or keeps it in), the other moves it back.
        write(b, other, { projectId: round % 2 === 0 ? board.p2 : board.p1 }),
        write(a, other, { projectId: board.p1, title: `A${round}` }),
      ]);
    }
    await settle();
    const rows = await h.prisma.task.findMany({
      where: { projectId: board.p1 },
      orderBy: { id: "asc" },
    });
    const expected = rows.map((row) => ({ id: row.id, title: row.title, ordinal: row.ordinal }));
    for (const { connection, scopes, page } of subscribers) {
      await scopes.settle();
      const frames = scopes.frames.filter((frame) => frame.c === "byProject");
      const applied = applyFrames(applySnapshot(null, page as never, ORDER), frames, ORDER);
      expect(applied.reset).toBe(false);
      let { state } = applied;
      // As the client's controller does: ids a patch found no item for are loaded by id.
      const missing = [...new Set(applied.missing)];
      if (missing.length > 0) {
        const answer = (await colItems(connection, "byProject", board.p1, missing)) as {
          readonly rev: number;
          readonly items: unknown[];
        };
        state = applyItems(state, answer.items, answer.rev, ORDER, missing);
      }
      const held = [...state.byId.values()]
        .map((item) => {
          const { id, title, ordinal } = item as { id: string; title: string; ordinal: number };
          return { id, title, ordinal };
        })
        .sort((x, y) => (x.id < y.id ? -1 : 1));
      expect(held).toEqual(expected);
    }
  }, 60_000);
});
