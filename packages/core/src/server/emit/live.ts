// The live data of one dispatcher (RFC 0003 sections 4.4, 5.3, 6, 7 and
// 11.3): entity subscriptions, collection scopes and change topics, the
// frames flushes send them, revocation, and "not modified" versions. A
// dispatcher makes one; `createServer` attaches its Socket.IO server and
// serves `qd:sub`, `qd:col:sub`, `qd:col:items` and `qd:watch` with it.
// Without a server the sinks still keep the change log, so in-process callers
// get versions too.

import type { AnyContract } from "../../contract/defineContract";
import { createLiveCollections } from "../collections/live";
import type { RoomOccupancy } from "../context";
import { describeError } from "../pipeline/metrics";
import { createTopics } from "../topics";
import { createEntitySinks } from "./entitySink";
import { entitySubscriptions } from "./extension";
import { createHub, type AdapterProbe, type Hub, type HubOptions } from "./hub";
import { ACCESS_CHANGED_EVENT, createRevocation } from "./revocation";
import { createVersionSource } from "./versions";

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
   * `qd:col:unsub`, `qd:watch` and `qd:unwatch` on every v5 socket.
   */
  readonly extension: ReturnType<typeof entitySubscriptions>;
  /**
   * Gives the live data its Socket.IO server: frames go out on it, and
   * access changes broadcast by other nodes arrive on it. What such a change
   * names is evicted from the access cache (`cacheMs`) before it is resolved
   * again.
   */
  attach(io: NonNullable<Hub["io"]>, probe: AdapterProbe): void;
  /**
   * Re-resolves the subscriptions of `userId`'s sockets on this process after
   * their grants changed, reading the user's levels afresh.
   */
  regranted(userId: string): Promise<void>;
  /** Sends a `reset` to one scope of a collection: `dispatcher.collections.reset`. */
  resetCollection(contract: AnyContract, collection: string, scope: string): void;
  /** The sockets in a room of the attached server, for the kits (`KitRuntime.occupancy`). */
  readonly occupancy: RoomOccupancy;
}

type Change = Parameters<ReturnType<typeof createRevocation>["changed"]>[0];

/** The access change another node broadcast, `{ service, id?, userId? }`, or `undefined` for anything else. */
function readChange(value: unknown): Change | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const { service, id, userId } = value as Readonly<Record<string, unknown>>;
  if (typeof service !== "string" || service.length === 0) {
    return undefined;
  }
  return {
    service,
    ...(typeof id === "string" && id.length > 0 ? { id } : {}),
    ...(typeof userId === "string" && userId.length > 0 ? { userId } : {}),
  };
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
  const revocation = createRevocation(hub, [collections.revocation, topics.revocation]);
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
    },
    attach(io: NonNullable<Hub["io"]>, probe: AdapterProbe): void {
      hub.io = io;
      hub.probe = probe;
      io.on(ACCESS_CHANGED_EVENT, (broadcast: unknown) => {
        const change = readChange(broadcast);
        if (change !== undefined) {
          // Another node flushed the write, so this node's cache still holds what it changed.
          options.policies.forget(change);
          revocation.changed(change, true).catch((error: unknown) => {
            hub.logger.error("Revoking for an access change another node broadcast failed", {
              category: "quickdraw.access",
              service: change.service,
              error: describeError(error),
            });
          });
        }
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
    occupancy: Object.freeze({
      sockets: (room: string) => hub.io?.sockets.adapter.rooms.get(room)?.size ?? 0,
      complete: () => hub.io === undefined || hub.probe.local(),
    }),
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
