// Waiting on the rest of a cluster, bounded (pack H's multi-node proof): a
// command to the cluster's Valkey (the revision counter, last-seen times),
// and a server-to-server event that is answered. A node that broadcasts an
// access change or a user's reloaded grants waits until every other node has
// applied it, so the flush that caused it sends its frames only once no node
// still holds what it revoked. Socket.IO hands the listener the
// acknowledgement as the event's last argument when the sender asked for
// answers (`serverSideEmitWithAck`).
//
// Socket.IO hands a request's answers over together: on the last one, or on
// the adapter's own request timeout, which passes the ones that came on the
// error (`answersOf`). A request that keeps what came (presence, a stream's
// subscriber count, a starting node's room hosts) waits that long plus
// `ADAPTER_MARGIN_MS` (`requestDeadlineOf`): the Redis adapter's
// `requestsTimeout`, or the fixed 5 s of socket.io-adapter's cluster adapter;
// any other adapter `cluster.timeoutMs`. quickdraw reads the adapter and
// never writes to one the app built.

import type { QuickdrawIo } from "../transports/types";

/** How long a node waits on the rest of the cluster by default: `cluster.timeoutMs`. */
export const DEFAULT_CLUSTER_TIMEOUT_MS = 1000;

/** How long past an adapter's own request timeout a request waits for the answers it hands over then. */
export const ADAPTER_MARGIN_MS = 250;

/**
 * The request timeout of socket.io-adapter's cluster adapter
 * (`ClusterAdapter`, `ClusterAdapterWithHeartbeat`), which it does not
 * expose: a fixed 5 s, after which it hands over the answers that came.
 */
export const CLUSTER_ADAPTER_TIMEOUT_MS = 5000;

/** The longest delay a timer honors (2^31 - 1 ms). */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * True for an adapter built on socket.io-adapter's cluster adapter (the
 * sharded Redis, Redis streams, Postgres and Mongo adapters): it has the two
 * publishing hooks that class asks of every subclass, and the class's own
 * `publishAndReturnOffset`. Read off the adapter, so it holds for whichever
 * copy of socket.io-adapter built it, where `instanceof` would hold for one.
 */
export function isClusterAdapter(adapter: object): boolean {
  const hooks = adapter as {
    readonly doPublish?: unknown;
    readonly doPublishResponse?: unknown;
    readonly publishAndReturnOffset?: unknown;
  };
  return (
    typeof hooks.doPublish === "function" &&
    typeof hooks.doPublishResponse === "function" &&
    typeof hooks.publishAndReturnOffset === "function"
  );
}

/**
 * How long a request to the other nodes waits to keep the answers that
 * came: the adapter's own request timeout plus `ADAPTER_MARGIN_MS` (the Redis
 * adapter's `requestsTimeout`, or socket.io-adapter's cluster adapter's fixed
 * 5 s), else `cluster.timeoutMs`.
 */
export function requestDeadlineOf(
  hub: { readonly cluster?: { readonly timeoutMs?: number } | undefined },
  io: QuickdrawIo,
): number {
  const adapter = (io.sockets as { readonly adapter?: unknown }).adapter;
  if (typeof adapter === "object" && adapter !== null) {
    const own = (adapter as { readonly requestsTimeout?: unknown }).requestsTimeout;
    if (
      typeof own === "number" &&
      Number.isFinite(own) &&
      own > 0 &&
      own + ADAPTER_MARGIN_MS <= MAX_TIMER_MS
    ) {
      return own + ADAPTER_MARGIN_MS;
    }
    if (isClusterAdapter(adapter)) {
      return CLUSTER_ADAPTER_TIMEOUT_MS + ADAPTER_MARGIN_MS;
    }
  }
  return hub.cluster?.timeoutMs ?? DEFAULT_CLUSTER_TIMEOUT_MS;
}

/** The answers a request did get before the adapter's own timeout: Socket.IO passes them on the error. */
export function answersOf(error: unknown): unknown {
  return typeof error === "object" && error !== null
    ? (error as { readonly responses?: unknown }).responses
    : undefined;
}

/** Each server's `cluster.timeoutMs`, by its Socket.IO server, for `setupRedisAdapter`. */
const TIMEOUTS = new WeakMap<object, number>();

/** Registers the `cluster.timeoutMs` of the server `io`, when it has one. */
export function registerClusterTimeout(io: object, timeoutMs: number | undefined): void {
  if (timeoutMs !== undefined) {
    TIMEOUTS.set(io, timeoutMs);
  }
}

/** The `cluster.timeoutMs` of the server `io`: its option, else 1,000. */
export function clusterTimeoutOf(io: object): number {
  return TIMEOUTS.get(io) ?? DEFAULT_CLUSTER_TIMEOUT_MS;
}

class Timeout extends Error {
  constructor(ms: number) {
    super(`no answer within ${ms} ms`);
  }
}

/** `promise`, or a rejection once `ms` passed. */
export async function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Timeout(ms));
    }, ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** The acknowledgement a server-to-server event came with (its last argument), or one that does nothing. */
export function answerOf<T = boolean>(rest: readonly unknown[]): (value: T) => void {
  const last = rest.at(-1);
  return typeof last === "function" ? (last as (value: T) => void) : () => undefined;
}
