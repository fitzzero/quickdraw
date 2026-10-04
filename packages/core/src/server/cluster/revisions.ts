// The revisions of one dispatcher's live data (RFC 0003 section 5.3, step 2,
// and pack H's shared flush order). On one server they are the process's
// clock (`../rev.ts`), as they always were. Behind a cluster adapter whose
// Valkey (or Redis) client the server can reach (the Socket.IO Redis
// adapter's publishing client, or `cluster.client`), they come from the
// cluster's shared counter (`counter.ts`) instead:
//
// - a flush asks the counter for its revision the moment it is handed to
//   the dispatcher's sinks, one round trip, and its sinks run once it
//   answered, still in arrival order (`../uow/flush.ts`), so a payload is
//   never older than its revision claims and frames leave each process in
//   revision order; across nodes, revisions are one total order;
// - a read that claims a revision (a subscription's rows, a page, a search,
//   a row sent again after a level change) reads the counter first: the
//   last revision any node took, so a write with a revision up to it
//   committed before the read, and any later one gets a greater one. The
//   process's own last revision would not do: a quiet node's is old, and a
//   client holding a newer frame from another node would keep its stale row;
// - when Valkey does not answer, the node falls back to its own clock (one
//   error logged per outage), still never below a revision it issued, and
//   reads claim its clock too (`max(now, the last revision this process
//   took, the last it issued)`): comparisons with other nodes' hold within
//   the skew between this node's clock and Valkey's (the counter keeps to
//   Valkey's clock) until the counter answers again. A key Valkey does not
//   have (none taken since it was made or lost) is read the same way, never
//   as 0.

import type { Logger } from "../../contract/logger";
import type { Revision } from "../../protocol/envelope";
import { clockRev, currentRev, nextRev, observeRev } from "../rev";
import type { QuickdrawIo } from "../transports/types";
import {
  clusterClientOf,
  createSharedCounter,
  type ClusterClient,
  type SharedCounter,
} from "./counter";

export type { ClusterBroadcasts } from "./broadcasts";
export type { ClusterClient } from "./counter";

/** An ioredis client, as the cluster helpers use one. */
export interface IoRedisLike {
  call(command: string, ...args: string[]): Promise<unknown>;
  readonly status: string;
}

/** `createServer`'s `cluster` option: where a cluster's shared state lives, behind a cluster adapter. */
export interface ClusterOptions {
  /**
   * The Valkey or Redis client of the shared revision counter and of the
   * users' last-seen times: a node-redis or ioredis client. Default: the
   * publishing client of the Socket.IO Redis adapter (`setupRedisAdapter`,
   * or `createAdapter(pub, sub)` in `socket.adapter`). Without one, behind
   * another adapter, revisions stay per process.
   */
  readonly client?: ClusterClient | IoRedisLike;
  /** The prefix of the cluster's keys (`{keyPrefix}:rev`, `{keyPrefix}:seen:{userId}`). Default `"quickdraw"`. */
  readonly keyPrefix?: string;
  /**
   * How long a counter command may take before the node takes its revision
   * from its own clock, in milliseconds. Default 1,000.
   */
  readonly timeoutMs?: number;
}

/** What the revisions read of the hub they belong to. */
export interface RevisionHub {
  readonly io: QuickdrawIo | undefined;
  readonly probe: { local(): boolean };
  readonly logger: Logger;
  cluster: ClusterOptions | undefined;
}

/** The revisions of one dispatcher. */
export interface Revisions {
  /**
   * Called when a flush is handed to the sinks: `undefined` when revisions
   * are the process's (the flush keeps the one it took), else a function to
   * call when the flush's turn comes, which resolves with its revision.
   */
  forFlush(): (() => Promise<Revision>) | undefined;
  /**
   * The revision a read made from now on is no older than: at once on one
   * server; behind a counter its last revision, or the clock's when it does
   * not answer or has no key. Never 0.
   */
  claim(): Revision | Promise<Revision>;
  /** Behind a counter, the counter's revision when it moved past `rev`; `undefined` otherwise. */
  movedPast(rev: Revision): Promise<Revision | undefined>;
  /** True when revisions come from the cluster's counter: the process's change log sees only its own flushes. */
  shared(): boolean;
  /** The counter, when there is one: a user's last-seen time lives beside it. */
  counterClient(): { readonly client: ClusterClient; readonly keyPrefix: string } | undefined;
}

/** The default prefix of a cluster's keys. */
export const DEFAULT_KEY_PREFIX = "quickdraw";

/** A cluster client found for the hub: as given, and as the helpers use it. */
interface Found {
  readonly raw: object;
  readonly client: ClusterClient;
  readonly keyPrefix: string;
}

/** Creates the revisions of the hub. */
export function createRevisions(hub: RevisionHub): Revisions {
  const found = new WeakMap<object, Found>();
  const counters = new WeakMap<object, SharedCounter>();
  /** The highest revision this dispatcher gave a flush: the floor of its next one. */
  let issued = 0;

  /** The cluster's client: `cluster.client`, or the Redis adapter's publishing client. */
  const target = (): Found | undefined => {
    if (hub.probe.local()) {
      return undefined;
    }
    const adapter = hub.io?.sockets.adapter as { readonly pubClient?: unknown } | undefined;
    const raw: unknown = hub.cluster?.client ?? adapter?.pubClient;
    if (typeof raw !== "object" || raw === null) {
      return undefined;
    }
    let entry = found.get(raw);
    const client = entry === undefined ? clusterClientOf(raw) : entry.client;
    if (entry === undefined && client !== undefined) {
      entry = { raw, client, keyPrefix: hub.cluster?.keyPrefix ?? DEFAULT_KEY_PREFIX };
      found.set(raw, entry);
    }
    return entry;
  };

  const counterOf = (): SharedCounter | undefined => {
    const entry = target();
    if (entry === undefined) {
      return undefined;
    }
    let counter = counters.get(entry.raw);
    if (counter === undefined) {
      counter = createSharedCounter({
        client: entry.client,
        key: `${entry.keyPrefix}:rev`,
        logger: hub.logger,
        timeoutMs: hub.cluster?.timeoutMs,
      });
      counters.set(entry.raw, counter);
    }
    return counter;
  };

  /** The flush's revision: the counter's answer, or the clock's; above every one issued before. */
  const assign = (answer: Revision | undefined): Revision => {
    const rev = Math.max(answer ?? nextRev(), issued + 1);
    issued = rev;
    observeRev(rev);
    return rev;
  };

  /** The revision a read claims: the counter's, or without one (no answer, no key) the clock's. */
  const fresh = (value: Revision | null | undefined): Revision => {
    const rev = Math.max(value ?? Math.max(clockRev(), currentRev()), issued);
    observeRev(rev);
    return rev;
  };

  return Object.freeze({
    forFlush() {
      const counter = counterOf();
      if (counter === undefined) {
        return undefined;
      }
      // Asked now, in arrival order: one connection answers in order.
      const answer = counter.next(issued);
      return async () => assign(await answer);
    },
    claim() {
      const counter = counterOf();
      return counter === undefined ? currentRev() : counter.current().then(fresh);
    },
    async movedPast(rev: Revision) {
      // No answer: nothing reaches this node from the others either. No key: no node took a
      // revision since it was made or lost.
      const value = await counterOf()?.current();
      return typeof value === "number" && value > rev ? fresh(value) : undefined;
    },
    shared: () => counterOf() !== undefined,
    counterClient: () => {
      const entry = target();
      return entry === undefined ? undefined : { client: entry.client, keyPrefix: entry.keyPrefix };
    },
  });
}
