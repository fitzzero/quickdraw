// Rate-limit backoff per kind of work (RFC 0003 section 11.1). A `RATE_LIMITED`
// answer pauses that kind of work for its `retryAfterMs` plus random jitter,
// so clients told to wait the same time do not all retry at the same instant.
// Ported from 4.1's provider (`legacy-src/client/QuickdrawProvider.tsx:269-287`),
// which paused every read for one shared window. Here each kind has its own:
// a full query queue says nothing about mutations, and subscription events run
// in their own per-socket lane on the server (section 8.2).
//
// React-free: the connection owns one and puts its windows in its state.

import type { MethodKind } from "../contract/methods";

/** The kinds of work that back off separately: method calls by kind, and subscription events. */
export type BackoffKind = MethodKind | "subscription";

/** When each kind's backoff ends, in epoch milliseconds; a kind that is not backing off is absent. */
export type BackoffWindows = Readonly<Partial<Record<BackoffKind, number>>>;

/** The wait when a `RATE_LIMITED` answer carries no `retryAfterMs`, as in 4.1. */
export const DEFAULT_BACKOFF_MS = 5000;

/** The shortest and longest wait, before jitter. */
const MIN_BACKOFF_MS = 250;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

/** Jitter adds up to this share of the wait. */
const JITTER_RATIO = 0.5;

/** The backoff windows of one connection. */
export interface Backoff {
  /** Starts or extends `kind`'s window: `retryAfterMs` (or the default) plus up to half again at random. */
  report(kind: BackoffKind, retryAfterMs?: number): void;
  /** How long `kind` still backs off, in milliseconds; 0 when it does not. */
  remaining(kind: BackoffKind): number;
  /** The windows in effect. */
  windows(): BackoffWindows;
  /** Ends every window and its timer. */
  clear(): void;
}

function waitFor(retryAfterMs: number | undefined): number {
  const wait =
    typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs)
      ? retryAfterMs
      : DEFAULT_BACKOFF_MS;
  return Math.min(Math.max(wait, MIN_BACKOFF_MS), MAX_BACKOFF_MS);
}

/**
 * Creates the backoff windows of one connection. `onChange` is called with
 * the windows whenever one starts, is extended or ends.
 */
export function createBackoff(onChange: (windows: BackoffWindows) => void): Backoff {
  const until = new Map<BackoffKind, number>();
  const timers = new Map<BackoffKind, ReturnType<typeof setTimeout>>();

  const windows = (): BackoffWindows => Object.freeze(Object.fromEntries(until));

  function end(kind: BackoffKind): void {
    timers.delete(kind);
    until.delete(kind);
    onChange(windows());
  }

  return Object.freeze({
    report(kind: BackoffKind, retryAfterMs?: number): void {
      const wait = waitFor(retryAfterMs);
      const delay = wait + Math.random() * wait * JITTER_RATIO;
      const ends = Date.now() + delay;
      if (ends <= (until.get(kind) ?? 0)) {
        return;
      }
      clearTimeout(timers.get(kind));
      until.set(kind, ends);
      timers.set(
        kind,
        setTimeout(() => {
          end(kind);
        }, delay),
      );
      onChange(windows());
    },
    remaining(kind: BackoffKind): number {
      const ends = until.get(kind);
      return ends === undefined ? 0 : Math.max(0, ends - Date.now());
    },
    windows,
    clear(): void {
      for (const timer of timers.values()) {
        clearTimeout(timer);
      }
      timers.clear();
      if (until.size > 0) {
        until.clear();
        onChange(windows());
      }
    },
  });
}
