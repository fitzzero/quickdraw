// The live data of one dispatcher (RFC 0003 sections 4.4, 5.3 and 6): entity
// subscriptions, the frames flushes send them, revocation, and "not modified"
// versions. A dispatcher makes one; `createServer` attaches its Socket.IO
// server and serves `qd:sub` with it. Without a server the sinks still keep
// the change log, so in-process callers get versions too.

import { createEntitySinks } from "./entitySink";
import { entitySubscriptions } from "./extension";
import { createHub, type AdapterProbe, type Hub, type HubOptions } from "./hub";
import { ACCESS_CHANGED_EVENT, createRevocation } from "./revocation";
import { createVersionSource } from "./versions";

type Sinks = ReturnType<typeof createEntitySinks>;

/** The live data of one dispatcher. */
export interface Live {
  /** Records the rows a flush touched in the change log; goes before the access sink. */
  readonly intake: Sinks["intake"];
  /** Sends the flush's entity frames; goes after the access sink. */
  readonly emit: Sinks["emit"];
  /** "Not modified" for queries returning one projection row: the dispatcher's default `versions`. */
  readonly versions: ReturnType<typeof createVersionSource>;
  /** Serves `qd:sub` and `qd:unsub` on every v5 socket. */
  readonly extension: ReturnType<typeof entitySubscriptions>;
  /**
   * Gives the live data its Socket.IO server: frames go out on it, and
   * access changes broadcast by other nodes arrive on it.
   */
  attach(io: NonNullable<Hub["io"]>, probe: AdapterProbe): void;
  /** Re-resolves the subscriptions of `userId`'s sockets on this process after their grants changed. */
  regranted(userId: string): Promise<void>;
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

/** Creates a dispatcher's live data. Throws a `TypeError` for an `affects` it cannot follow. */
export function createLive(options: HubOptions): Live {
  const hub = createHub(options);
  const sinks = createEntitySinks(hub);
  const revocation = createRevocation(hub);
  options.policies.onAccessChanged((change) => revocation.changed(change, false));
  return Object.freeze({
    intake: sinks.intake,
    emit: sinks.emit,
    versions: createVersionSource(hub),
    extension: entitySubscriptions(hub),
    attach(io: NonNullable<Hub["io"]>, probe: AdapterProbe): void {
      hub.io = io;
      hub.probe = probe;
      io.on(ACCESS_CHANGED_EVENT, (broadcast: unknown) => {
        const change = readChange(broadcast);
        if (change !== undefined) {
          void revocation.changed(change, true);
        }
      });
    },
    regranted: (userId: string) => revocation.regranted(userId),
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
