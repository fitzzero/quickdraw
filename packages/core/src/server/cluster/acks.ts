// Waiting on the rest of a cluster, bounded (pack H's multi-node proof): a
// command to the cluster's Valkey (the revision counter, last-seen times),
// and a server-to-server event that is answered. A node that broadcasts an
// access change or a user's reloaded grants waits until every other node has
// applied it, so the flush that caused it sends its frames only once no node
// still holds what it revoked. Socket.IO hands the listener the
// acknowledgement as the event's last argument when the sender asked for
// answers (`serverSideEmitWithAck`).

/** How long a node waits on the rest of the cluster by default: `cluster.timeoutMs`. */
export const DEFAULT_CLUSTER_TIMEOUT_MS = 1000;

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
