// Revisions (RFC 0003 section 5.3, step 2): one per flush, per-process
// monotonic, `max(Date.now(), last + 1)`. A revision is taken before any row
// is read, so a payload is never older than the revision it carries. Clients
// drop frames older than what they hold, so two flushes in one millisecond
// must still get different revisions, and a clock that steps back must not
// reuse one.
//
// Behind a cluster adapter with a shared counter (`cluster/revisions.ts`),
// flushes take their revisions from the counter instead; the revisions it
// hands out are observed here, so a revision this process takes later is
// never below one it already sent.

import type { Revision } from "../protocol/envelope";

let last = 0;

/** The next revision: the current time in milliseconds, or one more than the last revision when that is later. */
export function nextRev(): Revision {
  last = Math.max(Date.now(), last + 1);
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
