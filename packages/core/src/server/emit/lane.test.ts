// Each socket's lane of subscription work (`lane.ts`): the socket rate
// limiter does not count `qd:sub`, `qd:col:sub`, `qd:col:items` or
// `qd:watch`, so the lane caps them instead, 8 at once and 64 waiting by
// default, shared by the four events, then `RATE_LIMITED`. Before it, one
// socket could run 300 batches of 500 ids at once.

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { as, seedBoard, type Board } from "../access/__tests__/board";
import { defineTaskService, labelService } from "../collections/__tests__/fixture";
import type { StorageAdapter } from "../storage";
import { projectService } from "./__tests__/live";

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

interface Gauge {
  inFlight: number;
  peak: number;
  reads: number;
  /** Holds each read until this resolves, when set. */
  hold?: Promise<void>;
}

/** The harness's storage, counting the reads in flight; each read takes a few milliseconds, or waits for `hold`. */
function gaugedStorage(): { readonly storage: StorageAdapter; readonly gauge: Gauge } {
  const gauge: Gauge = { inFlight: 0, peak: 0, reads: 0 };
  const storage: StorageAdapter = Object.freeze({
    ...h.storage,
    findMany: async (model: string, args?: Readonly<Record<string, unknown>>) => {
      gauge.inFlight += 1;
      gauge.reads += 1;
      gauge.peak = Math.max(gauge.peak, gauge.inFlight);
      try {
        await (gauge.hold ??
          new Promise((resolve) => {
            setTimeout(resolve, 5);
          }));
        return await h.storage.findMany(model, args);
      } finally {
        gauge.inFlight -= 1;
      }
    },
  });
  return { storage, gauge };
}

type Reply = { ok: boolean; e?: { code: string; message: string; data?: unknown } };

async function start(storage: StorageAdapter, limits?: { maxInFlight: number; maxQueued: number }) {
  const app = await createTestApp({
    services: [projectService, defineTaskService(), labelService],
    db: h.db,
    storage,
    rateLimit: {},
    ...(limits === undefined ? {} : { limits: { subscriptions: limits } }),
  });
  apps.push(app as unknown as TestApp);
  return app;
}

it("runs one socket's 300 batches of 500 ids 8 at a time with 64 waiting, and refuses the rest", async () => {
  const { storage, gauge } = gaugedStorage();
  let release = (): void => undefined;
  const app = await start(storage);
  const connection = await app.connect(as(board.ada));
  // Every read waits until all 300 batches have arrived.
  gauge.hold = new Promise((resolve) => {
    release = resolve;
  });
  const ids = [board.t1, ...Array.from({ length: 499 }, (_, index) => `x${index}`)];
  const answered: Reply[] = [];
  const pending = Array.from({ length: 300 }, async () => {
    const reply = await emitWithAck<Reply>(connection.socket, "qd:sub", { s: "taskService", ids });
    answered.push(reply);
    return reply;
  });
  await expect.poll(() => answered.length).toBe(228);
  // Eight batches are running, each in its first read (the tasks' projects).
  expect(gauge.peak).toBe(8);
  gauge.hold = undefined;
  release();
  const replies = await Promise.all(pending);
  const limited = replies.filter((reply) => reply.e?.code === "RATE_LIMITED");
  expect(replies.filter((reply) => reply.ok)).toHaveLength(72);
  expect(limited).toHaveLength(228);
  expect(limited[0]).toEqual({
    ok: false,
    e: {
      code: "RATE_LIMITED",
      message: "Too many subscription requests in flight on this connection",
      data: { retryAfterMs: 1_000 },
    },
  });
  // Never more than eight batches: the project policy's anyOf reads its two tables together.
  expect(gauge.peak).toBeLessThanOrEqual(16);
});

it("is shared by qd:sub, qd:col:sub, qd:col:items and qd:watch, and sized by limits.subscriptions", async () => {
  const { storage, gauge } = gaugedStorage();
  let release = (): void => undefined;
  const app = await start(storage, { maxInFlight: 1, maxQueued: 1 });
  const connection = await app.connect(as(board.ada));
  gauge.hold = new Promise((resolve) => {
    release = resolve;
  });
  const running = emitWithAck<Reply>(connection.socket, "qd:sub", {
    s: "taskService",
    ids: [board.t1],
  });
  const waiting = emitWithAck<Reply>(connection.socket, "qd:col:sub", {
    s: "taskService",
    c: "byProject",
    scope: board.p1,
  });
  const refused = await Promise.all([
    emitWithAck<Reply>(connection.socket, "qd:col:items", {
      s: "taskService",
      c: "byProject",
      scope: board.p1,
      ids: [board.t1],
    }),
    emitWithAck<Reply>(connection.socket, "qd:watch", {
      s: "taskService",
      topic: `byProject:${board.p1}`,
    }),
  ]);
  expect(refused.map((reply) => reply.e?.code)).toEqual(["RATE_LIMITED", "RATE_LIMITED"]);
  gauge.hold = undefined;
  release();
  expect(await running).toMatchObject({ ok: true });
  expect(await waiting).toMatchObject({ ok: true });
});

it("drops a disconnected socket's waiting work, and frees the lane once its running work ends", async () => {
  const { storage, gauge } = gaugedStorage();
  let release = (): void => undefined;
  const app = await start(storage, { maxInFlight: 1, maxQueued: 4 });
  const connection = await app.connect(as(board.ada));
  gauge.hold = new Promise((resolve) => {
    release = resolve;
  });
  for (let index = 0; index < 5; index += 1) {
    connection.socket.emit("qd:sub", { s: "taskService", ids: [board.t1] }, () => undefined);
  }
  await expect.poll(() => gauge.reads).toBe(1);
  connection.close();
  await new Promise((resolve) => {
    setTimeout(resolve, 20);
  });
  gauge.hold = undefined;
  release();
  await expect.poll(() => gauge.inFlight).toBe(0);
  await new Promise((resolve) => {
    setTimeout(resolve, 50);
  });
  // Only the running batch read on: its access lookups, then nothing for the four that waited.
  expect(gauge.reads).toBeLessThanOrEqual(4);
});
