// `qd:col:items` (RFC 0003 section 7.4) through a real server against PGlite:
// a client holding a scope's index loads full items by id. Only members of
// the scope come back, in request order; the socket must have subscribed to
// the scope; the frame is validated like `qd:col:sub`'s; and a request costs
// one statement (two for a `via` scope), with no access reads.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { as, seedBoard, type Board } from "../access/__tests__/board";
import { projectService, recordingStorage } from "../emit/__tests__/live";
import type { Principal } from "../index";
import {
  addTasks,
  colItems,
  colSub,
  colUnsub,
  defineTaskService,
  labelService,
} from "./__tests__/fixture";
import { MAX_ITEM_IDS } from "./items";

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

async function start(options: { readonly rateLimit?: { readonly maxRequests: number } } = {}) {
  const recorded = recordingStorage(h.storage);
  const app = await createTestApp({
    services: [projectService, labelService, defineTaskService()],
    db: h.db,
    storage: recorded.storage,
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
  });
  apps.push(app as unknown as TestApp);
  return { app, reads: recorded.reads };
}

type App = Awaited<ReturnType<typeof start>>["app"];

function connect(app: App, principal: Principal) {
  return app.connect(principal);
}

function code(reply: Record<string, unknown>): unknown {
  return (reply.e as { code?: unknown } | undefined)?.code;
}

describe("qd:col:items", () => {
  it("answers the scope's items for the ids asked, in request order, without ids outside it", async () => {
    const { app } = await start();
    const [one = "", two = ""] = await addTasks(h.prisma, board.p1, [1, 2]);
    const [done = ""] = await addTasks(h.prisma, board.p1, [3], { status: "done" });
    const connection = await connect(app, as(board.ada));
    await colSub(connection, "board", board.p1);
    const reply = await colItems(connection, "board", board.p1, [
      two,
      board.t2,
      "missing",
      board.t1,
      two,
      done,
    ]);
    expect(reply).toEqual({
      ok: true,
      items: [
        expect.objectContaining({ id: two, title: "Task 2", ordinal: 2 }),
        expect.objectContaining({ id: board.t1, title: "T1", ordinal: 0 }),
        expect.objectContaining({ id: done, status: "done" }),
      ],
    });
    expect(Object.keys((reply.items as object[])[0] ?? {}).sort()).toEqual(
      ["assigneeId", "id", "ordinal", "projectId", "status", "title", "updatedAt"].sort(),
    );
    expect(await colItems(connection, "board", board.p1, [])).toEqual({ ok: true, items: [] });
    // `where` decides membership: a row it excludes is not an item.
    await colSub(connection, "openByProject", board.p1);
    expect(await colItems(connection, "openByProject", board.p1, [one, done])).toEqual({
      ok: true,
      items: [expect.objectContaining({ id: one })],
    });
  });

  it("answers a via scope's items for the ids its junction links to the scope", async () => {
    const { app } = await start();
    const [linked = "", unlinked = ""] = await addTasks(h.prisma, board.p1, [1, 2]);
    const label = await h.prisma.label.create({ data: { projectId: board.p1, name: "Bug" } });
    await h.prisma.taskLabel.create({ data: { taskId: linked, labelId: label.id } });
    const connection = await connect(app, as(board.ada));
    await colSub(connection, "byLabel", label.id);
    expect(await colItems(connection, "byLabel", label.id, [unlinked, linked])).toEqual({
      ok: true,
      items: [expect.objectContaining({ id: linked })],
    });
    expect(await colItems(connection, "byLabel", label.id, [unlinked])).toEqual({
      ok: true,
      items: [],
    });
  });

  it("strips fields above the collection's level, as items are", async () => {
    const { app } = await start();
    await h.prisma.task.update({ where: { id: board.t1 }, data: { notes: "secret" } });
    const connection = await connect(app, as(board.ada));
    await colSub(connection, "rows", board.p1);
    const reply = await colItems(connection, "rows", board.p1, [board.t1]);
    expect(reply).toMatchObject({ ok: true, items: [{ id: board.t1, title: "T1" }] });
    expect((reply.items as object[])[0]).not.toHaveProperty("notes");
  });

  it("refuses a socket that has not subscribed to the scope, or has unsubscribed", async () => {
    const { app } = await start();
    const connection = await connect(app, as(board.ada));
    expect(code(await colItems(connection, "board", board.p1, [board.t1]))).toBe("FORBIDDEN");
    await colSub(connection, "board", board.p1);
    expect(code(await colItems(connection, "board", board.p2, [board.t2]))).toBe("FORBIDDEN");
    expect(code(await colItems(connection, "byProject", board.p1, [board.t1]))).toBe("FORBIDDEN");
    await colUnsub(connection, "board", board.p1);
    expect(code(await colItems(connection, "board", board.p1, [board.t1]))).toBe("FORBIDDEN");
    const other = await connect(app, as(board.ada));
    expect(code(await colItems(other, "board", board.p1, [board.t1]))).toBe("FORBIDDEN");
  });

  it("validates its frame like qd:col:sub: VALIDATION, NOT_FOUND and UNAUTHENTICATED", async () => {
    const { app } = await start();
    const connection = await connect(app, as(board.ada));
    await colSub(connection, "board", board.p1);
    const refusal = (path: string) => ({
      ok: false,
      e: { code: "VALIDATION", data: { issues: [{ path: path === "" ? [] : [path] }] } },
    });
    const ids = (count: number) => Array.from({ length: count }, (_, index) => `t${index}`);
    expect(await colItems(connection, "board", board.p1, ids(MAX_ITEM_IDS))).toMatchObject({
      ok: true,
    });
    expect(await colItems(connection, "board", board.p1, ids(MAX_ITEM_IDS + 1))).toMatchObject(
      refusal("ids"),
    );
    expect(
      await emitWithAck(connection.socket, "qd:col:items", {
        s: "taskService",
        c: "board",
        scope: board.p1,
        ids: [board.t1, ""],
      }),
    ).toMatchObject(refusal("ids"));
    expect(
      await emitWithAck(connection.socket, "qd:col:items", {
        s: "taskService",
        c: "board",
        scope: board.p1,
      }),
    ).toMatchObject(refusal("ids"));
    expect(
      await emitWithAck(connection.socket, "qd:col:items", { s: "taskService", c: "board" }),
    ).toMatchObject(refusal(""));
    expect(await colItems(connection, "nope", board.p1, [board.t1])).toEqual({
      ok: false,
      e: { code: "NOT_FOUND", message: 'taskService has no collection "nope"' },
    });
    const anonymous = await app.connect(null);
    expect(code(await colItems(anonymous, "board", board.p1, [board.t1]))).toBe("UNAUTHENTICATED");
  });

  it("costs one read for a column scope and two for a via scope, and no access reads", async () => {
    const { app, reads } = await start();
    const label = await h.prisma.label.create({ data: { projectId: board.p1, name: "Bug" } });
    await h.prisma.taskLabel.create({ data: { taskId: board.t1, labelId: label.id } });
    const connection = await connect(app, as(board.ada));
    await colSub(connection, "board", board.p1);
    await colSub(connection, "byLabel", label.id);
    reads.length = 0;
    await colItems(connection, "board", board.p1, [board.t1]);
    expect(reads).toEqual([
      {
        model: "task",
        args: {
          where: { projectId: board.p1, id: { in: [board.t1] } },
          select: expect.objectContaining({ id: true, title: true }),
        },
      },
    ]);
    reads.length = 0;
    await colItems(connection, "byLabel", label.id, [board.t1]);
    expect(reads.map(({ model }) => model)).toEqual(["taskLabel", "task"]);
  });

  it("is not counted by the socket rate limiter", async () => {
    const { app } = await start({ rateLimit: { maxRequests: 2 } });
    const connection = await connect(app, as(board.ada));
    await colSub(connection, "board", board.p1);
    for (let round = 0; round < 5; round += 1) {
      expect(await colItems(connection, "board", board.p1, [board.t1])).toMatchObject({
        ok: true,
      });
    }
    const call = (id: number) =>
      emitWithAck(connection.socket, "qd:call", {
        id,
        s: "taskService",
        m: "get",
        i: { id: board.t1 },
      });
    expect(await call(1)).toMatchObject({ ok: true });
    expect(await call(2)).toMatchObject({ ok: true });
    expect(await call(3)).toMatchObject({ ok: false, e: { code: "RATE_LIMITED" } });
  });
});
