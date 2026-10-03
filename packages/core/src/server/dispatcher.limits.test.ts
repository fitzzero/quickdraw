// Concurrency, cancellation and the time limit (RFC 0003 section 9, steps 2
// and 7), through the dispatcher.

import { describe, expect, it, vi } from "vitest";
import {
  bob,
  deferred,
  qd,
  setup,
  task,
  taskDefaults,
  taskRow,
  tick,
  type Deferred,
} from "./__tests__/fixtures";
import { custom, type DispatchResult } from "./index";

function codeOf(result: DispatchResult): string {
  return result.ok ? "ok" : result.error.code;
}

/** A service whose `count` query and `rename` mutation wait on gates the test opens. */
function gated() {
  const gates: Deferred<number>[] = [];
  const signals: AbortSignal[] = [];
  const service = qd.defineService(task, {
    methods: {
      ...taskDefaults,
      count: {
        access: "authenticated",
        handler: ({ ctx }) => {
          const gate = deferred<number>();
          gates.push(gate);
          signals.push(ctx.signal);
          return gate.promise;
        },
      },
      rename: {
        access: "authenticated",
        handler: async ({ ctx, input }) => {
          signals.push(ctx.signal);
          await tick(20);
          return taskRow({ id: input.id, title: input.title });
        },
      },
    },
  });
  return { service, gates, signals };
}

describe("step 2: per-connection query concurrency", () => {
  it("runs 16 queries, queues the 17th to the 80th, and rejects the 81st", async () => {
    const { service, gates } = gated();
    const { call, records } = setup([service]);
    const count = (index: number) =>
      call({ method: "count", input: { projectId: `p${index}` }, connectionId: "socket-1" });
    const calls = Array.from({ length: 81 }, (_, index) => count(index));
    await tick();
    expect(gates).toHaveLength(16);
    const rejected = await calls[80];
    expect(rejected).toEqual({
      ok: false,
      error: expect.objectContaining({ code: "RATE_LIMITED" }),
    });
    expect(rejected?.ok === false && rejected.error.data).toEqual({ retryAfterMs: 1_000 });

    await tick(15);
    gates[0]?.resolve(1);
    await calls[0];
    await tick();
    expect(gates).toHaveLength(17);
    for (const gate of gates.slice(1)) {
      gate.resolve(2);
    }
    for (let started = 17; started < 80; started = gates.length) {
      await tick();
      for (const gate of gates.slice(started)) {
        gate.resolve(3);
      }
    }
    const results = await Promise.all(calls.slice(0, 80));
    expect(results.every((result) => result.ok)).toBe(true);
    const seventeenth = records.find((record) => record.queueMs > 0);
    expect(seventeenth?.queueMs).toBeGreaterThanOrEqual(10);
  });

  it("counts each connection separately, and takes its limits from the options", async () => {
    const { service, gates } = gated();
    const { call } = setup([service], {
      limits: { maxInFlightQueries: 1, maxQueuedQueries: 1, retryAfterMs: 250 },
    });
    const count = (connectionId: string) =>
      call({ method: "count", input: { projectId: "p1" }, connectionId });
    const first = count("a");
    const queued = count("a");
    const rejected = await count("a");
    expect(rejected.ok === false && [rejected.error.code, rejected.error.data]).toEqual([
      "RATE_LIMITED",
      { retryAfterMs: 250 },
    ]);
    const other = count("b");
    await tick();
    expect(gates).toHaveLength(2);
    for (const gate of gates) {
      gate.resolve(1);
    }
    await first;
    await tick();
    gates[2]?.resolve(1);
    expect((await Promise.all([queued, other])).map(codeOf)).toEqual(["ok", "ok"]);
  });

  it("keeps a cancelled query's slot until its handler settles, so cancel-and-resend never runs two at once", async () => {
    let running = 0;
    let peak = 0;
    const gates: Deferred<number>[] = [];
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        // Ignores its signal, like a database read that cannot be stopped.
        count: {
          access: "public",
          handler: async () => {
            running += 1;
            peak = Math.max(peak, running);
            const gate = deferred<number>();
            gates.push(gate);
            try {
              return await gate.promise;
            } finally {
              running -= 1;
            }
          },
        },
      },
    });
    const { call } = setup([service], { limits: { maxInFlightQueries: 1 } });
    const count = (signal?: AbortSignal) =>
      call({ method: "count", input: { projectId: "p1" }, connectionId: "a", signal });
    const outcomes: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      const controller = new AbortController();
      const pending = count(controller.signal);
      await tick();
      controller.abort();
      outcomes.push(codeOf(await pending));
    }
    // Each cancel was answered at once; only the first call's handler started.
    expect(outcomes).toEqual(["CANCELLED", "CANCELLED", "CANCELLED", "CANCELLED", "CANCELLED"]);
    expect(gates).toHaveLength(1);
    const last = count();
    await tick();
    expect(gates).toHaveLength(1);
    gates[0]?.resolve(1);
    await tick();
    expect(gates).toHaveLength(2);
    gates[1]?.resolve(2);
    expect(await last).toEqual({ ok: true, data: 2 });
    expect(peak).toBe(1);
  });

  it("never queues a mutation behind queries, and does not cap calls without a connection", async () => {
    const { service, gates } = gated();
    const { call } = setup([service], { limits: { maxInFlightQueries: 1, maxQueuedQueries: 0 } });
    const blocking = call({ method: "count", input: { projectId: "p1" }, connectionId: "a" });
    await tick();
    expect(
      codeOf(await call({ method: "count", input: { projectId: "p1" }, connectionId: "a" })),
    ).toBe("RATE_LIMITED");
    const mutation = await call({
      method: "rename",
      input: { id: "t1", title: "x" },
      connectionId: "a",
    });
    expect(mutation).toEqual({ ok: true, data: taskRow({ title: "x" }) });
    const uncapped = call({ method: "count", input: { projectId: "p1" } });
    await tick();
    expect(gates).toHaveLength(2);
    for (const gate of gates) {
      gate.resolve(1);
    }
    expect((await Promise.all([blocking, uncapped])).map(codeOf)).toEqual(["ok", "ok"]);
  });
});

describe("cancellation", () => {
  it("settles an already-aborted query with CANCELLED without running it", async () => {
    const { service, gates } = gated();
    const { call, records } = setup([service]);
    const controller = new AbortController();
    controller.abort();
    const result = await call({
      method: "count",
      input: { projectId: "p1" },
      signal: controller.signal,
    });
    expect(codeOf(result)).toBe("CANCELLED");
    expect(gates).toHaveLength(0);
    expect(records[0]).toMatchObject({ outcome: "CANCELLED", kind: "query" });
  });

  it("settles a running query at once, aborts its signal, and drops the late result", async () => {
    const { service, gates, signals } = gated();
    const { call, records, logger } = setup([service]);
    const controller = new AbortController();
    const respond = vi.fn(() => 10);
    const pending = call({
      method: "count",
      input: { projectId: "p1" },
      connectionId: "a",
      signal: controller.signal,
      respond,
    });
    await tick();
    controller.abort();
    const result = await pending;
    expect(codeOf(result)).toBe("CANCELLED");
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[0]?.reason).toMatchObject({ code: "CANCELLED" });
    gates[0]?.resolve(99);
    await tick();
    expect(respond).toHaveBeenCalledExactlyOnceWith(result);
    expect(records).toHaveLength(1);
    expect(logger.at("debug")).toHaveLength(1);
  });

  it("removes a cancelled query from the queue and frees its slot for the next", async () => {
    const { service, gates } = gated();
    const { call } = setup([service], { limits: { maxInFlightQueries: 1 } });
    const controller = new AbortController();
    const running = call({ method: "count", input: { projectId: "p1" }, connectionId: "a" });
    const cancelled = call({
      method: "count",
      input: { projectId: "p2" },
      connectionId: "a",
      signal: controller.signal,
    });
    const next = call({ method: "count", input: { projectId: "p3" }, connectionId: "a" });
    await tick();
    controller.abort();
    expect(codeOf(await cancelled)).toBe("CANCELLED");
    gates[0]?.resolve(1);
    await running;
    await tick();
    expect(gates).toHaveLength(2);
    gates[1]?.resolve(3);
    expect(await next).toEqual({ ok: true, data: 3 });
  });

  it("cancels a query while its access check is still running", async () => {
    const check = deferred<boolean>();
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        count: { access: custom(() => check.promise), handler: () => 1 },
      },
    });
    const controller = new AbortController();
    const pending = setup([service]).call({
      method: "count",
      input: { projectId: "p1" },
      signal: controller.signal,
    });
    await tick();
    controller.abort();
    expect(codeOf(await pending)).toBe("CANCELLED");
    check.resolve(true);
  });

  it("never cancels a mutation: it runs to completion and replies", async () => {
    const { service, signals } = gated();
    const controller = new AbortController();
    const pending = setup([service]).call({
      method: "rename",
      input: { id: "t1", title: "kept" },
      signal: controller.signal,
    });
    await tick();
    controller.abort();
    expect(await pending).toEqual({ ok: true, data: taskRow({ title: "kept" }) });
    expect(signals[0]?.aborted).toBe(false);
  });
});

describe("the time limit", () => {
  it("settles a slow handler with TIMEOUT once, aborts its signal and drops its late result", async () => {
    const { service, gates, signals } = gated();
    const { call, records, logger } = setup([service], { limits: { callTimeoutMs: 20 } });
    const respond = vi.fn(() => 5);
    const result = await call({ method: "count", input: { projectId: "p1" }, respond });
    expect(result.ok === false && [result.error.code, result.error.message]).toEqual([
      "TIMEOUT",
      "The call ran past its time limit of 20 ms",
    ]);
    expect(signals[0]?.reason).toMatchObject({ code: "TIMEOUT" });
    gates[0]?.resolve(1);
    await tick();
    expect(respond).toHaveBeenCalledOnce();
    expect(records.map((record) => record.outcome)).toEqual(["TIMEOUT"]);
    expect(logger.at("error")).toHaveLength(1);
  });

  it("uses the method's own timeoutMs, and frees the slot once the aborted handler settles", async () => {
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        count: {
          access: "public",
          timeoutMs: 15,
          handler: ({ ctx }) =>
            new Promise<number>((_resolve, reject) => {
              ctx.signal.addEventListener("abort", () => {
                reject(ctx.signal.reason as Error);
              });
            }),
        },
        get: { access: "public", handler: () => taskRow() },
      },
    });
    const { call } = setup([service], { limits: { maxInFlightQueries: 1 } });
    const slow = call({ method: "count", input: { projectId: "p1" }, connectionId: "a" });
    const next = call({ method: "get", input: { id: "t1" }, connectionId: "a" });
    expect(codeOf(await slow)).toBe("TIMEOUT");
    expect(await next).toEqual({ ok: true, data: taskRow() });
  });

  it("keeps a timed-out query's slot until its handler settles, and starts the next one's clock then", async () => {
    const { service, gates } = gated();
    const { call } = setup([service], { limits: { maxInFlightQueries: 1, callTimeoutMs: 15 } });
    const slow = call({ method: "count", input: { projectId: "p1" }, connectionId: "a" });
    const next = call({ method: "count", input: { projectId: "p2" }, connectionId: "a" });
    expect(codeOf(await slow)).toBe("TIMEOUT");
    // `count` ignores its signal, so its handler is still running: the next
    // query waits for the slot, past its own time limit, which has not started.
    await tick(25);
    expect(gates).toHaveLength(1);
    gates[0]?.resolve(1);
    await tick();
    expect(gates).toHaveLength(2);
    gates[1]?.resolve(2);
    expect(await next).toEqual({ ok: true, data: 2 });
  });

  it("covers the access check and version(), not the handler alone, and settles the caller once", async () => {
    const checks: AbortSignal[] = [];
    const handler = vi.fn(() => taskRow());
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        rename: {
          // A slow row lookup.
          access: custom((ctx) => {
            checks.push(ctx.signal);
            return tick(60).then(() => true);
          }),
          handler,
        },
        count: {
          access: "public",
          version: () => deferred<string>().promise,
          handler: () => 1,
        },
      },
    });
    const respond = vi.fn(() => 0);
    const { call, records } = setup([service], { limits: { callTimeoutMs: 20 } });
    const renamed = await call({ method: "rename", input: { id: "t1", title: "x" }, respond });
    expect(renamed.ok === false && [renamed.error.code, renamed.error.message]).toEqual([
      "TIMEOUT",
      "The call ran past its time limit of 20 ms",
    ]);
    expect(checks[0]?.reason).toMatchObject({ code: "TIMEOUT" });
    expect(codeOf(await call({ method: "count", input: { projectId: "p1" } }))).toBe("TIMEOUT");
    // The access check passes after the call was answered; nothing else runs.
    await tick(60);
    expect(handler).not.toHaveBeenCalled();
    expect(respond).toHaveBeenCalledExactlyOnceWith(renamed);
    expect(records.map((record) => record.outcome)).toEqual(["TIMEOUT", "TIMEOUT"]);
  });

  it("times out a mutation too, without waiting for it", async () => {
    const service = qd.defineService(task, {
      methods: {
        ...taskDefaults,
        rename: {
          access: "authenticated",
          timeoutMs: 10,
          handler: () => tick(50).then(() => taskRow()),
        },
      },
    });
    const { call } = setup([service]);
    expect(
      codeOf(await call({ method: "rename", input: { id: "t1", title: "x" }, principal: bob })),
    ).toBe("TIMEOUT");
  });
});
