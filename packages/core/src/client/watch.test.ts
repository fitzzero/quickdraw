// A connection's change topics against a real server on PGlite (RFC 0003
// sections 8.2, 11.3 and 17), without React: one `qd:watch` per topic however
// many watch it, `qd:changed` routed by topic and told once per key, a topic
// refused until the next connect, `RATE_LIMITED` waited out on the
// subscription backoff, every topic joined again after a reconnect, and
// reads that wait for a join in flight.

import { afterEach, describe, expect, it, vi } from "vitest";
import { collectionTopic } from "../index";
import { tick, deferred } from "../server/__tests__/fixtures";
import { as } from "../server/access/__tests__/board";
import type { Principal } from "../server/index";
import { createQuickdrawConnection, type QuickdrawConnection } from "./connection";
import { outgoing, until, whenStatus } from "./__tests__/fixtures";
import { topicOf } from "./queryHooks";
import { framesOf, liveHarness, watchersOf } from "./__tests__/live";

const live = liveHarness();
const connections: QuickdrawConnection[] = [];

afterEach(() => {
  for (const connection of connections.splice(0)) {
    connection.close();
  }
  vi.unstubAllGlobals();
});

async function connect(url: string, principal: Principal): Promise<QuickdrawConnection> {
  const connection = createQuickdrawConnection({
    url,
    auth: { principal },
    transports: ["websocket"],
  });
  connections.push(connection);
  connection.open();
  await whenStatus(connection, "connected");
  return connection;
}

describe("connection.watch", () => {
  it("joins a topic once for every watch of it, tells each key once per frame, and leaves after the last", async () => {
    const { app } = await live.start();
    const board = live.board();
    const connection = await connect(app.url, as(board.ada));
    const sent = outgoing(connection);
    const topic = collectionTopic("board", board.p1);
    const told: string[] = [];
    const watch = (key: string | undefined, name: string) =>
      connection.watch({
        service: "taskService",
        topic,
        ...(key === undefined ? {} : { key }),
        onChanged: (frame) => {
          told.push(`${name} ${frame.topic}`);
        },
      });
    const stops = [watch("a", "first"), watch("a", "second"), watch(undefined, "third")];
    await until(() => watchersOf(app, board.p1) === 1);
    expect(framesOf(sent, "qd:watch")).toEqual([{ s: "taskService", topic }]);
    await app.as(as(board.ada)).taskService.renameTenTimes({ id: board.t1 });
    await until(() => told.length === 2);
    await tick(100);
    expect(told).toEqual([`first ${topic}`, `third ${topic}`]);
    stops[0]?.();
    stops[0]?.();
    stops[1]?.();
    await tick(50);
    expect(framesOf(sent, "qd:unwatch")).toEqual([]);
    stops[2]?.();
    await until(() => watchersOf(app, board.p1) === 0);
    expect(framesOf(sent, "qd:unwatch")).toEqual([{ s: "taskService", topic }]);
  });

  it("keeps a topic whose last watch ends and another starts in the same tick, as a remount does", async () => {
    const { app } = await live.start();
    const board = live.board();
    const connection = await connect(app.url, as(board.ada));
    const sent = outgoing(connection);
    const watch = () =>
      connection.watch({
        service: "taskService",
        topic: collectionTopic("board", board.p1),
        onChanged: () => undefined,
      });
    const first = watch();
    await until(() => watchersOf(app, board.p1) === 1);
    first();
    const second = watch();
    await tick(100);
    expect(framesOf(sent, "qd:watch")).toHaveLength(1);
    expect(framesOf(sent, "qd:unwatch")).toEqual([]);
    second();
    await until(() => watchersOf(app, board.p1) === 0);
    expect(framesOf(sent, "qd:unwatch")).toHaveLength(1);
  });

  it("waits for the connection, and joins every watched topic again after a reconnect", async () => {
    const { app } = await live.start();
    const board = live.board();
    const connection = createQuickdrawConnection({
      url: app.url,
      auth: { principal: as(board.ada) },
      transports: ["websocket"],
    });
    connections.push(connection);
    const sent = outgoing(connection);
    connection.watch({
      service: "taskService",
      topic: collectionTopic("board", board.p1),
      onChanged: () => undefined,
    });
    connection.watch({
      service: "taskService",
      topic: collectionTopic("open", board.p1),
      onChanged: () => undefined,
    });
    expect(framesOf(sent, "qd:watch")).toEqual([]);
    connection.open();
    await until(() => watchersOf(app, board.p1) === 1 && watchersOf(app, board.p1, "open") === 1);
    const first = connection.socket.id;
    app.server.rotate({ withinMs: 0 });
    await until(
      () => connection.socket.id !== first && connection.getState().status === "connected",
    );
    await until(() => watchersOf(app, board.p1) === 1 && watchersOf(app, board.p1, "open") === 1);
    expect(framesOf(sent, "qd:watch")).toHaveLength(4);
  });

  it("leaves a refused topic alone until the next connect", async () => {
    const { app } = await live.start();
    const board = live.board();
    const connection = await connect(app.url, as(board.ada));
    const sent = outgoing(connection);
    // Ada may not read P2's board: the server answers FORBIDDEN.
    connection.watch({
      service: "taskService",
      topic: collectionTopic("board", board.p2),
      onChanged: () => undefined,
    });
    await until(() => framesOf(sent, "qd:watch").length === 1);
    await tick(300);
    expect(framesOf(sent, "qd:watch")).toHaveLength(1);
    expect(watchersOf(app, board.p2)).toBe(0);
    expect(connection.backoffRemaining("subscription")).toBe(0);
    const first = connection.socket.id;
    app.server.rotate({ withinMs: 0 });
    await until(
      () => connection.socket.id !== first && connection.getState().status === "connected",
    );
    await until(() => framesOf(sent, "qd:watch").length === 2);
  });

  it("waits out RATE_LIMITED on the subscription backoff, then joins", async () => {
    let held = deferred();
    const { app } = await live.start({
      limits: { subscriptions: { maxInFlight: 1, maxQueued: 0 }, retryAfterMs: 300 },
      beforeRead: () => held.promise,
    });
    const board = live.board();
    const connection = await connect(app.url, as(board.ada));
    const sent = outgoing(connection);
    // Sent past the connection's lane, so the server's one slot is taken
    // while the connection's own lane is empty.
    connection.socket.emit("qd:watch", { s: "taskService", topic: `board:${board.p1}` }, () => {
      // Its answer does not matter here.
    });
    await until(() => framesOf(sent, "qd:watch").length === 1);
    connection.watch({
      service: "taskService",
      topic: collectionTopic("open", board.p1),
      onChanged: () => undefined,
    });
    await until(() => connection.backoffRemaining("subscription") > 0);
    expect(framesOf(sent, "qd:watch")).toHaveLength(2);
    held.resolve();
    held = deferred();
    held.resolve();
    await until(() => watchersOf(app, board.p1) === 1);
    expect(watchersOf(app, board.p1, "open")).toBe(0);
    await until(() => watchersOf(app, board.p1, "open") === 1, 3000);
    expect(framesOf(sent, "qd:watch")).toHaveLength(3);
    expect(connection.backoffRemaining("subscription")).toBe(0);
  });

  it("sends no more watches at once than the server's lane runs, so a burst is never refused", async () => {
    let held = deferred();
    const { app } = await live.start({
      limits: { subscriptions: { maxInFlight: 1, maxQueued: 0 }, retryAfterMs: 300 },
      beforeRead: () => held.promise,
    });
    const board = live.board();
    const connection = await connect(app.url, as(board.ada));
    const sent = outgoing(connection);
    for (const collection of ["board", "open"]) {
      connection.watch({
        service: "taskService",
        topic: collectionTopic(collection, board.p1),
        onChanged: () => undefined,
      });
    }
    await until(() => framesOf(sent, "qd:watch").length === 1);
    await tick(100);
    // The second waits in the connection's lane while the first holds the server's only slot.
    expect(framesOf(sent, "qd:watch")).toHaveLength(1);
    expect(connection.subscriptionLane.waiting()).toBe(1);
    held.resolve();
    held = deferred();
    held.resolve();
    await until(() => watchersOf(app, board.p1) === 1 && watchersOf(app, board.p1, "open") === 1);
    expect(framesOf(sent, "qd:watch")).toHaveLength(2);
    expect(connection.backoffRemaining("subscription")).toBe(0);
  });

  it("lets a read wait for a join in flight, and tells only the watches whose read did not wait", async () => {
    let held = deferred();
    const { app } = await live.start({ beforeRead: () => held.promise });
    const board = live.board();
    const topic = collectionTopic("board", board.p1);
    const unwatched = createQuickdrawConnection({
      url: app.url,
      auth: { principal: as(board.ada) },
      transports: ["websocket"],
    });
    connections.push(unwatched);
    unwatched.watch({ service: "taskService", topic, onChanged: () => undefined });
    // Not connected: there is no join in flight to wait for.
    expect(unwatched.waitForJoin({ service: "taskService", topic, key: "a" })).toBeUndefined();

    const connection = await connect(app.url, as(board.ada));
    const sent = outgoing(connection);
    const joined: string[] = [];
    for (const key of ["waits", "read before"]) {
      connection.watch({
        service: "taskService",
        topic,
        key,
        onChanged: () => undefined,
        onJoined: () => joined.push(key),
      });
    }
    expect(
      connection.waitForJoin({ service: "taskService", topic: "board:other" }),
    ).toBeUndefined();
    let answered = false;
    void connection.waitForJoin({ service: "taskService", topic, key: "waits" })?.then(() => {
      answered = true;
    });
    await until(() => framesOf(sent, "qd:watch").length === 1);
    await tick(100);
    expect(answered).toBe(false);
    held.resolve();
    held = deferred();
    held.resolve();
    await until(() => answered);
    expect(joined).toEqual(["read before"]);
    // Joined: a read from now on sees every change, so nothing waits.
    expect(connection.waitForJoin({ service: "taskService", topic, key: "waits" })).toBeUndefined();
  });

  it("lets a read waiting for a join go when the join is refused", async () => {
    let held = deferred();
    const { app } = await live.start({ beforeRead: () => held.promise });
    const board = live.board();
    const connection = await connect(app.url, as(board.ada));
    // Ada may not read P2's board: the server answers FORBIDDEN.
    const topic = collectionTopic("board", board.p2);
    const joined: string[] = [];
    connection.watch({
      service: "taskService",
      topic,
      key: "k",
      onChanged: () => undefined,
      onJoined: () => joined.push("k"),
    });
    let answered = false;
    void connection.waitForJoin({ service: "taskService", topic, key: "k" })?.then(() => {
      answered = true;
    });
    await tick(100);
    expect(answered).toBe(false);
    held.resolve();
    held = deferred();
    held.resolve();
    await until(() => answered);
    expect(joined).toEqual([]);
    expect(connection.waitForJoin({ service: "taskService", topic, key: "k" })).toBeUndefined();
  });

  it("tells every watch even when one throws, and reports the error on its own", async () => {
    const { app } = await live.start();
    const board = live.board();
    const scheduled: (() => void)[] = [];
    vi.stubGlobal("queueMicrotask", (task: () => void) => {
      scheduled.push(task);
    });
    const connection = await connect(app.url, as(board.ada));
    const topic = collectionTopic("board", board.p1);
    const told: string[] = [];
    connection.watch({
      service: "taskService",
      topic,
      onChanged: () => {
        throw new Error("a broken listener");
      },
    });
    connection.watch({
      service: "taskService",
      topic,
      onChanged: () => {
        told.push("after it");
      },
    });
    await until(() => watchersOf(app, board.p1) === 1);
    await app.as(as(board.ada)).taskService.renameTenTimes({ id: board.t1 });
    await until(() => told.length === 1);
    expect(scheduled).toHaveLength(1);
    expect(() => scheduled[0]?.()).toThrow("a broken listener");
  });
});

describe("the topic a query watches", () => {
  it("is its service's own for watch: \"service\", and a scope's for a collection watch", () => {
    const query = { service: "scoresService", method: "best", kind: "query" } as const;
    expect(topicOf({ ...query, watch: "service" }, undefined)).toBe("service");
    const scoped = {
      collection: "board",
      scope: (input: { projectId: string }) => input.projectId,
    };
    expect(topicOf({ ...query, watch: scoped as never }, { projectId: "p1" })).toBe(
      collectionTopic("board", "p1"),
    );
    expect(topicOf(query, undefined)).toBeUndefined();
  });
});
