// `call` against a real server (RFC 0003 sections 8.2, 9 and 11.2): data and
// not-modified replies, every error code as a `QuickdrawError`, cancellation
// with `qd:cancel`, time limits, dropped connections and the per-kind
// rate-limit backoff.

import { describe, expect, it } from "vitest";
import { ERROR_CODES, QuickdrawError } from "../index";
import { call, callData, isNotModified, shouldRetry } from "./call";
import { clientHarness, outgoing, until, whenStatus } from "./__tests__/fixtures";

const harness = clientHarness();

async function failure(pending: Promise<unknown>): Promise<QuickdrawError> {
  const error: unknown = await pending.then(
    () => {
      throw new Error("the call succeeded");
    },
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(QuickdrawError);
  return error as QuickdrawError;
}

describe("call", () => {
  it("calls a method and resolves with its reply", async () => {
    const { app } = await harness.start();
    const connection = await harness.connect(app.url);
    expect(
      await call(connection, { service: "probeService", method: "echo", input: { text: "hi" } }),
    ).toEqual({
      ok: true,
      d: { text: "hi", userId: "alice", transport: "socket", grants: null },
    });
    expect(await callData(connection, { service: "counterService", method: "total" })).toBe(0);
  });

  it.each(ERROR_CODES)("rejects with a QuickdrawError whose code is %s", async (code) => {
    const { app } = await harness.start();
    const connection = await harness.connect(app.url);
    const error = await failure(
      call(connection, { service: "probeService", method: "fail", input: { code } }),
    );
    expect(error.code).toBe(code);
    expect(error.message).toBe(code === "INTERNAL" ? "Internal error" : `Failed with ${code}`);
  });

  it("answers not modified while the version it sends is current", async () => {
    const { app, counter, records } = await harness.start();
    const connection = await harness.connect(app.url);
    const read = { service: "counterService", method: "read", input: { name: "a" } };
    const first = await call(connection, read);
    expect(first).toEqual({ ok: true, d: { name: "a", value: 0 }, v: "a@0" });
    const second = await call(connection, { ...read, v: "a@0" });
    expect(second).toEqual({ ok: true, nm: true, v: "a@0" });
    expect(isNotModified(second)).toBe(true);
    counter.values.set("a", 4);
    expect(await call(connection, { ...read, v: "a@0" })).toEqual({
      ok: true,
      d: { name: "a", value: 4 },
      v: "a@4",
    });
    expect(records.map((record) => record.outcome)).toEqual(["ok", "not-modified", "ok"]);
  });

  it("sends qd:cancel when its signal aborts, and the handler sees the abort", async () => {
    const { app, probe } = await harness.start();
    const connection = await harness.connect(app.url);
    const sent = outgoing(connection);
    const controller = new AbortController();
    const pending = call(connection, {
      service: "probeService",
      method: "wait",
      input: { key: "k" },
      signal: controller.signal,
    });
    await until(() => probe.signals.has("k"));
    controller.abort();
    expect((await failure(pending)).code).toBe("CANCELLED");
    await until(() => probe.signals.get("k")?.aborted === true);
    expect(sent.map(([event]) => event)).toEqual(["qd:call", "qd:cancel"]);
    const [[, envelope], [, cancel]] = sent as [
      [string, { readonly id: number }],
      [string, unknown],
    ];
    expect(cancel).toEqual({ id: envelope.id });
  });

  it("rejects an aborted call before sending it, and drops a buffered one unsent", async () => {
    const { app, probe, records } = await harness.start();
    const connection = harness.connection(app.url);
    const sent = outgoing(connection);
    const early = call(connection, {
      service: "probeService",
      method: "echo",
      input: { text: "x" },
      signal: AbortSignal.abort(),
    });
    expect((await failure(early)).code).toBe("CANCELLED");
    connection.open();
    const controller = new AbortController();
    const buffered = call(connection, {
      service: "probeService",
      method: "wait",
      input: { key: "buffered" },
      signal: controller.signal,
    });
    expect(connection.socket.sendBuffer).toHaveLength(1);
    controller.abort();
    expect((await failure(buffered)).code).toBe("CANCELLED");
    expect(connection.socket.sendBuffer).toHaveLength(0);
    await whenStatus(connection, "connected");
    expect(await callData(connection, { service: "counterService", method: "total" })).toBe(0);
    expect(probe.signals.has("buffered")).toBe(false);
    expect(sent.map(([event]) => event)).toEqual(["qd:call"]);
    expect(records.map((record) => record.method)).toEqual(["total"]);
  });

  it("rejects with TIMEOUT after its time limit, once, and is not retried", async () => {
    const { app, probe, records } = await harness.start();
    const connection = await harness.connect(app.url);
    const error = await failure(
      call(connection, {
        service: "probeService",
        method: "wait",
        input: { key: "slow" },
        timeoutMs: 50,
      }),
    );
    expect(error).toMatchObject({ code: "TIMEOUT", message: "No answer within 50 ms" });
    expect(shouldRetry(0, error)).toBe(false);
    probe.gates.get("slow")?.resolve("late");
    await until(() => records.length === 1);
    expect(records.map((record) => [record.method, record.outcome])).toEqual([["wait", "ok"]]);
  });

  it("refuses a time limit a timer cannot honor, and sends nothing", async () => {
    const { app } = await harness.start();
    const connection = await harness.connect(app.url);
    const sent = outgoing(connection);
    for (const timeoutMs of [0, Number.POSITIVE_INFINITY, 2 ** 31]) {
      await expect(
        call(connection, { service: "counterService", method: "total", timeoutMs }),
      ).rejects.toThrow("call: timeoutMs must be a number of milliseconds");
    }
    expect(sent).toEqual([]);
  });

  it("rejects with INTERNAL when the connection is not open, or drops before the answer", async () => {
    const { app, probe } = await harness.start();
    const idle = harness.connection(app.url);
    const notOpen = await failure(call(idle, { service: "counterService", method: "total" }));
    expect(notOpen).toMatchObject({ code: "INTERNAL", message: "Not connected to the server" });
    const connection = await harness.connect(app.url);
    const pending = call(connection, {
      service: "probeService",
      method: "wait",
      input: { key: "dropped" },
    });
    await until(() => probe.signals.has("dropped"));
    connection.socket.io.engine.close();
    const dropped = await failure(pending);
    expect(dropped).toMatchObject({
      code: "INTERNAL",
      message: "No answer: the connection to the server is down",
    });
    expect(shouldRetry(0, dropped)).toBe(true);
    await whenStatus(connection, "connected");
    expect(await callData(connection, { service: "counterService", method: "total" })).toBe(0);
  });

  it("backs off the call's kind after RATE_LIMITED, for a different time on each client", async () => {
    const { app, records } = await harness.start();
    const first = await harness.connect(app.url);
    const second = await harness.connect(app.url);
    const limited = { service: "probeService", method: "fail", input: { code: "RATE_LIMITED" } };
    for (const connection of [first, second]) {
      const error = await failure(call(connection, limited));
      expect(error.data).toEqual({ retryAfterMs: 1500 });
    }
    const [one, two] = [first, second].map((connection) => connection.backoffRemaining("query"));
    for (const remaining of [one, two]) {
      expect(remaining).toBeGreaterThan(1400);
      expect(remaining).toBeLessThanOrEqual(2250);
    }
    expect(one).not.toBe(two);
    expect(first.getState().backoff).toEqual({ query: expect.any(Number) });
    expect(first.backoffRemaining("mutation")).toBe(0);

    const held = await failure(
      call(first, { service: "probeService", method: "echo", input: { text: "x" } }),
    );
    expect(held.code).toBe("RATE_LIMITED");
    expect((held.data as { readonly retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    expect(
      await callData(first, {
        service: "counterService",
        method: "bump",
        input: { name: "a" },
        kind: "mutation",
      }),
    ).toEqual({ name: "a", value: 1 });
    expect(records.map((record) => record.method)).toEqual(["fail", "fail", "bump"]);
  });
});

describe("shouldRetry", () => {
  it("retries once after INTERNAL or an error that is not a QuickdrawError, never after another code", () => {
    const internal = new QuickdrawError("INTERNAL", "x");
    expect(shouldRetry(0, internal)).toBe(true);
    expect(shouldRetry(1, internal)).toBe(false);
    expect(shouldRetry(0, new TypeError("x"))).toBe(true);
    for (const code of ERROR_CODES.filter((each) => each !== "INTERNAL")) {
      expect(shouldRetry(0, new QuickdrawError(code, "x"))).toBe(false);
    }
  });
});
