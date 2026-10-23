// What the live data's stores share (RFC 0003 sections 6, 7, 8.2 and 11.5):
// the connection they subscribe over, the cache their state lives in, and
// the overlays of optimistic mutations they report to, plus how they read
// and write that state and how they send a subscription event and read what
// came back.
//
// State lives in a `LiveCache`, under the entity key `["qd", service, "e",
// id]` and the collection key `["qd", service, "c", collection, scope]`. The
// stores are its only writers. Entries are written whole: an index can hold
// 50,000 rows, and the stores already keep every unchanged object. The live
// data of a `QueryClient` (`liveData.ts`) caches in that client
// (`queryCache.ts`), so the hooks read its entries as they read any query.
//
// React-free, and TanStack-free: a `QueryClient` comes in only through a
// `LiveCache` and `LiveOverlays` made over it.

import type { Revision } from "../../protocol/envelope";
import { QuickdrawError, fromWire } from "../../protocol/errors";
import { isRecord } from "../../protocol/guards";
import type { ScopeEvidence, ScopeRef } from "../additions";
import { DEFAULT_BACKOFF_MS, retryAfterOf } from "../backoff";
import type { QuickdrawConnection } from "../connection";
import type { CollectionQueryKey, EntityQueryKey } from "../keys";
import { subscriptionLimits, type SubscriptionEvent, type SubscriptionLimits } from "../lane";

/** The key of an entry of the live data: a row's (`entityKey`) or a collection scope's (`collectionKey`). */
export type LiveKey = EntityQueryKey | CollectionQueryKey;

/** Where one set of live stores keeps its state: an entry per row and per scope. */
export interface LiveCache {
  /** The entry under `key`, or `undefined` when none is cached. */
  get(key: LiveKey): unknown;
  /** Writes the entry under `key` whole, telling whoever shows it. */
  set(key: LiveKey, value: unknown): void;
  /**
   * The store no longer holds the row or scope of `key`: its last holding
   * ended a tick ago (`registry.ts`), and nothing writes the entry until it
   * is held again.
   */
  release(key: LiveKey): void;
}

/**
 * What the live stores tell the overlays of optimistic mutations, and ask of
 * them: the overlay store of a `QueryClient` (`../optimistic.ts`), or
 * `NO_LIVE_OVERLAYS` where no optimistic mutation opens a layer.
 */
export interface LiveOverlays {
  /**
   * Revision `rev` of the row arrived: in a frame (`qd:e`, `qd:c`), or with
   * `readAt` in the reply to a read sent then (`OverlayStore.observe`).
   */
  observe(service: string, id: string, rev: Revision, readAt?: number): void;
  /** The overlays' clock: taken when a read is sent, and passed as its `readAt`. */
  now(): number;
  /** A scope's state changed: ends the additions to it that state accounts for (`settleAdditions`). */
  settle(service: string, collection: string, scope: string, evidence: ScopeEvidence): void;
  /** The scopes whose additions of unknown outcome were not asked for a load yet; marks them asked. */
  unchecked(): readonly ScopeRef[];
  /** Calls `listener` whenever a layer or an addition changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void;
}

/** No overlays: nothing is told, and no scope ever needs a load to settle an addition. */
export const NO_LIVE_OVERLAYS: LiveOverlays = Object.freeze({
  observe: () => undefined,
  now: () => 0,
  settle: () => undefined,
  unchecked: () => [],
  subscribe: () => () => undefined,
});

/** The connection, cache and overlays one set of live stores works with. */
export interface LiveHost {
  readonly connection: QuickdrawConnection;
  readonly cache: LiveCache;
  /** Told every revision that arrives, and every new state of a scope. */
  readonly overlays: LiveOverlays;
}

/** An entry of the live data, or `undefined` when none is cached. */
export function readEntry<T>(host: LiveHost, key: LiveKey): T | undefined {
  return host.cache.get(key) as T | undefined;
}

/** Writes an entry of the live data, telling whoever shows it. */
export function writeEntry<T>(host: LiveHost, key: LiveKey, value: T): void {
  host.cache.set(key, value);
}

/** The subscription limits the server announced on the current connection. */
export function limitsOf(host: LiveHost): SubscriptionLimits {
  return subscriptionLimits(host.connection.getState().hello);
}

/** How a subscription event ended. */
export type Outcome =
  /** The server answered `{ ok: true, ... }`. */
  | { readonly kind: "ok"; readonly reply: Readonly<Record<string, unknown>> }
  /** The server refused it, for a reason other than its lane being full. */
  | { readonly kind: "refused"; readonly error: QuickdrawError }
  /**
   * Send it again after `delayMs`: the server's lane was full (the
   * connection now backs off, and the lane waits that out), or no answer
   * came while the socket stayed up.
   */
  | { readonly kind: "retry"; readonly delayMs: number }
  /** The socket is down, or its hello has not arrived: send it again once it has. */
  | { readonly kind: "offline" };

function outcomeOf(host: LiveHost, error: Error | null, reply: unknown): Outcome {
  if (error !== null) {
    return host.connection.socket.connected
      ? { kind: "retry", delayMs: DEFAULT_BACKOFF_MS }
      : { kind: "offline" };
  }
  if (isRecord(reply) && reply.ok === true) {
    return { kind: "ok", reply };
  }
  const failure = fromWire(isRecord(reply) ? reply.e : undefined);
  if (failure.code === "RATE_LIMITED") {
    host.connection.reportRateLimited("subscription", retryAfterOf(failure));
    return { kind: "retry", delayMs: 0 };
  }
  return { kind: "refused", error: failure };
}

/**
 * Sends a subscription event through the connection's lane, and calls `done`
 * with how it ended. Before the server's hello on the current credentials
 * has named the user, nothing is sent and `done` is told `offline` at once:
 * the revisions a request carries could belong to the last user's data, and
 * the live data asks for everything it holds once the hello arrives
 * (`stores.ts`).
 */
export function request(
  host: LiveHost,
  event: SubscriptionEvent,
  frame: object,
  done: (outcome: Outcome) => void,
): void {
  if (host.connection.getState().hello === null) {
    done({ kind: "offline" });
    return;
  }
  host.connection.subscriptionLane.send(event, frame, (error, reply) => {
    done(outcomeOf(host, error, reply));
  });
}

/** True when `value` is a revision: a finite number. */
export function isRevision(value: unknown): value is Revision {
  return typeof value === "number" && Number.isFinite(value);
}

/** The error a malformed reply stands for. */
export function malformed(what: string): QuickdrawError {
  return new QuickdrawError("INTERNAL", `The server's ${what} reply is malformed`);
}

/** `items` in runs of at most `size`. */
export function chunks<T>(items: readonly T[], size: number): T[][] {
  const runs: T[][] = [];
  for (let start = 0; start < items.length; start += size) {
    runs.push(items.slice(start, start + size));
  }
  return runs;
}
