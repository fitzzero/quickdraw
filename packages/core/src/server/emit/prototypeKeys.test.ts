// Frames naming prototype keys (`__proto__`, `constructor`, ...) on every
// live event. Per-socket records are kept by keys clients name, so a lookup
// that reached `Object.prototype` used to find an inherited value and throw
// inside Socket.IO's `process.nextTick`, which ends the process: one
// `qd:unsub { s: "__proto__", ids: ["toString"] }` took a server down. Each
// frame must be answered, and the socket's subscriptions must keep working.

import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { as, seedBoard, type Board } from "../access/__tests__/board";
import {
  colSub,
  defineTaskService,
  labelService,
  receiveScopes,
  watch,
} from "../collections/__tests__/fixture";
import { projectService, receive, sub } from "./__tests__/live";

const KEYS = ["__proto__", "constructor", "toString", "hasOwnProperty", "valueOf", "prototype"];

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

/** Every frame of the seven live events that names `key` where a client names a key. */
function framesNaming(key: string): [string, Record<string, unknown>][] {
  const scopes = [
    { s: key, c: key, scope: key },
    { s: "taskService", c: key, scope: key },
    { s: "taskService", c: "byProject", scope: key },
  ];
  const topics = [
    { s: key, topic: key },
    { s: key, topic: "service" },
    { s: "taskService", topic: key },
    { s: "taskService", topic: `${key}:${key}` },
    { s: "taskService", topic: `byProject:${key}` },
  ];
  const ids = [
    { s: key, ids: [key] },
    { s: "taskService", ids: [key] },
  ];
  return [
    ...ids.map((frame): [string, Record<string, unknown>] => ["qd:sub", frame]),
    ...ids.map((frame): [string, Record<string, unknown>] => ["qd:unsub", frame]),
    ...scopes.map((frame): [string, Record<string, unknown>] => ["qd:col:sub", frame]),
    ...scopes.map((frame): [string, Record<string, unknown>] => ["qd:col:unsub", frame]),
    ...scopes.map((frame): [string, Record<string, unknown>] => [
      "qd:col:items",
      { ...frame, ids: [key] },
    ]),
    ...topics.map((frame): [string, Record<string, unknown>] => ["qd:watch", frame]),
    ...topics.map((frame): [string, Record<string, unknown>] => ["qd:unwatch", frame]),
  ];
}

it("answers prototype keys on all seven events, and the server and socket stay up", async () => {
  const app = await createTestApp({
    services: [projectService, defineTaskService(), labelService],
    db: h.db,
  });
  apps.push(app as unknown as TestApp);
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown): void => {
    uncaught.push(error);
  };
  process.prependListener("uncaughtException", onUncaught);
  try {
    const connection = await app.connect(as(board.ada));
    const entities = receive(connection);
    const scopes = receiveScopes(connection);
    // A record of each kind exists, so a lookup has a map to walk up from.
    expect(await sub(connection, "taskService", [board.t1])).toMatchObject({ ok: true });
    expect(await colSub(connection, "byProject", board.p1)).toMatchObject({ ok: true });
    expect(await watch(connection, `byProject:${board.p1}`)).toEqual({ ok: true });
    const frames = KEYS.flatMap(framesNaming);
    for (const [event, frame] of frames) {
      // Without an acknowledgement first: a listener may not throw either way.
      connection.socket.emit(event, frame);
    }
    const replies = await Promise.all(
      frames.map(([event, frame]) =>
        emitWithAck<{ ok: unknown; e?: { code: string } }>(connection.socket, event, frame),
      ),
    );
    expect(replies.every((reply) => typeof reply.ok === "boolean")).toBe(true);
    expect(replies.filter((reply) => reply.e?.code === "INTERNAL")).toEqual([]);
    expect(
      replies.find((_, index) => {
        const [event, frame] = frames[index] ?? [];
        return event === "qd:unsub" && frame?.s === "__proto__";
      }),
    ).toMatchObject({ ok: false, e: { code: "NOT_FOUND" } });

    // The subscriptions made before still deliver.
    await app.as(as(board.ada)).taskService.renameTenTimes({ id: board.t1 });
    await Promise.all([entities.settle(), scopes.settle()]);
    expect(entities.entity).toEqual([
      expect.objectContaining({ t: "p", id: board.t1, d: { title: "Round 10" } }),
    ]);
    expect(scopes.frames).toEqual([
      expect.objectContaining({
        scope: board.p1,
        deltas: [expect.objectContaining({ t: "patched" })],
      }),
    ]);
    expect(scopes.changed).toEqual([
      expect.objectContaining({ s: "taskService", topic: `byProject:${board.p1}` }),
    ]);
    expect(connection.socket.connected).toBe(true);
    expect(uncaught).toEqual([]);
  } finally {
    process.removeListener("uncaughtException", onUncaught);
  }
});

it("answers a qd:unsub naming an unknown service NOT_FOUND, and more than 500 ids VALIDATION", async () => {
  const app = await createTestApp({
    services: [projectService, defineTaskService(), labelService],
    db: h.db,
  });
  apps.push(app as unknown as TestApp);
  const connection = await app.connect(as(board.ada));
  expect(
    await emitWithAck(connection.socket, "qd:unsub", { s: "noService", ids: [board.t1] }),
  ).toEqual({ ok: false, e: { code: "NOT_FOUND", message: 'Unknown service "noService"' } });
  const ids = Array.from({ length: 501 }, (_, index) => `t${index}`);
  expect(await emitWithAck(connection.socket, "qd:unsub", { s: "taskService", ids })).toEqual({
    ok: false,
    e: {
      code: "VALIDATION",
      message: "A qd:unsub frame names at most 500 ids",
      data: { issues: [{ path: ["ids"], message: "A qd:unsub frame names at most 500 ids" }] },
    },
  });
  expect(
    await emitWithAck(connection.socket, "qd:col:unsub", {
      s: "taskService",
      c: "nope",
      scope: "x",
    }),
  ).toMatchObject({ ok: false, e: { code: "NOT_FOUND" } });
  expect(
    await emitWithAck(connection.socket, "qd:unwatch", { s: "taskService", topic: "nope:x" }),
  ).toMatchObject({ ok: false, e: { code: "NOT_FOUND" } });
});
