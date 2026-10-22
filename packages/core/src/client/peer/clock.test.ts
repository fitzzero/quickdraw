// A peer link's clock against scripted pongs (RFC 0003 section 12.5): the
// offset of the fastest of the recent round trips, taken as it comes until
// the clock is synced, then slewed, or jumped to when it moved far; the
// round trip and jitter smoothed; and readings it cannot use ignored.

import { describe, expect, it } from "vitest";
import { CLOCK_JUMP_MS, CLOCK_SLEW_MS, CLOCK_SYNC_SAMPLES, createClock } from "./clock";

/** A clock whose local time the test sets, and a peer `ahead` of it, with one-way delays `out` and `back`. */
function scripted(ahead: number) {
  let local = 1000;
  const clock = createClock(() => local);
  return {
    clock,
    /** A ping now, answered after `out` ms and heard `back` ms later. */
    trip(out: number, back: number): void {
      const sent = local;
      local += out;
      const answered = local + ahead;
      local += back;
      clock.pong(sent, answered, local);
    },
    get local() {
      return local;
    },
  };
}

describe("the peer clock", () => {
  it("reads the peer's clock from symmetric round trips", () => {
    const s = scripted(5000);
    expect([s.clock.offset, s.clock.synced, s.clock.rtt]).toEqual([0, false, 0]);
    s.trip(20, 20);
    expect(s.clock.offset).toBe(5000);
    expect(s.clock.rtt).toBe(40);
    expect(s.clock.now()).toBe(s.local + 5000);
  });

  it(`is synced after ${String(CLOCK_SYNC_SAMPLES)} pongs, the fastest round trip's offset winning`, () => {
    const s = scripted(5000);
    // A slow trip whose halves differ reads the offset 30 ms off: (10 - 70) / 2.
    s.trip(10, 70);
    expect(s.clock.offset).toBe(4970);
    s.trip(15, 15);
    expect(s.clock.offset).toBe(5000);
    for (let n = 2; n < CLOCK_SYNC_SAMPLES; n += 1) {
      expect(s.clock.synced).toBe(false);
      s.trip(40, 60);
    }
    expect(s.clock.synced).toBe(true);
    expect(s.clock.offset).toBe(5000);
  });

  it(`slews by at most ${String(CLOCK_SLEW_MS)} ms a pong once synced, and jumps past ${String(CLOCK_JUMP_MS)} ms`, () => {
    let ahead = 5000;
    let local = 0;
    const clock = createClock(() => local);
    const trip = (): void => {
      const sent = local;
      local += 10;
      const answered = local + ahead;
      local += 10;
      clock.pong(sent, answered, local);
    };
    for (let n = 0; n < CLOCK_SYNC_SAMPLES; n += 1) {
      trip();
    }
    expect([clock.synced, clock.offset]).toEqual([true, 5000]);
    // The peer's clock drifted 40 ms: every round trip ties, so the latest is the estimate.
    ahead = 5040;
    const steps: number[] = [];
    for (let n = 0; n < 9; n += 1) {
      const before = clock.offset;
      trip();
      steps.push(clock.offset - before);
    }
    expect(steps).toEqual([5, 5, 5, 5, 5, 5, 5, 5, 0]);
    expect(clock.offset).toBe(5040);
    ahead = 9000;
    trip();
    expect(clock.offset).toBe(9000);
  });

  it("smooths the round trip and its jitter, and ignores readings it cannot use", () => {
    const s = scripted(0);
    s.trip(20, 20);
    expect([s.clock.rtt, s.clock.jitter]).toEqual([40, 20]);
    s.trip(40, 40);
    // TCP's: jitter += (|80 - 40| - 20) / 4, then rtt += (80 - 40) / 8.
    expect([s.clock.rtt, s.clock.jitter]).toEqual([45, 25]);
    const { offset, rtt } = s.clock;
    s.clock.pong(s.local + 50, 0, s.local);
    s.clock.pong(s.local - 20_000, 0, s.local);
    expect([s.clock.offset, s.clock.rtt]).toEqual([offset, rtt]);
  });
});
