// Each socket's lane of subscription events (RFC 0003 sections 6, 7 and 9):
// `qd:sub`, `qd:col:sub`, `qd:col:items` and `qd:watch` read the database,
// and the socket rate limiter does not count them (a page mounts many at
// once, `transports/middleware.ts`). Without a cap, one socket could start
// any number of 500-id batches together. They run through the concurrency
// stage's limiter instead (`pipeline/concurrency.ts`), one lane per socket
// shared by the four events: `limits.subscriptions.maxInFlight` (8) at once,
// `maxQueued` (64) waiting in order, then `RATE_LIMITED`. A socket's queued
// work is dropped when it disconnects; work already running finishes, and
// frees its slot.

import { createConcurrencyLimiter } from "../pipeline/concurrency";
import type { QuickdrawServerSocket, SocketContext } from "../transports/types";

/** Runs one subscription event's work in its socket's lane; rejects `RATE_LIMITED` when the lane is full. */
export type Lane = <T>(work: () => Promise<T>) => Promise<T>;

const LANES = new WeakMap<QuickdrawServerSocket, Lane>();

/** The socket's lane, made on first use with the dispatcher's `limits.subscriptions`. */
export function laneOf(
  socket: QuickdrawServerSocket,
  context: Pick<SocketContext, "dispatcher">,
): Lane {
  const existing = LANES.get(socket);
  if (existing !== undefined) {
    return existing;
  }
  const { subscriptions, retryAfterMs } = context.dispatcher.limits;
  const limiter = createConcurrencyLimiter({
    maxInFlight: subscriptions.maxInFlight,
    maxQueued: subscriptions.maxQueued,
    retryAfterMs,
    work: "subscription requests",
  });
  const closed = new AbortController();
  socket.on("disconnect", () => {
    closed.abort();
  });
  const lane: Lane = async (work) => {
    const slot = await limiter.acquire(socket.id, closed.signal);
    try {
      return await work();
    } finally {
      slot.release();
    }
  };
  LANES.set(socket, lane);
  return lane;
}
