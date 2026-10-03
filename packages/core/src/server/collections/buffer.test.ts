// The resume buffer (RFC 0003 section 7.3): which revisions it can resume
// from, and what it replays. Revisions here are small numbers above the
// buffer's starting floor; the buffer's own clock is a counter the tests move.

import { describe, expect, it } from "vitest";
import type { CollectionDelta } from "../../protocol/envelope";
import { nextRev } from "../rev";
import { createDeltaBuffer, type DeltaBufferOptions } from "./buffer";

function removed(id: string): CollectionDelta {
  return { t: "removed", id };
}

/** A buffer whose floor is `start`, and a clock the test moves. */
function setup(options: Omit<DeltaBufferOptions, "now"> = {}) {
  const clock = { at: 0 };
  const buffer = createDeltaBuffer({ ...options, now: () => clock.at });
  const start = nextRev();
  return { buffer, clock, start };
}

describe("the delta buffer", () => {
  it("replays the frames after a revision in the order they went out, deltas sharing a revision kept together", () => {
    const { buffer, start } = setup();
    buffer.record("a", start + 1, [removed("1"), removed("2")]);
    buffer.record("a", start + 2, [removed("3")]);
    buffer.record("b", start + 3, [removed("other")]);
    expect(buffer.since("a", start)).toEqual({
      rev: start + 2,
      deltas: [removed("1"), removed("2"), removed("3")],
    });
    expect(buffer.since("a", start + 1)).toEqual({ rev: start + 2, deltas: [removed("3")] });
    expect(buffer.since("a", start + 2)).toEqual({ rev: start + 2, deltas: [] });
    expect(buffer.since("unchanged", start)).toEqual({ rev: start, deltas: [] });
  });

  it("does not resume from before it existed", () => {
    const before = nextRev();
    const { buffer } = setup();
    expect(buffer.since("a", before)).toBeUndefined();
  });

  it("drops the oldest frames past 500 deltas, and no longer resumes from before them", () => {
    const { buffer, start } = setup();
    buffer.record(
      "a",
      start + 1,
      Array.from({ length: 300 }, (_, i) => removed(`x${i}`)),
    );
    buffer.record(
      "a",
      start + 2,
      Array.from({ length: 300 }, (_, i) => removed(`y${i}`)),
    );
    expect(buffer.since("a", start)).toBeUndefined();
    expect(buffer.since("a", start + 1)?.deltas).toHaveLength(300);
  });

  it("drops frames older than 5 minutes", () => {
    const { buffer, clock, start } = setup();
    buffer.record("a", start + 1, [removed("1")]);
    clock.at = 299_999;
    expect(buffer.since("a", start)?.deltas).toEqual([removed("1")]);
    clock.at = 300_001;
    expect(buffer.since("a", start)).toBeUndefined();
    expect(buffer.since("a", start + 1)).toEqual({ rev: start + 1, deltas: [] });
  });

  it("does not resume from before a change whose deltas were not built, or a reset", () => {
    const { buffer, start } = setup();
    buffer.skip("a", start + 2);
    expect(buffer.since("a", start + 1)).toBeUndefined();
    expect(buffer.since("a", start + 2)).toEqual({ rev: start + 2, deltas: [] });
    buffer.record("a", start + 3, [removed("1")]);
    buffer.reset("a", start + 4);
    expect(buffer.since("a", start + 3)).toBeUndefined();
    expect(buffer.since("a", start + 4)).toBeUndefined();
    expect(buffer.since("a", start + 5)).toEqual({ rev: start + 5, deltas: [] });
  });

  it("does not resume a revision a frame recorded out of order may have skipped", () => {
    const { buffer, start } = setup();
    buffer.record("a", start + 2, [removed("2")]);
    buffer.record("a", start + 1, [removed("1")]);
    expect(buffer.since("a", start + 2)).toBeUndefined();
    expect(buffer.since("a", start + 3)).toEqual({ rev: start + 3, deltas: [] });
    expect(buffer.lastChange("a")).toBe(start + 2);
  });

  it("forgets idle scopes past its cap, and no longer resumes them from before their last change", () => {
    const { buffer, start } = setup({ maxScopes: 1 });
    buffer.record("a", start + 1, [removed("1")]);
    buffer.record("b", start + 2, [removed("2")]);
    expect(buffer.since("a", start)).toBeUndefined();
    expect(buffer.since("a", start + 1)).toEqual({ rev: start + 1, deltas: [] });
    expect(buffer.since("b", start + 1)).toEqual({ rev: start + 2, deltas: [removed("2")] });
  });

  it("keeps the state of a pinned scope, so an unchanged one resumes however many others it forgets", () => {
    const { buffer, clock, start } = setup({ maxScopes: 1 });
    buffer.pin("held");
    buffer.record("a", start + 1, [removed("1")]);
    buffer.record("b", start + 2, [removed("2")]);
    clock.at = 600_000;
    buffer.record("c", start + 3, [removed("3")]);
    expect(buffer.since("held", start)).toEqual({ rev: start, deltas: [] });
    expect(buffer.since("unpinned", start)).toBeUndefined();
    buffer.unpin("held");
    expect(buffer.since("held", start)).toEqual({ rev: start, deltas: [] });
  });

  it("tells the last change it saw to a scope", () => {
    const { buffer, start } = setup();
    expect(buffer.lastChange("a")).toBeLessThanOrEqual(start);
    buffer.skip("a", start + 5);
    expect(buffer.lastChange("a")).toBe(start + 5);
    buffer.record("a", start + 6, [removed("1")]);
    expect(buffer.lastChange("a")).toBe(start + 6);
  });
});
