// What the live data's stores share (RFC 0003 sections 6, 7, 8.2 and 11.5):
// the connection they subscribe over, the `QueryClient` their state lives
// in, and the overlay store of optimistic mutations, plus how they read and
// write that state and how they send a subscription event and read what
// came back.
//
// State lives in the `QueryClient`, under the entity key `["qd", service,
// "e", id]` and the collection key `["qd", service, "c", collection,
// scope]`, so the hooks read it as they read any query, and app code and
// devtools see it. The stores are its only writers. Entries are written
// whole and without TanStack's structural sharing: an index can hold 50,000
// rows, and the stores already keep every unchanged object. A hook observes
// its entry with a query that never fetches, which also keeps TanStack from
// collecting the entry while it is shown; an entry nobody shows any more is
// collected after `gcTime`, as any query is.
//
// React-free.

import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { Revision } from "../../protocol/envelope";
import { QuickdrawError, fromWire } from "../../protocol/errors";
import { isRecord } from "../../protocol/guards";
import { DEFAULT_BACKOFF_MS, retryAfterOf } from "../backoff";
import type { QuickdrawConnection } from "../connection";
import { subscriptionLimits, type SubscriptionEvent, type SubscriptionLimits } from "../lane";
import type { OverlayStore } from "../optimistic";

/** The connection and cache one set of live stores works with. */
export interface LiveHost {
  readonly connection: QuickdrawConnection;
  readonly queryClient: QueryClient;
  /** The overlays of `queryClient`: told every revision that arrives, and applied to what the hooks show. */
  readonly overlays: OverlayStore;
}

/** An entry of the live data, or `undefined` when none is cached. */
export function readEntry<T>(host: LiveHost, queryKey: QueryKey): T | undefined {
  return host.queryClient.getQueryData<T>(queryKey);
}

/** Writes an entry of the live data, telling the hooks that show it. */
export function writeEntry<T>(host: LiveHost, queryKey: QueryKey, value: T): void {
  const { queryClient } = host;
  const options = queryClient.defaultQueryOptions({ queryKey, structuralSharing: false });
  queryClient.getQueryCache().build(queryClient, options).setData(value, { manual: true });
}

/** What a hook observes its entry with: a query that is never fetched, never stale, never shared structurally. */
export interface EntryQueryOptions<T> {
  readonly queryKey: QueryKey;
  readonly queryFn: () => T | null;
  readonly enabled: false;
  readonly staleTime: number;
  readonly structuralSharing: false;
}

/** The options of the query a hook observes the entry under `queryKey` with. */
export function entryQuery<T>(queryKey: QueryKey): EntryQueryOptions<T> {
  return {
    queryKey,
    // Never called: the query is disabled, and only the stores write the entry.
    queryFn: () => null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
    structuralSharing: false,
  };
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
 * (`liveData.ts`).
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
