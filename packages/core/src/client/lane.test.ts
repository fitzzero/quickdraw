// The client's subscription lane (RFC 0003 section 8.2) on its own, with
// fake timers: what it leaves behind when its connection closes. Pacing by
// the server's lane runs against real servers in `live/live.test.ts`.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSubscriptionLane, type LaneHost } from "./lane";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stop", () => {
  it("answers the events that wait, and leaves no timer behind while a backoff lasts", () => {
    const emit = vi.fn();
    const host = {
      socket: { connected: true, timeout: () => ({ emit }) },
      timeoutMs: () => 10_000,
      hello: () => null,
      backoffRemaining: () => 1000,
    } as unknown as LaneHost;
    const lane = createSubscriptionLane(host);
    const done = vi.fn();
    lane.send("qd:sub", { s: "taskService", ids: ["t1"] }, done);
    expect(lane.waiting()).toBe(1);
    expect(vi.getTimerCount()).toBe(1);

    lane.stop();
    expect(vi.getTimerCount()).toBe(0);
    expect(lane.waiting()).toBe(0);
    expect(done).toHaveBeenCalledWith(expect.any(Error), undefined);
    expect(emit).not.toHaveBeenCalled();
  });
});
