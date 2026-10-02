// Unit tests of the pipeline's building blocks: the concurrency limiter, the
// share keys and table, the handler run, and issue conversion.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { QuickdrawError } from "../../protocol/errors";
import { deferred, tick } from "../__tests__/fixtures";
import { untrackedUnitOfWork } from "../uow/untracked";
import type { UnitOfWorkScope } from "../uow/types";
import { createConcurrencyLimiter } from "./concurrency";
import { toQuickdrawError } from "./errors";
import { startRun, type Outcome } from "./run";
import { createShareTable, deepFreeze, shareKey, stableStringify } from "./share";
import { outputIssues, parseInput, toWireIssues } from "./validation";

describe("createConcurrencyLimiter", () => {
  it("hands out slots per connection, queues in order and rejects past the queue", async () => {
    const limiter = createConcurrencyLimiter({ maxInFlight: 2, maxQueued: 1, retryAfterMs: 50 });
    const first = await limiter.acquire("a");
    const second = await limiter.acquire("a");
    const queued = limiter.acquire("a");
    await expect(limiter.acquire("a")).rejects.toMatchObject({
      code: "RATE_LIMITED",
      data: { retryAfterMs: 50 },
    });
    const other = await limiter.acquire("b");
    expect(limiter.connections).toBe(2);
    await tick(5);
    first.release();
    first.release();
    const third = await queued;
    expect(third.queueMs).toBeGreaterThan(0);
    for (const slot of [second, third, other]) {
      slot.release();
    }
    expect(limiter.connections).toBe(0);
  });

  it("rejects a waiter whose signal aborts, and an already-aborted signal at once", async () => {
    const limiter = createConcurrencyLimiter({ maxInFlight: 1, maxQueued: 2, retryAfterMs: 1 });
    const held = await limiter.acquire("a");
    const controller = new AbortController();
    const waiting = limiter.acquire("a", controller.signal);
    const next = limiter.acquire("a");
    controller.abort();
    await expect(waiting).rejects.toMatchObject({ code: "CANCELLED" });
    held.release();
    (await next).release();
    expect(limiter.connections).toBe(0);
    await expect(limiter.acquire("a", controller.signal)).rejects.toMatchObject({
      code: "CANCELLED",
    });
    expect(limiter.connections).toBe(0);
  });
});

describe("share keys", () => {
  it("serializes with sorted keys, following JSON", () => {
    expect(stableStringify({ b: 1, a: [true, null, "x"], c: undefined })).toBe(
      '{"a":[true,null,"x"],"b":1}',
    );
    expect(stableStringify({ a: { d: 1, c: 2 } })).toBe(stableStringify({ a: { c: 2, d: 1 } }));
    expect(stableStringify([undefined, () => 1])).toBe("[null,null]");
    expect(stableStringify(new Date("2026-10-02T00:00:00.000Z"))).toBe(
      '"2026-10-02T00:00:00.000Z"',
    );
    expect(stableStringify(10n)).toBe("10n");
    expect(stableStringify(Number.NaN)).toBe("NaN");
    expect(stableStringify(Object.assign(Object.create(null) as object, { z: 1 }))).toBe('{"z":1}');
  });

  it("refuses values it cannot key safely", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(stableStringify(cycle)).toBeUndefined();
    expect(stableStringify({ tags: new Set(["a"]) })).toBeUndefined();
    expect(stableStringify(new Map())).toBeUndefined();
    const shared = { a: 1 };
    expect(stableStringify([shared, shared])).toBe('[{"a":1},{"a":1}]');
  });

  it("keys by service, method, principal (or *) and input", () => {
    const alice = { userId: "alice" };
    const key = shareKey("taskService", "list", alice, { b: 2, a: 1 });
    expect(key).toBe(shareKey("taskService", "list", { userId: "alice" }, { a: 1, b: 2 }));
    expect(key).not.toBe(shareKey("taskService", "list", { userId: "bob" }, { a: 1, b: 2 }));
    expect(key).not.toBe(
      shareKey("taskService", "list", { ...alice, claims: { scope: "read" } }, { a: 1, b: 2 }),
    );
    expect(shareKey("s", "m", "*", 1)).toBe(JSON.stringify(["s", "m", "*", "1"]));
    expect(shareKey("s", "m", null, 1)).not.toBe(shareKey("s", "m", "*", 1));
    expect(shareKey("s", "m", alice, new Map())).toBeUndefined();
  });

  it("deep-freezes plain objects and arrays only", () => {
    const date = new Date();
    const value = deepFreeze({ list: [{ id: "a" }], at: date });
    expect(Object.isFrozen(value.list[0])).toBe(true);
    expect(Object.isFrozen(date)).toBe(false);
    expect(deepFreeze(3)).toBe(3);
  });

  it("drops a failed entry at once and a successful one after its ttlMs", async () => {
    const table = createShareTable<{ outcome: Promise<{ ok: boolean }> }>();
    const failed = { outcome: Promise.resolve({ ok: false }) };
    const kept = { outcome: Promise.resolve({ ok: true }) };
    const once = { outcome: Promise.resolve({ ok: true }) };
    table.add("failed", failed, 1_000);
    table.add("kept", kept, 20);
    table.add("once", once, undefined);
    expect(table.size).toBe(3);
    await tick();
    expect([table.get("failed"), table.get("kept"), table.get("once")]).toEqual([
      undefined,
      kept,
      undefined,
    ]);
    await tick(30);
    expect(table.size).toBe(0);
  });
});

describe("startRun", () => {
  const unit = untrackedUnitOfWork.begin({} as UnitOfWorkScope);
  const accept = (value: unknown): Promise<Outcome> => Promise.resolve({ ok: true, value });

  it("settles every caller exactly once and drops a result that arrives after the time limit", async () => {
    const gate = deferred<number>();
    const run = startRun({ timeoutMs: 10, unit, invoke: () => gate.promise, accept });
    const outcomes = await Promise.all([
      run.join(undefined),
      run.join(new AbortController().signal),
    ]);
    expect(outcomes.map((outcome) => !outcome.ok && outcome.error.code)).toEqual([
      "TIMEOUT",
      "TIMEOUT",
    ]);
    expect(run.handlerSettled).toBe(false);
    gate.resolve(1);
    await run.handlerDone;
    expect(run.handlerSettled).toBe(true);
    expect(run.settled).toEqual(outcomes[0]);
  });

  it("aborts the handler only when every caller has left", async () => {
    let signal: AbortSignal | undefined;
    const run = startRun({
      timeoutMs: 1_000,
      unit,
      invoke: (runSignal) => {
        signal = runSignal;
        return deferred().promise;
      },
      accept,
    });
    const first = new AbortController();
    const second = new AbortController();
    const joined = [run.join(first.signal), run.join(second.signal)];
    first.abort();
    expect(await joined[0]).toMatchObject({ ok: false });
    expect(signal?.aborted).toBe(false);
    second.abort();
    await joined[1];
    expect(signal?.aborted).toBe(true);
    expect(run.settled).toMatchObject({ ok: false, error: { code: "CANCELLED" } });
    const aborted = new AbortController();
    aborted.abort();
    expect(await run.join(aborted.signal)).toMatchObject({
      ok: false,
      error: { code: "CANCELLED" },
    });
  });

  it("turns a throwing handler, unit or accept into an outcome, never a rejection", async () => {
    const throwing = startRun({
      timeoutMs: 1_000,
      unit,
      invoke: () => {
        throw new QuickdrawError("CONFLICT", "taken");
      },
      accept,
    });
    expect(await throwing.outcome).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    const brokenUnit = startRun({
      timeoutMs: 1_000,
      unit: {
        ...unit,
        run: () => {
          throw new Error("unit failed");
        },
      },
      invoke: () => 1,
      accept,
    });
    expect(await brokenUnit.outcome).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    const brokenAccept = startRun({
      timeoutMs: 1_000,
      unit,
      invoke: () => 1,
      accept: () => Promise.reject(new Error("schema threw")),
    });
    expect(await brokenAccept.outcome).toMatchObject({ ok: false, error: { code: "INTERNAL" } });
    await brokenAccept.handlerDone;
  });

  it("stops the clock once the handler settles, while its result is checked", async () => {
    const check = deferred<Outcome>();
    const run = startRun({ timeoutMs: 5, unit, invoke: () => 1, accept: () => check.promise });
    await tick(20);
    check.resolve({ ok: true, value: 1 });
    expect(await run.outcome).toEqual({ ok: true, value: 1 });
  });
});

describe("issues and errors", () => {
  it("converts Standard Schema issues to the wire shape", () => {
    const symbol = Symbol("secret");
    expect(
      toWireIssues([
        { message: "bad", path: ["items", 0, { key: "name" }] },
        { message: "worse", path: [symbol, { key: Symbol.for("k") }] },
        { message: "root" },
      ]),
    ).toEqual([
      { path: ["items", 0, "name"], message: "bad" },
      { path: ["secret", "k"], message: "worse" },
      { path: [], message: "root" },
    ]);
  });

  it("parses input and reports output issues", async () => {
    const schema = z.object({ n: z.number().default(1) });
    expect(await parseInput(schema, {}, "s.m")).toEqual({ n: 1 });
    await expect(parseInput(schema, { n: "x" }, "s.m")).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["n"] }] },
    });
    expect(await outputIssues(schema, { n: 2 })).toBeUndefined();
    expect(await outputIssues(schema, { n: "2" })).toEqual([
      { path: ["n"], message: expect.any(String) },
    ]);
  });

  it("keeps a QuickdrawError and wraps anything else as INTERNAL with its cause", () => {
    const known = new QuickdrawError("FORBIDDEN", "no");
    expect(toQuickdrawError(known)).toBe(known);
    const wrapped = toQuickdrawError("a string");
    expect([wrapped.code, wrapped.message, wrapped.cause]).toEqual([
      "INTERNAL",
      "Internal error",
      "a string",
    ]);
  });
});
