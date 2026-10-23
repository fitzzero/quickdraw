// The loopback peer link of `./testing` (RFC 0003 section 12.5): two ends in
// one process that open together, lose `fast` messages at the rate asked
// and never `rel` ones, keep `rel` in order under jitter, sync their
// clocks, close each other with `bye`, after the `rel` messages sent ahead
// of it, and take an end's `setLag` on top of the channel's own delay.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLoopbackPeerLink } from "./peer";

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "performance", "Date"],
  });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A seeded generator, so a lossy run repeats. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

describe("createLoopbackPeerLink", () => {
  it("opens both ends a microtask later, naming each other", async () => {
    const [a, b] = createLoopbackPeerLink({
      room: "party:1",
      ends: [
        { socketId: "host", userId: "ada" },
        { socketId: "guest", userId: "bo" },
      ],
    });
    const opened: string[] = [];
    a.on("open", (path) => opened.push(`a:${path}`));
    b.on("open", (path) => opened.push(`b:${path}`));
    expect([a.state, b.state]).toEqual(["connecting", "connecting"]);
    await Promise.resolve();
    expect(opened).toEqual(["a:direct", "b:direct"]);
    expect([a.room, a.peer, a.userId, b.peer, b.userId]).toEqual([
      "party:1",
      "guest",
      "bo",
      "host",
      "ada",
    ]);
  });

  it("loses fast messages at the rate asked, never rel ones, which keep their order under jitter", async () => {
    const [a, b] = createLoopbackPeerLink({ ms: 30, jitter: 40, loss: 0.3, random: seeded(7) });
    const received: [unknown, string][] = [];
    b.on("message", (data, label) => received.push([data, label]));
    await Promise.resolve();
    for (let n = 0; n < 200; n += 1) {
      a.send("rel", n);
      a.send("fast", n);
    }
    await vi.advanceTimersByTimeAsync(100);
    const rel = received.filter(([, label]) => label === "rel").map(([data]) => data);
    const fast = received.filter(([, label]) => label === "fast");
    expect(rel).toEqual(Array.from({ length: 200 }, (_, n) => n));
    expect(fast.length).toBeGreaterThan(100);
    expect(fast.length).toBeLessThan(180);
    // The channel's own losses were sent: the ends' `setLag` lost none.
    expect(a.stats).toEqual({ sent: 400, received: 0, dropped: 0, simulatedLoss: 0 });
    expect(b.stats.received).toBe(received.length);
  });

  it("delivers nothing before its delay", async () => {
    const [a, b] = createLoopbackPeerLink({ ms: 50 });
    const received: unknown[] = [];
    b.on("message", (data) => received.push(data));
    await Promise.resolve();
    a.send("rel", "hi");
    await vi.advanceTimersByTimeAsync(49);
    expect(received).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(received).toEqual(["hi"]);
  });

  it("syncs both clocks over its pings", async () => {
    const [a, b] = createLoopbackPeerLink({ ms: 20, jitter: 5, random: seeded(3) });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(600);
    expect([a.clock.synced, b.clock.synced]).toEqual([true, true]);
    expect(a.clock.rtt).toBeGreaterThanOrEqual(40);
    expect(a.clock.rtt).toBeLessThanOrEqual(50);
    expect(Math.abs(a.clock.offset)).toBeLessThanOrEqual(5);
  });

  it("closes the other end with bye, once a message would have reached it", async () => {
    const [a, b] = createLoopbackPeerLink({ ms: 10 });
    await Promise.resolve();
    const reasons: string[] = [];
    b.on("close", (reason) => reasons.push(reason));
    a.close();
    expect([a.closeReason, b.state]).toEqual(["closed", "open"]);
    await vi.advanceTimersByTimeAsync(10);
    expect(reasons).toEqual(["bye"]);
    expect(b.send("rel", 1)).toBe(false);
  });

  it("closes the other end only after the rel messages sent ahead of the close landed", async () => {
    const [a, b] = createLoopbackPeerLink({ ms: 10, jitter: 40, random: seeded(11) });
    await Promise.resolve();
    const heard: unknown[] = [];
    b.on("message", (data) => heard.push(data));
    const reasons: string[] = [];
    b.on("close", (reason) => reasons.push(reason));
    for (let n = 0; n < 20; n += 1) {
      a.send("rel", n);
    }
    a.close();
    await vi.advanceTimersByTimeAsync(10);
    expect(reasons).toEqual([]);
    await vi.advanceTimersByTimeAsync(50);
    expect(heard).toEqual(Array.from({ length: 20 }, (_, n) => n));
    expect(reasons).toEqual(["bye"]);
  });

  it("adds an end's setLag to the channel's delay, both ways", async () => {
    const [a, b] = createLoopbackPeerLink({ ms: 10 });
    await Promise.resolve();
    a.setLag({ ms: 30 });
    const atB: unknown[] = [];
    const atA: unknown[] = [];
    b.on("message", (data) => atB.push(data));
    a.on("message", (data) => atA.push(data));
    a.send("rel", "to b");
    b.send("rel", "to a");
    await vi.advanceTimersByTimeAsync(39);
    expect([atB, atA]).toEqual([[], []]);
    await vi.advanceTimersByTimeAsync(1);
    expect([atB, atA]).toEqual([["to b"], ["to a"]]);
    expect([a.lag, b.lag]).toEqual([{ ms: 30, jitter: 0, loss: 0 }, null]);
  });

  it("refuses options out of range", () => {
    expect(() => createLoopbackPeerLink({ loss: 2 })).toThrow(TypeError);
    expect(() => createLoopbackPeerLink({ ms: -1 })).toThrow(TypeError);
    expect(() => createLoopbackPeerLink({ jitter: Number.NaN })).toThrow(TypeError);
  });
});
