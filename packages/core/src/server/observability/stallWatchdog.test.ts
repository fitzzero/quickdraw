// The event-loop stall watchdog (`stallWatchdog.ts`, `createServer({ stallWatchdog })`):
// a window whose 99th percentile delay is over the threshold is reported
// with its slowest methods; an idle loop reports nothing. An idle window is
// judged by its median delay: on a busy test machine one slow tick can land
// in any short window, and over a few samples the 99th percentile is that tick.

import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract, query } from "../../index";
import { captureLogger } from "../__tests__/fixtures";
import { createServer } from "../createServer";
import { initQuickdraw } from "../init";
import type { CallRecord } from "../pipeline/metrics";
import {
  DEFAULT_STALL_INTERVAL_MS,
  DEFAULT_STALL_THRESHOLD_MS,
  stallWatchdogSettings,
  startStallWatchdog,
  type StallWatchdog,
} from "./stallWatchdog";

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** Blocks the event loop for `ms` milliseconds, as a synchronous computation would. */
function block(ms: number): void {
  const until = performance.now() + ms;
  while (performance.now() < until) {
    // Spin: nothing else runs meanwhile.
  }
}

function record(method: string, durationMs: number): CallRecord {
  return {
    service: "taskService",
    method,
    kind: "query",
    transport: "socket",
    requestId: method,
    outcome: "ok",
    durationMs,
    queueMs: 0,
    bytes: 10,
    shared: false,
    sqlStatements: 1,
  };
}

const running: StallWatchdog[] = [];

afterEach(() => {
  for (const watchdog of running.splice(0)) {
    watchdog.stop();
  }
});

function start(thresholdMs = DEFAULT_STALL_THRESHOLD_MS) {
  const logger = captureLogger();
  const settings = stallWatchdogSettings({ thresholdMs, slowest: 2 });
  if (settings === undefined) {
    throw new Error("the watchdog is on");
  }
  const watchdog = startStallWatchdog(settings, logger);
  running.push(watchdog);
  return { watchdog, logger };
}

describe("the stall watchdog", () => {
  it("reports a window whose 99th percentile delay is over the threshold, naming its slowest methods", async () => {
    const { watchdog, logger } = start();
    await wait(60);
    watchdog.observe(record("list", 12));
    watchdog.observe(record("search", 310));
    watchdog.observe(record("list", 40));
    watchdog.observe(record("get", 3));
    // A method the client named that does not exist is never a key.
    watchdog.observe({ ...record("noSuchMethod", 900), kind: undefined });
    block(300);
    await wait(40);
    const report = watchdog.check();
    expect(report.stalled).toBe(true);
    expect(report.p99Ms).toBeGreaterThan(DEFAULT_STALL_THRESHOLD_MS);
    expect(report.slowest).toEqual([
      { method: "taskService.search", calls: 1, maxMs: 310, meanMs: 310 },
      { method: "taskService.list", calls: 2, maxMs: 40, meanMs: 26 },
    ]);
    const warnings = logger.at("warn");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toMatch(
      /^The event loop stalled: its 99th percentile delay was \d+(\.\d)? ms over the last \d+ ms \(threshold 200 ms\)$/,
    );
    expect(warnings[0]?.meta).toMatchObject({
      category: "quickdraw.stall",
      thresholdMs: 200,
      slowest: report.slowest,
    });
    // The window starts over: an idle one after it has no calls and a short delay.
    await wait(100);
    const idle = watchdog.check();
    expect(idle.slowest).toEqual([]);
    expect(idle.p50Ms).toBeLessThan(DEFAULT_STALL_THRESHOLD_MS);
    expect(logger.at("warn")).toHaveLength(idle.stalled ? 2 : 1);
  });

  it("reports nothing for an idle loop", async () => {
    const { watchdog, logger } = start();
    await wait(500);
    const report = watchdog.check();
    // The median, not the 99th percentile: a slow tick of a busy machine is not the loop's delay.
    expect(report.p50Ms).toBeLessThan(DEFAULT_STALL_THRESHOLD_MS);
    expect(report.p50Ms).toBeLessThanOrEqual(report.p99Ms);
    expect(report.stalled).toBe(report.p99Ms > DEFAULT_STALL_THRESHOLD_MS);
    expect(logger.entries).toHaveLength(report.stalled ? 1 : 0);
  });

  it("checks its options, and is off unless asked", () => {
    expect(stallWatchdogSettings(undefined)).toBeUndefined();
    expect(stallWatchdogSettings(false)).toBeUndefined();
    expect(stallWatchdogSettings(true)).toEqual({
      thresholdMs: DEFAULT_STALL_THRESHOLD_MS,
      intervalMs: DEFAULT_STALL_INTERVAL_MS,
      slowest: 5,
    });
    expect(() => stallWatchdogSettings({ intervalMs: 500 })).toThrow(
      "createServer: stallWatchdog.intervalMs must be a whole number of milliseconds, at least 1000",
    );
    expect(() => stallWatchdogSettings({ thresholdMs: 0 })).toThrow(
      "createServer: stallWatchdog.thresholdMs must be a positive number of milliseconds",
    );
    expect(() => stallWatchdogSettings({ slowest: -1 })).toThrow(
      "createServer: stallWatchdog.slowest must be a whole number, 0 or more",
    );
  });
});

const qd = initQuickdraw();
const busy = defineContract("busyService", {
  methods: { spin: query({ input: z.object({ ms: z.number() }), output: z.null() }) },
});
const busyService = qd.defineService(busy, {
  methods: {
    spin: {
      access: "public",
      handler: ({ input }) => {
        block(input.ms);
        return null;
      },
    },
  },
});

describe("createServer({ stallWatchdog })", () => {
  it("warns about a window with a 300 ms block, names the blocking method, and stops on close", async () => {
    const logger = captureLogger();
    const records: string[] = [];
    const server = createServer({
      services: [busyService],
      http: false,
      logger,
      onCall: (call) => records.push(call.method),
      stallWatchdog: { intervalMs: 1_000 },
    });
    const stalls = () =>
      logger.at("warn").filter((entry) => entry.meta?.category === "quickdraw.stall");
    // The warning about the block names the method that blocked; a slow tick
    // of a busy machine may have warned about an earlier window, with no calls.
    const naming = () =>
      stalls().filter(
        (entry) => Array.isArray(entry.meta?.slowest) && entry.meta.slowest.length > 0,
      );
    try {
      // A first window, idle, before the block.
      await wait(1_100);
      await server.dispatcher.caller(null).busyService.spin({ ms: 300 });
      expect(records).toEqual(["spin"]);
      await vi.waitFor(() => expect(naming()).toHaveLength(1), { timeout: 2_000, interval: 50 });
      expect(naming()[0]?.meta?.slowest).toEqual([
        {
          method: "busyService.spin",
          calls: 1,
          maxMs: expect.any(Number),
          meanMs: expect.any(Number),
        },
      ]);
    } finally {
      await server.close();
    }
    // Stopped on close: another block warns about nothing.
    const before = stalls().length;
    block(300);
    await wait(1_100);
    expect(stalls()).toHaveLength(before);
  }, 10_000);
});
