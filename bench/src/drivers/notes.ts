import type { Target } from "./types";

/**
 * How each target's client and server were run, for the result file's
 * notes after the common ones (`../assemble.ts`). Kept apart from the
 * drivers so a report can be assembled without loading a client.
 */
export const TARGET_NOTES: Record<Target, readonly string[]> = {
  v4: [
    "Clients speak the 4.1 wire protocol as the 4.1 React hooks do (bench/src/drivers/v4/viewer.ts lists the behaviors copied). Failed requests are timeouts (no answer within the 10 s the 4.1 hooks wait), error answers, and calls with no client timeout still unanswered when the window closed.",
    "Prisma batches findUnique calls made in the same tick into one statement, so the 60 per-row access checks and reads of a batchSubscribe cost a handful of statements rather than 180.",
    "The server logs with 4.1's defaults (two info lines per method call) to a file on local disk.",
  ],
  v5: [
    "Clients run the 5.0 client itself (createQuickdrawConnection, liveDataOf, the invalidation coordinator and the cache session, wired as QuickdrawProvider wires them); bench/src/drivers/v5/viewer.ts lists what is reproduced of the query hook. After a reconnect, rows and the collection resume by revision at once and the watched board query is refetched after the client's random 0 to 2 s delay, so restore times include that delay; the live-restore times stop at the resumed rows and collection.",
    "Failed requests are timeouts (no answer within the 5.0 client's default limit, the server's callTimeoutMs plus 2 s: 32 s), error answers (RATE_LIMITED included, whether the server sent it or the client refused a call while backing off), and calls still unanswered when the window closed. Subscription frames (qd:sub, qd:col:sub, qd:watch) are timed from emit to acknowledgement.",
    "Handler runs count the calls that ran their own handler (a call that joined a shared run of getTasksByStatus is not one) and the subscription frames the server received, one per frame however many ids it named. Snapshots served count collection pages and entity rows sent; resumes and not-modified rows are counted apart.",
    "The server logs with 5.0's defaults (the console logger: one debug record per call) to a file on local disk. Its socket rate limiter allows 1,000 events per minute per socket instead of the default 100, which would refuse part of this workload (4.1 had no limiter).",
  ],
};
