// Per-connection query concurrency (RFC 0003 section 9, step 2): at most
// `maxInFlight` queries of one connection run at once, up to `maxQueued`
// more wait in order, and past that a query fails with `RATE_LIMITED`.
// Mutations never come here, so they are never queued behind queries. 4.1
// had no cap: every event ran as soon as it arrived.

import { QuickdrawError } from "../../protocol/errors";
import { cancelledError } from "./errors";

/** The limits of {@link createConcurrencyLimiter}. */
export interface ConcurrencyLimits {
  /** Queries of one connection that may run at once. */
  readonly maxInFlight: number;
  /** Queries of one connection that may wait for a slot. */
  readonly maxQueued: number;
  /** The `retryAfterMs` sent with `RATE_LIMITED` when the queue is full. */
  readonly retryAfterMs: number;
}

/** A held query slot. */
export interface QuerySlot {
  /** How long the query waited in the queue, in milliseconds. */
  readonly queueMs: number;
  /** Frees the slot for the next queued query. Calling it again does nothing. */
  release(): void;
}

/** Hands out query slots per connection. */
export interface ConcurrencyLimiter {
  /**
   * Resolves with a slot of `connectionId`'s lane once one is free. Rejects
   * with `RATE_LIMITED` when the lane's queue is full, and with `CANCELLED`
   * when `signal` aborts first.
   */
  acquire(connectionId: string, signal?: AbortSignal): Promise<QuerySlot>;
  /** Connections that have queries running or queued. */
  readonly connections: number;
}

interface Waiter {
  readonly grant: () => void;
}

interface Lane {
  running: number;
  readonly queue: Waiter[];
}

export function createConcurrencyLimiter(limits: ConcurrencyLimits): ConcurrencyLimiter {
  const lanes = new Map<string, Lane>();

  function dropIfIdle(connectionId: string, lane: Lane): void {
    if (lane.running === 0 && lane.queue.length === 0) {
      lanes.delete(connectionId);
    }
  }

  function slot(connectionId: string, lane: Lane, queueMs: number): QuerySlot {
    let released = false;
    return {
      queueMs,
      release() {
        if (released) {
          return;
        }
        released = true;
        lane.running -= 1;
        const next = lane.queue.shift();
        if (next === undefined) {
          dropIfIdle(connectionId, lane);
          return;
        }
        lane.running += 1;
        next.grant();
      },
    };
  }

  function enqueue(connectionId: string, lane: Lane, signal?: AbortSignal): Promise<QuerySlot> {
    return new Promise((resolve, reject) => {
      const enqueuedAt = performance.now();
      const waiter: Waiter = { grant };
      function grant(): void {
        signal?.removeEventListener("abort", onAbort);
        resolve(slot(connectionId, lane, performance.now() - enqueuedAt));
      }
      function onAbort(): void {
        const index = lane.queue.indexOf(waiter);
        if (index >= 0) {
          lane.queue.splice(index, 1);
        }
        dropIfIdle(connectionId, lane);
        reject(cancelledError());
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      lane.queue.push(waiter);
    });
  }

  return {
    acquire(connectionId, signal) {
      if (signal?.aborted === true) {
        return Promise.reject(cancelledError());
      }
      let lane = lanes.get(connectionId);
      if (lane === undefined) {
        lane = { running: 0, queue: [] };
        lanes.set(connectionId, lane);
      }
      if (lane.running < limits.maxInFlight) {
        lane.running += 1;
        return Promise.resolve(slot(connectionId, lane, 0));
      }
      if (lane.queue.length >= limits.maxQueued) {
        return Promise.reject(
          new QuickdrawError("RATE_LIMITED", "Too many queries in flight on this connection", {
            retryAfterMs: limits.retryAfterMs,
          }),
        );
      }
      return enqueue(connectionId, lane, signal);
    },
    get connections() {
      return lanes.size;
    },
  };
}
