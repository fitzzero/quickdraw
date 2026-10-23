// The lag queue a peer link holds its messages on (`lag.ts`, RFC 0003
// section 12.5), on fake timers with a seeded random: `rel` messages keep
// their order whatever their jitter, arrive no sooner than their delay and
// are never lost; `fast` ones are lost at the share asked; a `rel` message
// its path refused waits, with the ones after it, and goes again; `set(null)`
// lets what is held go on the next task, in the order it was pushed; and
// `close()` drops it. `link.test.ts` runs the lag on links, and
// `../../testing/peer.test.ts` the loopback double, which carries its
// messages on these queues.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkLag, createLagQueue, LAG_RETRY_MS } from "./lag";
import { seeded } from "./__tests__/seeded";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

const lag = (ms: number, jitter = 0, loss = 0) => checkLag({ ms, jitter, loss }, "test");

describe("a lag queue", () => {
  it("keeps rel messages in order when the jitter outlasts the delay, each no sooner than the delay", () => {
    const queue = createLagQueue(lag(10, 200), seeded(1));
    const start = performance.now();
    const heard: [number, number][] = [];
    for (let n = 0; n < 100; n += 1) {
      queue.push("rel", () => {
        heard.push([n, performance.now() - start]);
      });
    }
    vi.advanceTimersByTime(9);
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(201);
    expect(heard.map(([n]) => n)).toEqual(Array.from({ length: 100 }, (_, n) => n));
    expect(Math.min(...heard.map(([, at]) => at))).toBeGreaterThanOrEqual(10);
  });

  it("loses fast messages within a point of the share asked, over 10,000, and never rel ones", () => {
    const queue = createLagQueue(lag(5, 5, 0.25), seeded(2));
    let lost = 0;
    for (let n = 0; n < 10_000; n += 1) {
      if (!queue.push("fast", () => undefined)) {
        lost += 1;
      }
    }
    expect(lost / 10_000).toBeGreaterThan(0.24);
    expect(lost / 10_000).toBeLessThan(0.26);
    queue.close();
    const kept = createLagQueue(lag(5, 5, 1), seeded(3));
    const rel: number[] = [];
    for (let n = 0; n < 100; n += 1) {
      expect(
        kept.push("rel", () => {
          rel.push(n);
        }),
      ).toBe(true);
      expect(
        kept.push("fast", () => {
          rel.push(-1);
        }),
      ).toBe(false);
    }
    vi.advanceTimersByTime(10);
    expect(rel).toEqual(Array.from({ length: 100 }, (_, n) => n));
  });

  it("delivers fast messages each on its own time, a later one first when its jitter is shorter", () => {
    // Each `fast` message draws for its loss, then its jitter: 90 ms, then 10 ms.
    const draws = [0.5, 0.9, 0.5, 0.1];
    const queue = createLagQueue(lag(10, 100), () => draws.shift() ?? 0);
    const heard: string[] = [];
    queue.push("fast", () => {
      heard.push("first");
    });
    queue.push("fast", () => {
      heard.push("second");
    });
    vi.advanceTimersByTime(20);
    expect(heard).toEqual(["second"]);
    vi.advanceTimersByTime(80);
    expect(heard).toEqual(["second", "first"]);
  });

  it("lets what is held go on the next task, in the order it was pushed, once set to none", () => {
    const queue = createLagQueue(lag(1000, 500), seeded(4));
    const heard: string[] = [];
    for (let n = 0; n < 3; n += 1) {
      queue.push("rel", () => {
        heard.push(`rel ${String(n)}`);
      });
      queue.push("fast", () => {
        heard.push(`fast ${String(n)}`);
      });
    }
    queue.set(null);
    // Pushed before that task: behind what is held.
    queue.push("rel", () => {
      heard.push("after");
    });
    expect([heard, queue.idle]).toEqual([[], false]);
    vi.advanceTimersByTime(0);
    expect(heard).toEqual(["rel 0", "fast 0", "rel 1", "fast 1", "rel 2", "fast 2", "after"]);
    expect(queue.idle).toBe(true);
    // Each went once, and the next goes on the next task, behind nothing.
    vi.advanceTimersByTime(2000);
    expect(heard).toHaveLength(7);
  });

  it("keeps what is held on its time when the lag changes", () => {
    const queue = createLagQueue(lag(100));
    const heard: string[] = [];
    queue.push("rel", () => {
      heard.push("slow");
    });
    queue.set(lag(10));
    queue.push("rel", () => {
      heard.push("behind");
    });
    queue.push("fast", () => {
      heard.push("fast");
    });
    vi.advanceTimersByTime(10);
    // A `rel` message never passes the one ahead of it; a `fast` one does.
    expect(heard).toEqual(["fast"]);
    vi.advanceTimersByTime(90);
    expect(heard).toEqual(["fast", "slow", "behind"]);
  });

  it("holds a rel message its path refused, with the ones after it, and tries it again later", () => {
    const queue = createLagQueue(lag(10));
    const path = { open: false };
    const heard: number[] = [];
    const sendOn = (n: number) => (): boolean => {
      if (path.open) {
        heard.push(n);
      }
      return path.open;
    };
    for (let n = 0; n < 3; n += 1) {
      queue.push("rel", sendOn(n));
    }
    let fast = 0;
    // A `fast` message its path refused is gone.
    queue.push("fast", () => {
      fast += 1;
      return false;
    });
    vi.advanceTimersByTime(10);
    expect([heard, fast, queue.blocked]).toEqual([[], 1, true]);
    vi.advanceTimersByTime(LAG_RETRY_MS);
    expect(queue.blocked).toBe(true);
    path.open = true;
    // The second try waits twice as long.
    vi.advanceTimersByTime(LAG_RETRY_MS * 2 - 1);
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(1);
    expect([heard, fast, queue.blocked]).toEqual([[0, 1, 2], 1, false]);
  });

  it("delivers the rest when one deliver throws, and throws its error on its own", () => {
    const errors: unknown[] = [];
    const microtask = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => {
      try {
        task();
      } catch (error) {
        errors.push(error);
      }
    });
    try {
      const queue = createLagQueue(lag(5));
      const heard: string[] = [];
      queue.push("rel", () => {
        throw new Error("a listener failed");
      });
      queue.push("rel", () => {
        heard.push("next");
      });
      vi.advanceTimersByTime(5);
      expect(heard).toEqual(["next"]);
      expect(errors).toEqual([new Error("a listener failed")]);
    } finally {
      microtask.mockRestore();
    }
  });

  it("drops what it holds when it closes, and delivers nothing after", () => {
    const queue = createLagQueue(lag(10, 10));
    const heard: string[] = [];
    queue.push("rel", () => {
      heard.push("rel");
    });
    queue.push("fast", () => {
      heard.push("fast");
    });
    queue.close();
    queue.push("rel", () => {
      heard.push("late");
    });
    queue.set(null);
    queue.flush();
    vi.advanceTimersByTime(100);
    expect(heard).toEqual([]);
  });

  it("refuses a lag out of range, naming who asked", () => {
    expect(checkLag({}, "test")).toEqual({ ms: 0, jitter: 0, loss: 0 });
    for (const [options, message] of [
      [{ ms: -1 }, "test: ms must be a number from 0"],
      [{ jitter: Number.NaN }, "test: jitter must be a number from 0"],
      [{ loss: 1.5 }, "test: loss must be a number from 0 to 1"],
      [{ ms: "5" }, "test: ms must be a number from 0"],
      [{ random: 0.5 }, "test: random must be a function returning numbers from 0 to 1"],
    ] as const) {
      expect(() => checkLag(options as never, "test")).toThrow(new TypeError(message));
    }
  });
});
