// Revisions (RFC 0003 section 5.3, step 2): one per flush, per-process
// monotonic, `max(Date.now(), last + 1)`. A revision is taken before any row
// is read, so a payload is never older than the revision it carries. Clients
// drop frames older than what they hold, so two flushes in one millisecond
// must still get different revisions, and a clock that steps back must not
// reuse one.

import type { Revision } from "../protocol/envelope";

let last = 0;

/** The next revision: the current time in milliseconds, or one more than the last revision when that is later. */
export function nextRev(): Revision {
  last = Math.max(Date.now(), last + 1);
  return last;
}
