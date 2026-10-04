// Access-change broadcasts that a node never answers, on two nodes behind a
// real Valkey (the pack H finale review). The wait for every node's answer is
// in line with a node's flushes, so it must not hold them: after one
// unanswered broadcast a node stops waiting until every node answers a
// probe, and with Valkey down it never waits, so frames to its own sockets
// go out at once. A "zombie" subscriber on the adapter's request channel
// stands for a node that Valkey still counts but that never answers (frozen,
// killed with its connection not dropped yet, an old version).

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { EntityFrame } from "../../src/index";
import { createHarness, type Harness } from "../../src/prisma/__tests__/harness";
import { captureLogger, type CapturingLogger } from "../../src/server/__tests__/fixtures";
import { as, seedBoard, type Board } from "../../src/server/access/__tests__/board";
import { defineTaskService, projectService, sub } from "../../src/server/emit/__tests__/live";
import type * as Testing from "../../src/testing/createTestApp";
import type { TestConnection } from "../../src/testing/index";
import { createBarrier, startNode, stopNodes, type ClusterNode, type CreateTestApp } from "./nodes";
import { startValkeyProxy, type ValkeyProxy } from "./proxy";
import { closeClient, uniquePrefix, valkeyClient, type ValkeyClient } from "./valkey";

// The single-server `createTestApp`: these tests boot each node themselves.
const { createTestApp } = await vi.importActual<typeof Testing>("../../src/testing/createTestApp");

let h: Harness;
let board: Board;
const running: ClusterNode[][] = [];
const zombies: ValkeyClient[] = [];
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
  // A node closes its Valkey connections gracefully: let them reconnect after a cut first.
  const clients = running.flat().flatMap((node) => node.clients);
  await vi
    .waitFor(() => {
      expect(clients.every((client) => client.isReady)).toBe(true);
    }, 10_000)
    .catch(() => undefined);
  await Promise.all(running.splice(0).map(stopNodes));
  await Promise.all(zombies.splice(0).map(closeClient));
  for (const proxy of proxies.splice(0)) {
    await proxy.close();
  }
});

const TIMEOUT_MS = 300;

async function cluster(url?: string) {
  const prefix = uniquePrefix("broadcasts");
  const loggers = { a: captureLogger(), b: captureLogger() };
  const node = (logger: CapturingLogger) =>
    startNode(
      createTestApp as CreateTestApp,
      {
        services: [projectService, defineTaskService()],
        db: h.db,
        logger,
        cluster: { timeoutMs: TIMEOUT_MS },
      },
      { prefix, ...(url === undefined ? {} : { url }) },
    );
  const a = await node(loggers.a);
  const b = await node(loggers.b);
  running.push([a, b]);
  return { a, b, prefix, loggers };
}

/** A subscriber on the adapter's request channel that never answers. */
async function zombie(prefix: string): Promise<ValkeyClient> {
  const client = valkeyClient();
  await client.connect();
  await client.subscribe(`${prefix}-request#/#`, () => undefined);
  zombies.push(client);
  return client;
}

type Calls = {
  readonly projectService: {
    setRole(input: { projectId: string; userId: string; role: string }): Promise<number>;
  };
  readonly taskService: { rename(input: { id: string; title: string }): Promise<null> };
};

/** Records when each entity frame with a title arrived. */
function titles(connection: Pick<TestConnection, "socket">) {
  const arrived = new Map<string, number>();
  connection.socket.on("qd:e", (frame: EntityFrame) => {
    const title = (frame as { d?: { title?: string } }).d?.title;
    if (title !== undefined && !arrived.has(title)) {
      arrived.set(title, performance.now());
    }
  });
  return arrived;
}

/** `count` access changes (bo's role in P1), then a rename of T1; when each call was answered. */
async function accessChangesThenRename(writer: TestConnection, count: number, title: string) {
  const calls = writer.call as unknown as Calls;
  for (let n = 0; n < count; n += 1) {
    await calls.projectService.setRole({
      projectId: board.p1,
      userId: board.bo,
      role: n % 2 === 0 ? "Read" : "Moderate",
    });
  }
  await calls.taskService.rename({ id: board.t1, title });
}

describe("a node that never answers", () => {
  it("costs one timeout, then broadcasts stop waiting until every node answers a probe", async () => {
    const { a, b, prefix, loggers } = await cluster();
    const stuck = await zombie(prefix);
    const reader = await a.app.connect(as(board.cy));
    const arrived = titles(reader);
    await sub(reader, "taskService", [board.t1]);
    const writer = await b.app.connect(as(board.ada));
    const start = performance.now();
    await accessChangesThenRename(writer, 5, "After five");
    await vi.waitFor(() => {
      expect(arrived.has("After five")).toBe(true);
    }, 5000);
    // Five access-changing flushes in a row waited one timeout between them, not five.
    expect((arrived.get("After five") ?? 0) - start).toBeLessThan(3 * TIMEOUT_MS);
    const outage = loggers.b
      .at("error")
      .filter(({ message }) => message.startsWith("A node did not answer a broadcast"));
    expect(outage).toHaveLength(1);

    // The zombie goes: the next probe is answered, and broadcasts wait for answers again.
    await closeClient(stuck);
    await vi.waitFor(() => {
      expect(loggers.b.at("info").map(({ message }) => message)).toContain(
        "Every node answers broadcasts again; access changes wait for them again",
      );
    }, 5000);
    await accessChangesThenRename(writer, 1, "Healthy again");
    await createBarrier(b.app.server.io, a.app.server.io)();
    await vi.waitFor(() => {
      expect(arrived.has("Healthy again")).toBe(true);
    }, 5000);
    expect(
      loggers.b.at("error").filter(({ message }) => message.startsWith("A node")),
    ).toHaveLength(1);
    reader.close();
    writer.close();
  });
});

describe("with Valkey down", () => {
  it("sends a node's frames to its own sockets without waiting on Valkey", async () => {
    const proxy = await startValkeyProxy();
    proxies.push(proxy);
    const { a, b } = await cluster(proxy.url);
    // The reader and the writer are both on node B: nothing needs Valkey to deliver the frame.
    const reader = await b.app.connect(as(board.cy));
    const arrived = titles(reader);
    await sub(reader, "taskService", [board.t1]);
    const writer = await b.app.connect(as(board.ada));
    await proxy.cut();
    await vi.waitFor(() => {
      expect(b.clients.some((client) => client.isReady)).toBe(false);
    }, 5000);
    const start = performance.now();
    await accessChangesThenRename(writer, 3, "Local, Valkey down");
    await vi.waitFor(() => {
      expect(arrived.has("Local, Valkey down")).toBe(true);
    }, 5000);
    // Each access-changing flush used to wait the timeout here: three of them before the rename.
    expect((arrived.get("Local, Valkey down") ?? 0) - start).toBeLessThan(TIMEOUT_MS);
    // Valkey comes back before the client's command timeout drops what waits in its queue.
    await proxy.restore();
    await vi.waitFor(() => {
      expect([...a.clients, ...b.clients].every((client) => client.isReady)).toBe(true);
    }, 10_000);
    reader.close();
    writer.close();
  });
});
