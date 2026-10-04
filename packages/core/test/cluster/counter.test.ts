// The shared revision counter against a real Valkey (the pack H finale
// review): it keeps to Valkey's clock in microseconds through a burst, so
// revisions stay comparable with `versionColumn` times; losing its key
// (eviction, a restart or failover without persistence) never sends
// revisions backwards, and the node that sees it gone says so; and a read
// made while the key is gone claims the clock, never 0.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyEntityFrame, type EntityEntry } from "../../src/client/live/entities";
import type { EntityFrame, EntityResult } from "../../src/index";
import { createHarness, type Harness } from "../../src/prisma/__tests__/harness";
import { captureLogger, type CapturingLogger } from "../../src/server/__tests__/fixtures";
import { as, seedBoard, type Board } from "../../src/server/access/__tests__/board";
import { createSharedCounter } from "../../src/server/cluster/counter";
import {
  defineTaskService,
  projectService,
  receive,
  sub,
} from "../../src/server/emit/__tests__/live";
import type * as Testing from "../../src/testing/createTestApp";
import { createBarrier, startNode, stopNodes, type ClusterNode, type CreateTestApp } from "./nodes";
import { closeClient, uniquePrefix, valkeyClient, type ValkeyClient } from "./valkey";

// The single-server `createTestApp`: these tests boot each node themselves.
const { createTestApp } = await vi.importActual<typeof Testing>("../../src/testing/createTestApp");

let h: Harness;
let board: Board;
const running: ClusterNode[][] = [];
const clients: ValkeyClient[] = [];

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
  await Promise.all(clients.splice(0).map(closeClient));
});

async function raw(): Promise<ValkeyClient> {
  const client = valkeyClient();
  await client.connect();
  clients.push(client);
  return client;
}

/** Valkey's clock, in microseconds. */
async function valkeyMicros(client: ValkeyClient): Promise<number> {
  const [seconds, micros] = (await client.sendCommand(["TIME"])) as [string, string];
  return Number(seconds) * 1_000_000 + Number(micros);
}

/** `count` revisions taken at once from the counter at `key`, as other nodes' flushes would. */
async function burst(key: string, count: number): Promise<number> {
  const elsewhere = createSharedCounter({ client: await raw(), key, logger: captureLogger() });
  const revs = await Promise.all(Array.from({ length: count }, () => elsewhere.next(0)));
  expect(revs.every((rev) => typeof rev === "number")).toBe(true);
  expect(new Set(revs).size).toBe(count);
  return Math.max(...(revs as number[]));
}

async function cluster(options: { readonly versionColumn?: "updatedAt" } = {}) {
  const prefix = uniquePrefix("counter");
  const loggers = { a: captureLogger(), b: captureLogger() };
  const node = (logger: CapturingLogger) =>
    startNode(
      createTestApp as CreateTestApp,
      { services: [projectService, defineTaskService(options)], db: h.db, logger },
      { prefix },
    );
  const a = await node(loggers.a);
  const b = await node(loggers.b);
  running.push([a, b]);
  return { a, b, key: `${prefix}:rev`, loggers };
}

type Rename = {
  readonly taskService: { rename(input: { id: string; title: string }): Promise<null> };
};

function rename(node: ClusterNode, title: string): Promise<null> {
  return (node.app.as(as(board.ada)) as unknown as Rename).taskService.rename({
    id: board.t1,
    title,
  });
}

describe("the counter against Valkey's clock", () => {
  it("stays within a few microseconds of it through 5,000 flushes at once", async () => {
    const key = `${uniquePrefix("counter")}:rev`;
    const probe = await raw();
    const before = await valkeyMicros(probe);
    const last = await burst(key, 5000);
    const after = await valkeyMicros(probe);
    expect(last).toBeGreaterThan(before);
    // One flush per microsecond keeps it on the clock: it ran ahead by at most a few.
    expect(last - after).toBeLessThanOrEqual(5);
    expect(Number(await probe.get(key))).toBe(last);
  }, 30_000);
});

describe("a lost counter key", () => {
  it("never sends revisions backwards: the next flush takes the clock, above every one issued", async () => {
    const { a, b, key, loggers } = await cluster();
    const reader = await a.app.connect(as(board.cy));
    const frames = receive(reader);
    await sub(reader, "taskService", [board.t1]);
    // Both nodes take revisions from the counter, and a burst elsewhere moves it on.
    await rename(a, "A1");
    await rename(b, "B1");
    await createBarrier(b.app.server.io, a.app.server.io)();
    const issued = await burst(key, 5000);
    await rename(a, "A2 (older)");
    // The key is lost: evicted, flushed, or Valkey restarted or failed over without it.
    const probe = await raw();
    await probe.del(key);
    await rename(b, "B2 (newer)");
    await createBarrier(b.app.server.io, a.app.server.io)();
    await frames.settle();
    const revs = frames.entity.map((frame) => frame.rev);
    expect(revs).toHaveLength(4);
    expect(revs.every((rev, index) => index === 0 || rev > (revs[index - 1] ?? 0))).toBe(true);
    expect(revs[3]).toBeGreaterThan(Math.max(issued, revs[2] ?? 0));
    let entry: EntityEntry<unknown> | undefined;
    for (const frame of frames.entity as EntityFrame[]) {
      entry = applyEntityFrame(entry, frame).entry;
    }
    expect(entry?.data).toMatchObject({ title: "B2 (newer)" });
    // Node B had seen the key: it says it was lost, once.
    expect(loggers.b.at("warn").map(({ message }) => message)).toEqual([
      "The revision counter key was lost; configure persistence or replication for it",
    ]);
    expect(loggers.a.at("warn")).toEqual([]);
  });

  it("has a read made while it is gone claim the clock, never 0", async () => {
    const { a, key } = await cluster();
    const probe = await raw();
    await rename(a, "Seen");
    await probe.del(key);
    const fresh = await a.app.connect(as(board.di));
    const before = Date.now() * 1000;
    const reply = (await sub(fresh, "taskService", [board.t1])) as {
      readonly r: readonly (EntityResult & { readonly rev: number })[];
    };
    expect(reply.r[0]?.rev).toBeGreaterThanOrEqual(before);
  });
});

describe("versionColumn behind the counter", () => {
  it("answers not modified only while the row is unchanged, after a burst", async () => {
    const { a, b, key } = await cluster({ versionColumn: "updatedAt" });
    await burst(key, 5000);
    const first = await a.app.connect(as(board.cy));
    const read = (await sub(first, "taskService", [board.t1])) as {
      readonly r: readonly (EntityResult & { readonly rev: number })[];
    };
    const held = read.r[0]?.rev ?? 0;
    first.close();
    // Unchanged: not modified.
    const same = await a.app.connect(as(board.cy));
    expect(await sub(same, "taskService", [board.t1], [held])).toMatchObject({
      r: [{ ok: true, nm: true }],
    });
    same.close();
    // Changed on node B while the client was away: the row comes again.
    await b.app.server.dispatcher.run(() =>
      h.db.task.update({ where: { id: board.t1 }, data: { title: "Changed while away" } }),
    );
    await createBarrier(b.app.server.io, a.app.server.io)();
    const again = await a.app.connect(as(board.cy));
    expect(await sub(again, "taskService", [board.t1], [held])).toMatchObject({
      r: [{ ok: true, d: { title: "Changed while away" } }],
    });
  }, 30_000);
});
