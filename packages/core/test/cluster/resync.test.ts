// A node whose Valkey connection drops and comes back, on two nodes behind a
// real Valkey (the pack H finale review): what the other nodes published
// meanwhile never reaches its sockets, so once its subscription is back its
// clients get `qd:rotate` and catch up by subscribing again; and what it
// published while Valkey was down and the client gave up on is dropped and
// logged, never an unhandled rejection (node-redis 5 and later reject a
// queued command after their command timeout, and the adapter does not
// handle its publishes).

import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityResult, RotateFrame } from "../../src/index";
import { createHarness, type Harness } from "../../src/prisma/__tests__/harness";
import { captureLogger } from "../../src/server/__tests__/fixtures";
import { as, seedBoard, type Board } from "../../src/server/access/__tests__/board";
import {
  defineTaskService,
  projectService,
  receive,
  sub,
} from "../../src/server/emit/__tests__/live";
import type * as Testing from "../../src/testing/createTestApp";
import type { TestApp } from "../../src/testing/index";
import { createBarrier, startNode, stopNodes, type ClusterNode, type CreateTestApp } from "./nodes";
import { startValkeyProxy, type ValkeyProxy } from "./proxy";
import { uniquePrefix } from "./valkey";

// The single-server `createTestApp`: these tests boot each node themselves.
const { createTestApp } = await vi.importActual<typeof Testing>("../../src/testing/createTestApp");

let h: Harness;
let board: Board;
const running: ClusterNode[][] = [];
const proxies: ValkeyProxy[] = [];

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
  for (const proxy of proxies) {
    await proxy.restore().catch(() => undefined);
  }
  const clients = running.flat().flatMap((node) => node.clients);
  await vi
    .waitFor(() => {
      expect(clients.every((client) => client.isReady)).toBe(true);
    }, 10_000)
    .catch(() => undefined);
  await Promise.all(running.splice(0).map(stopNodes));
  for (const proxy of proxies.splice(0)) {
    await proxy.close();
  }
});

const services = [projectService, defineTaskService()];

type Rename = {
  readonly taskService: { rename(input: { id: string; title: string }): Promise<null> };
};

function rename(app: object, title: string): Promise<null> {
  const caller = (app as Pick<TestApp, "as">).as(as(board.ada)) as unknown as Rename;
  return caller.taskService.rename({ id: board.t1, title });
}

function titlesOf(frames: ReturnType<typeof receive>): unknown[] {
  return frames.entity.map((frame) => (frame as { d?: { title?: string } }).d?.title);
}

describe("a node whose Valkey connection comes back", () => {
  it("sends its clients qd:rotate, and they catch up on what it missed", async () => {
    const proxy = await startValkeyProxy();
    proxies.push(proxy);
    const prefix = uniquePrefix("resync");
    const logger = captureLogger();
    const create = createTestApp as CreateTestApp;
    // Node A reaches Valkey through the proxy; node B directly.
    const a = await startNode(create, { services, db: h.db, logger }, { prefix, url: proxy.url });
    const b = await startNode(create, { services, db: h.db }, { prefix });
    running.push([a, b]);
    const reader = await a.app.connect(as(board.cy));
    const frames = receive(reader);
    const rotations: RotateFrame[] = [];
    reader.socket.on("qd:rotate", (frame: RotateFrame) => rotations.push(frame));
    await sub(reader, "taskService", [board.t1]);
    await rename(b.app, "Before the cut");
    await createBarrier(b.app.server.io, a.app.server.io)();
    await frames.settle();
    const held = frames.entity.at(-1)?.rev ?? 0;

    await proxy.cut();
    await vi.waitFor(() => {
      expect(a.clients.some((client) => client.isReady)).toBe(false);
    }, 5000);
    await rename(b.app, "During the cut");
    await proxy.restore();
    await vi.waitFor(() => {
      expect(rotations).toEqual([{ withinMs: 2000 }]);
    }, 10_000);
    // Node B's frame went out while node A was not subscribed: it never arrives.
    await createBarrier(b.app.server.io, a.app.server.io)();
    await frames.settle();
    expect(titlesOf(frames)).toEqual(["Before the cut"]);
    expect(logger.at("info").map(({ message }) => message)).toContain(
      "This node's Valkey subscription is back; its clients reconnect to catch up on what it missed",
    );
    // The client reconnects and subscribes again, holding the row it has: it gets the change.
    const again = await a.app.connect(as(board.cy));
    const reply = (await sub(again, "taskService", [board.t1], [held])) as {
      readonly r: readonly EntityResult[];
    };
    expect(reply.r[0]).toMatchObject({ ok: true, d: { title: "During the cut" } });
  });
});

describe("a publish Valkey does not take in time", () => {
  it("is dropped and logged once, and the node's own sockets still get their frames", async () => {
    const proxy = await startValkeyProxy();
    proxies.push(proxy);
    const prefix = uniquePrefix("resync");
    // A command timeout of 200 ms stands for node-redis's 5 s default.
    const pub = createClient({ url: proxy.url, commandOptions: { timeout: 200 } });
    pub.on("error", () => undefined);
    const subscriber = pub.duplicate();
    subscriber.on("error", () => undefined);
    await Promise.all([pub.connect(), subscriber.connect()]);
    const logger = captureLogger();
    const app = await createTestApp({
      services,
      db: h.db,
      logger,
      socket: { adapter: createAdapter(pub, subscriber, { key: prefix }) },
      cluster: { keyPrefix: prefix },
    });
    running.push([{ app: app as unknown as TestApp, clients: [pub, subscriber] }]);
    const reader = await app.connect(as(board.cy));
    const frames = receive(reader);
    await sub(reader, "taskService", [board.t1]);
    await proxy.cut();
    await vi.waitFor(() => {
      expect(pub.isReady).toBe(false);
    }, 5000);
    await rename(app, "Down 1");
    await rename(app, "Down 2");
    // Their publishes wait in the client's queue past its command timeout, and fail.
    await vi.waitFor(() => {
      expect(
        logger
          .at("warn")
          .filter(({ message }) => message.startsWith("Valkey did not take a message")),
      ).toHaveLength(1);
    }, 5000);
    await frames.settle();
    expect(titlesOf(frames)).toEqual(["Down 1", "Down 2"]);
    await proxy.restore();
  });
});
