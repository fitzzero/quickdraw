// The shared flush order (pack H, child 2): behind a cluster adapter, every
// node's flushes take their revisions from one counter in Valkey, so
// revisions from two nodes are one total order; when Valkey stops
// answering, both nodes keep serving on their own clocks, say so once, and
// go back to the counter when it answers again.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createHarness, type Harness } from "../../src/prisma/__tests__/harness";
import { captureLogger, type CapturingLogger } from "../../src/server/__tests__/fixtures";
import { as, seedBoard, type Board } from "../../src/server/access/__tests__/board";
import { defineTaskService, projectService } from "../../src/server/emit/__tests__/live";
import type { FlushSink, Principal } from "../../src/server/index";
import type * as Testing from "../../src/testing/createTestApp";
import { startNode, stopNodes, type ClusterNode, type CreateTestApp } from "./nodes";
import { startValkeyProxy, type ValkeyProxy } from "./proxy";
import { closeClient, uniquePrefix, valkeyClient } from "./valkey";

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
  for (const proxy of proxies.splice(0)) {
    await proxy.restore().catch(() => undefined);
  }
  await Promise.all(running.splice(0).map(stopNodes));
});

/** One flush a node handed its sinks: which node, and the revision it carried. */
interface Flushed {
  readonly node: "A" | "B";
  readonly rev: number;
}

function recordInto(node: Flushed["node"], into: Flushed[]): FlushSink {
  return {
    flush: (_writes, info) => {
      into.push({ node, rev: info.rev });
      return Promise.resolve();
    },
  };
}

interface Cluster {
  readonly a: ClusterNode;
  readonly b: ClusterNode;
  readonly prefix: string;
  readonly flushed: Flushed[];
  readonly loggers: { readonly a: CapturingLogger; readonly b: CapturingLogger };
}

/** Two nodes on the test database behind one cluster prefix, through `url` when given. */
async function cluster(url?: string): Promise<Cluster> {
  const prefix = uniquePrefix("order");
  const flushed: Flushed[] = [];
  const loggers = { a: captureLogger(), b: captureLogger() };
  const node = (name: Flushed["node"], logger: CapturingLogger) =>
    startNode(
      createTestApp as CreateTestApp,
      {
        services: [projectService, defineTaskService()],
        db: h.db,
        logger,
        flushSink: recordInto(name, flushed),
      },
      { prefix, ...(url === undefined ? {} : { url }) },
    );
  const a = await node("A", loggers.a);
  const b = await node("B", loggers.b);
  running.push([a, b]);
  return { a, b, prefix, flushed, loggers };
}

function rename(node: ClusterNode, principal: Principal, title: string): Promise<unknown> {
  const caller = node.app.as(principal) as unknown as {
    readonly taskService: { rename(input: { id: string; title: string }): Promise<unknown> };
  };
  return caller.taskService.rename({ id: board.t1, title });
}

/** The cluster's counter, read straight from Valkey. */
async function counterOf(prefix: string): Promise<number> {
  const client = valkeyClient();
  await client.connect();
  try {
    return Number(await client.get(`${prefix}:rev`));
  } finally {
    await closeClient(client);
  }
}

function increasing(revs: readonly number[]): boolean {
  return revs.every((rev, index) => index === 0 || rev > (revs[index - 1] ?? 0));
}

describe("the shared flush order", () => {
  it("gives 1,000 flushes interleaved on two nodes strictly increasing revisions, from the counter", async () => {
    const { a, b, prefix, flushed } = await cluster();
    const ada = as(board.ada);
    for (let round = 0; round < 500; round += 1) {
      await rename(a, ada, `A ${round}`);
      await rename(b, ada, `B ${round}`);
    }
    expect(flushed).toHaveLength(1000);
    expect(flushed.map(({ node }) => node).slice(0, 4)).toEqual(["A", "B", "A", "B"]);
    const revs = flushed.map(({ rev }) => rev);
    expect(increasing(revs)).toBe(true);
    // Every revision came from the counter: it holds the last one.
    expect(await counterOf(prefix)).toBe(revs.at(-1));
  }, 60_000);

  it("keeps each node's flushes in order and every revision distinct when both flush at once", async () => {
    const { a, b, prefix, flushed } = await cluster();
    const ada = as(board.ada);
    for (let round = 0; round < 50; round += 1) {
      await Promise.all(
        Array.from({ length: 20 }, async (_, n) => {
          await rename(n % 2 === 0 ? a : b, ada, `${round}.${n}`);
        }),
      );
    }
    expect(flushed).toHaveLength(1000);
    expect(new Set(flushed.map(({ rev }) => rev)).size).toBe(1000);
    for (const node of ["A", "B"] as const) {
      expect(increasing(flushed.filter((one) => one.node === node).map(({ rev }) => rev))).toBe(
        true,
      );
    }
    expect(await counterOf(prefix)).toBe(Math.max(...flushed.map(({ rev }) => rev)));
  }, 60_000);
});

describe("with Valkey stopped mid-run", () => {
  it("keeps both nodes serving on their own clocks, logs once per node, and goes back to the counter", async () => {
    const proxy = await startValkeyProxy();
    proxies.push(proxy);
    const { a, b, prefix, flushed, loggers } = await cluster(proxy.url);
    const ada = as(board.ada);
    const both = async (round: string): Promise<void> => {
      await rename(a, ada, `A ${round}`);
      await rename(b, ada, `B ${round}`);
    };
    for (let round = 0; round < 10; round += 1) {
      await both(`before ${round}`);
    }
    const before = await counterOf(prefix);
    await proxy.cut();
    for (let round = 0; round < 20; round += 1) {
      await both(`down ${round}`);
    }
    const down = flushed.slice(20);
    expect(down).toHaveLength(40);
    for (const node of ["A", "B"] as const) {
      const revs = flushed.filter((one) => one.node === node).map(({ rev }) => rev);
      expect(increasing(revs)).toBe(true);
    }
    // Nothing reached the counter while it was down: the nodes' clocks gave the revisions.
    expect(await counterOf(prefix)).toBe(before);
    const outage = (logger: CapturingLogger) =>
      logger.at("error").filter((entry) => entry.message.startsWith("The shared revision counter"));
    expect(outage(loggers.a)).toHaveLength(1);
    expect(outage(loggers.b)).toHaveLength(1);

    await proxy.restore();
    const ready = (node: ClusterNode) =>
      node.clients.every((client) => (client as { readonly isReady: boolean }).isReady);
    await vi.waitFor(() => {
      expect(ready(a) && ready(b)).toBe(true);
    }, 10_000);
    // The counter is tried again once its retry delay passed: a flush then probes it in the
    // background, and takes its own revision from the clock without waiting.
    await new Promise((resolve) => {
      setTimeout(resolve, 1100);
    });
    const answersAgain = (logger: CapturingLogger) =>
      logger
        .at("info")
        .some(({ message }) => message === "The shared revision counter answers again");
    await both("probe");
    await vi.waitFor(() => {
      expect(answersAgain(loggers.a) && answersAgain(loggers.b)).toBe(true);
    }, 5000);
    for (let round = 0; round < 5; round += 1) {
      await both(`after ${round}`);
    }
    const after = flushed.slice(62);
    expect(increasing(after.map(({ rev }) => rev))).toBe(true);
    expect(await counterOf(prefix)).toBe(after.at(-1)?.rev);
    for (const logger of [loggers.a, loggers.b]) {
      expect(outage(logger)).toHaveLength(1);
      expect(logger.at("info").map(({ message }) => message)).toContain(
        "The shared revision counter answers again",
      );
    }
  }, 60_000);
});
