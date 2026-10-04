// Revisions (RFC 0003 section 5.3, step 2): one per flush, per-process
// monotonic, `max(Date.now() * 1000, last + 1)`: microseconds since the
// epoch. A revision is taken before any row is read, so a payload is never
// older than the revision it carries. Clients drop frames older than what
// they hold, so two flushes in one millisecond must still get different
// revisions, and a clock that steps back must not reuse one. In
// microseconds a process takes a thousand revisions a millisecond and stays
// on the clock, which `versionColumn` times are compared with (a time is its
// milliseconds times 1,000: `emit/hub.ts`); revisions stay safe integers
// (about 1.8e15, under 2^53).
//
// Behind a cluster adapter with a shared counter (`cluster/revisions.ts`),
// flushes take their revisions from the counter instead, which keeps to
// Valkey's clock in microseconds; the revisions it hands out are observed
// here, so a revision this process takes later is never below one it
// already sent.

import type { Revision } from "../protocol/envelope";

/** Microseconds per millisecond: a revision is a time in microseconds. */
export const MICROS_PER_MS = 1000;

let last = 0;

/** The clock as a revision: `Date.now()` in microseconds. */
export function clockRev(): Revision {
  return Date.now() * MICROS_PER_MS;
}

/** The next revision: the current time in microseconds, or one more than the last revision when that is later. */
export function nextRev(): Revision {
  last = Math.max(clockRev(), last + 1);
  return last;
}

/**
 * The revision a read made from now on is no older than, without taking a
 * new one: the last revision taken (one is taken when none was yet). Every
 * write whose flush took a revision up to it had committed before that
 * revision was taken, and any later flush takes a greater one. A read that
 * is not a flush (a subscription's rows) claims it rather than taking its
 * own, so reads do not push revisions ahead of the clock that
 * `versionColumn` times are compared with.
 */
export function currentRev(): Revision {
  return last === 0 ? nextRev() : last;
}

/** Records a revision taken elsewhere (the cluster's counter): later ones taken here are above it. */
export function observeRev(rev: Revision): void {
  last = Math.max(last, rev);
}

/**
 * The time a version column holds as a revision (microseconds since the
 * epoch: its milliseconds times 1,000), or `undefined` when it holds none. A
 * column holds a `Date`, a date string, or a number of milliseconds since
 * the epoch.
 */
export function versionTime(value: unknown): Revision | undefined {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) ? undefined : time * MICROS_PER_MS;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value * MICROS_PER_MS;
  }
  if (typeof value === "string") {
    const time = Date.parse(value);
    return Number.isNaN(time) ? undefined : time * MICROS_PER_MS;
  }
  return undefined;
}
