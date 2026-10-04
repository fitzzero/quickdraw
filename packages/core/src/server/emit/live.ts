// The live data of one dispatcher (RFC 0003 sections 4.4, 5.3, 6, 7, 11.3
// and 12.5): entity subscriptions, collection scopes and change topics, the
// frames flushes send them, revocation, "not modified" versions, and the
// realtime half (presence, streams, channels and typed room events). A
// dispatcher makes one; `createServer` attaches its Socket.IO server and
// serves `qd:sub`, `qd:col:sub`, `qd:col:items`, `qd:watch`, `qd:stream:sub`
// and `qd:ch` with it. Without a server the sinks still keep the change log,
// so in-process callers get versions too.

import type { AnyContract } from "../../contract/defineContract";
import { createLiveCollections } from "../collections/live";
import {
  createRealtime,
  type Presence,
  type Realtime,
  type StreamHandle,
} from "../realtime/realtime";
import { createTopics } from "../topics";
import { createEntitySinks } from "./entitySink";
import { entitySubscriptions } from "./extension";
import { createHub, drain, type AdapterProbe, type Hub, type HubOptions } from "./hub";
import { createRevocation, listenForChanges } from "./revocation";
import { createVersionSource } from "./versions";

export type { Presence, StreamHandle };

type Sinks = ReturnType<typeof createEntitySinks>;

type Collections = ReturnType<typeof createLiveCollections>;

/** The live data of one dispatcher. */
export interface Live {
  /** Records the rows a flush touched in the change log; goes before the access sink. */
  readonly intake: Sinks["intake"];
  /** Sends the flush's entity frames; goes after the access sink. */
  readonly emit: Sinks["emit"];
  /** Sends the flush's collection deltas; goes after `emit`. */
  readonly collections: Collections["sink"];
  /** Sends `qd:changed` for the flush's change topics; goes after `collections`. */
  readonly topics: ReturnType<typeof createTopics>["sink"];
  /** "Not modified" for queries returning one projection row: the dispatcher's default `versions`. */
  readonly versions: ReturnType<typeof createVersionSource>;
  /**
   * Serves `qd:sub`, `qd:unsub`, `qd:col:sub`, `qd:col:items`,
   * `qd:col:unsub`, `qd:watch`, `qd:unwatch`, `qd:stream:sub`,
   * `qd:stream:unsub` and `qd:ch` on every v5 socket.
   */
  readonly extension: ReturnType<typeof entitySubscriptions>;
  /** Presence, streams, channels and typed room events: `ctx.rooms`, `ctx.presence`, `qd.stream`. */
  readonly realtime: Realtime;
  /** The revisions flushes take and reads claim: the process's clock, or a cluster's shared counter. */
  readonly revisions: Hub["revisions"];
  /**
   * Gives the live data its Socket.IO server: frames go out on it, and
   * access changes broadcast by other nodes arrive on it. What such a change
   * names is evicted from the access cache (`cacheMs`) before it is resolved
   * again. `cluster` says where a cluster's shared state lives, and
   * `broadcasts` sends access changes to the other nodes.
   */
  attach(
    io: NonNullable<Hub["io"]>,
    probe: AdapterProbe,
    cluster?: Hub["cluster"],
    broadcasts?: Hub["broadcasts"],
  ): void;
  /**
   * Re-resolves the subscriptions of `userId`'s sockets on this process after
   * their grants changed, reading the user's levels afresh.
   */
  regranted(userId: string): Promise<void>;
  /** Sends a `reset` to one scope of a collection: `dispatcher.collections.reset`. */
  resetCollection(contract: AnyContract, collection: string, scope: string): void;
  /** Resolves once the work the live data started for sockets' events has settled: a server's `close()`. */
  drain(): Promise<void>;
  /** The sockets in a room of the attached server, for the kits (`KitRuntime.occupancy`). */
  readonly occupancy: Realtime["occupancy"];
}

/**
 * Creates a dispatcher's live data. Throws a `TypeError` for an `affects` it
 * cannot follow, or a collection anchor it cannot authorize through.
 */
export function createLive(options: HubOptions): Live {
  const hub = createHub(options);
  const collections = createLiveCollections(hub);
  const topics = createTopics(collections.hub);
  const sinks = createEntitySinks(hub);
  const realtime = createRealtime(hub);
  const revocation = createRevocation(hub, [
    collections.revocation,
    topics.revocation,
    realtime.revocation,
  ]);
  const entities = entitySubscriptions(hub);
  options.policies.onAccessChanged((change) => revocation.changed(change, false));
  return Object.freeze({
    intake: sinks.intake,
    emit: sinks.emit,
    collections: collections.sink,
    topics: topics.sink,
    versions: createVersionSource(hub),
    extension: (...args: Parameters<typeof entities>): void => {
      entities(...args);
      collections.extension(...args);
      topics.extension(...args);
      realtime.extension(...args);
    },
    realtime,
    revisions: hub.revisions,
    attach(
      io: NonNullable<Hub["io"]>,
      probe: AdapterProbe,
      cluster?: Hub["cluster"],
      broadcasts?: Hub["broadcasts"],
    ): void {
      hub.io = io;
      hub.probe = probe;
      hub.cluster = cluster;
      hub.broadcasts = broadcasts;
      collections.listen();
      realtime.listen();
      listenForChanges(hub, revocation, (change) => {
        options.policies.forget(change);
      });
    },
    regranted: (userId: string) => {
      // The grants may come with writes this node's cache has not seen: read the user's levels afresh.
      options.policies.forget({ userId });
      return revocation.regranted(userId);
    },
    resetCollection: (contract: AnyContract, collection: string, scope: string) => {
      collections.reset(contract, collection, scope);
    },
    occupancy: realtime.occupancy,
    drain: () => drain(hub),
  });
}

const LIVES = new WeakMap<object, Live>();

/** Marks `dispatcher` as having `live` for its live data. */
export function registerLive(dispatcher: object, live: Live): void {
  LIVES.set(dispatcher, live);
}

/** The live data of a dispatcher `createDispatcher` returned. */
export function liveOf(dispatcher: object): Live | undefined {
  return LIVES.get(dispatcher);
}
