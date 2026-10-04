// Answered broadcasts to the other nodes of a cluster (the pack H finale
// review): an access change, or a user's reloaded grants, is broadcast and
// waited for until every other node has applied it, so the flush that caused
// it sends its frames only once no node still holds what it revoked.
//
// That wait is in line with the node's flushes: they run one after another
// (`../uow/flush.ts`), so every flush behind an access change waits with it.
// A node that does not answer (frozen, killed without its Valkey connection
// closing yet, an old version during a rolling deploy) would put
// `cluster.timeoutMs` on every access-changing flush, and Valkey down would
// hold even the frames to a node's own sockets. So:
//
// - while the publishing client is not connected, nothing waits: the
//   broadcast is sent unanswered (it waits in the client's queue);
// - after one broadcast was not answered in time, broadcasts stop waiting
//   (one error logged, "degraded"), and a probe is broadcast every second
//   until every node answers one, which ends it (one info logged).
//
// Broadcasts sent unanswered stay fail-open, as a timed-out wait always was:
// a slower node may hold a revoked socket in a room until it applies the
// change, and that socket may get the flush's frames meanwhile.

import type { Logger } from "../../contract/logger";
import { describeError } from "../pipeline/metrics";
import type { QuickdrawIo } from "../transports/types";
import { answerOf, DEFAULT_CLUSTER_TIMEOUT_MS, within } from "./acks";
import { clusterClientOf } from "./counter";

/** The server-to-server event a degraded node probes the others with; each answers it at once. */
export const PROBE_EVENT = "quickdraw:probe";

/** How often a degraded node probes the others. */
export const PROBE_MS = 1000;

/** A node's answered broadcasts to the rest of its cluster. */
export interface ClusterBroadcasts {
  /**
   * Broadcasts `event` with `payload` and resolves once every other node
   * answered, at most `timeoutMs`; at once, unanswered, while the publishing
   * client is not connected or the broadcasts are degraded.
   */
  broadcast(event: string, payload: unknown): Promise<void>;
  /** True while broadcasts do not wait for answers. */
  degraded(): boolean;
  /** Stops probing: the server closes. */
  close(): void;
}

/** Options of {@link createClusterBroadcasts}. */
export interface ClusterBroadcastsOptions {
  readonly io: QuickdrawIo;
  readonly logger: Logger;
  /** How long a broadcast waits for every node's answer. Default 1,000. */
  readonly timeoutMs?: number;
  /** How often a degraded node probes. Default {@link PROBE_MS}; tests pass their own. */
  readonly probeMs?: number;
}

/** False while the adapter's publishing client says it is not connected. */
function publisherReady(io: QuickdrawIo): boolean {
  const adapter = io.sockets.adapter as { readonly pubClient?: unknown };
  return clusterClientOf(adapter.pubClient)?.isReady !== false;
}

/** Creates the answered broadcasts of the server `io`. */
export function createClusterBroadcasts(options: ClusterBroadcastsOptions): ClusterBroadcasts {
  const { io, logger } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_CLUSTER_TIMEOUT_MS;
  const probeMs = options.probeMs ?? PROBE_MS;
  let down = false;
  let probing = false;
  let closed = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  const stopProbing = (): void => {
    clearInterval(timer);
    timer = undefined;
  };

  const probe = async (): Promise<void> => {
    if (probing || !publisherReady(io)) {
      return;
    }
    probing = true;
    try {
      await within(io.serverSideEmitWithAck(PROBE_EVENT), timeoutMs);
      if (down) {
        down = false;
        stopProbing();
        logger.info("Every node answers broadcasts again; access changes wait for them again", {
          category: "quickdraw.cluster",
        });
      }
    } catch {
      // Still degraded: the next probe tries again.
    } finally {
      probing = false;
    }
  };

  const degrade = (error: unknown): void => {
    if (down) {
      return;
    }
    down = true;
    logger.error(
      "A node did not answer a broadcast in time; this node sends access changes without waiting for the other nodes until every node answers a probe",
      { category: "quickdraw.cluster", timeoutMs, error: describeError(error) },
    );
    if (!closed) {
      timer = setInterval(() => {
        void probe();
      }, probeMs);
      timer.unref?.();
    }
  };

  return Object.freeze({
    async broadcast(event: string, payload: unknown): Promise<void> {
      if (down || !publisherReady(io)) {
        io.serverSideEmit(event, payload);
        return;
      }
      try {
        await within(io.serverSideEmitWithAck(event, payload), timeoutMs);
      } catch (error) {
        degrade(error);
      }
    },
    degraded: () => down,
    close(): void {
      closed = true;
      stopProbing();
    },
  });
}

/** Answers other nodes' probes on `io`: at once, as a node that is up does. */
export function answerProbes(io: QuickdrawIo): void {
  io.on(PROBE_EVENT, (...rest: unknown[]) => {
    answerOf(rest)(true);
  });
}
