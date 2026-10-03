// Revoking change topic watches (RFC 0003 sections 4.4 and 11.3), beside the
// entity and collection revocations (`emit/revocation.ts`, which calls this
// on every access change it handles). A `qd:changed` carries no data, but it
// still tells a watcher when a scope changes: a socket that lost access to a
// scope must stop hearing about it. Each watch of a collection scope records
// the rows its access is derived from (its anchors); when a flush may have
// changed someone's level on one, the watches anchored there are authorized
// again, and a changed `serviceAccess` authorizes every watch of the user's
// sockets again, service topics included (`watchAccess: { service }`).
//
// A watch no longer allowed leaves the topic's room. No new frame kind says
// so: the socket gets one last `qd:changed` for the topic, its client reads
// the watching query again, and that read is refused. A lookup that fails
// denies, as everywhere else.

import { SERVER_EVENTS, topicRoom } from "../contract/names";
import { QuickdrawError } from "../protocol/errors";
import { authorizeWatch, type WatchTarget } from "./collections/access";
import type { CollectionHub } from "./collections/bind";
import type { RevocationHook } from "./emit/revocation";
import { describeError } from "./pipeline/metrics";
import { currentRev } from "./rev";
import type { TopicIndex, TopicWatch } from "./topicIndex";
import type { QuickdrawServerSocket } from "./transports/types";

/** What a watch names, or `NOT_FOUND`. */
export function targetOf(hub: CollectionHub, watch: TopicWatch): WatchTarget {
  const service = hub.registry.services.get(watch.s);
  if (service === undefined) {
    throw new QuickdrawError("NOT_FOUND", `Unknown service "${watch.s}"`);
  }
  if (service.model === undefined) {
    throw new QuickdrawError(
      "NOT_FOUND",
      `${watch.s} has no rows whose changes could be watched: it declares no model`,
    );
  }
  const { c, scope } = watch;
  if (c === undefined || scope === undefined) {
    return { kind: "service", service };
  }
  const collection = hub.collections.routes.find(watch.s, c);
  if (collection === undefined) {
    throw new QuickdrawError("NOT_FOUND", `${watch.s} has no collection "${c}"`);
  }
  return { kind: "collection", collection, scope };
}

/** The anchors the watch may keep, or `undefined` when it may no longer watch its topic. */
async function anchorsNow(
  hub: CollectionHub,
  socket: QuickdrawServerSocket,
  watch: TopicWatch,
): Promise<readonly string[] | undefined> {
  try {
    return await authorizeWatch(hub, socket.data.principal, targetOf(hub, watch));
  } catch (error) {
    if (!(error instanceof QuickdrawError) || error.code === "INTERNAL") {
      hub.logger.error("Authorizing a watched topic again failed; the watch is revoked", {
        category: "quickdraw.access",
        service: watch.s,
        topic: watch.topic,
        error: describeError(error),
      });
    }
    return undefined;
  }
}

/** Authorizes one watch again, and applies the answer. */
async function rewatch(
  hub: CollectionHub,
  index: TopicIndex,
  socket: QuickdrawServerSocket,
  watch: TopicWatch,
): Promise<void> {
  const anchors = await anchorsNow(hub, socket, watch);
  const room = topicRoom(watch.s, watch.topic);
  // Unwatched, watched again or authorized again meanwhile: that is newer than this.
  if (!socket.connected || index.get(socket, room) !== watch) {
    return;
  }
  if (anchors !== undefined) {
    index.watch(socket, { ...watch, anchors });
    return;
  }
  index.leave(socket, room);
  socket.emit(SERVER_EVENTS.changed, { s: watch.s, topic: watch.topic, rev: currentRev() });
}

/** Authorizes the given watches again, each socket's one by one. */
async function rewatchAll(
  hub: CollectionHub,
  index: TopicIndex,
  found: Iterable<readonly [QuickdrawServerSocket, readonly TopicWatch[]]>,
): Promise<void> {
  const work: Promise<void>[] = [];
  for (const [socket, watches] of found) {
    for (const watch of watches) {
      work.push(rewatch(hub, index, socket, watch));
    }
  }
  await Promise.all(work);
}

/** The topic half of a dispatcher's revocation. */
export function createTopicRevocation(hub: CollectionHub, index: TopicIndex): RevocationHook {
  return Object.freeze({
    changed: async (change) => await rewatchAll(hub, index, index.matching(change)),
    regranted: async (sockets) =>
      await rewatchAll(
        hub,
        index,
        sockets.map((socket) => [socket, index.entries(socket)] as const),
      ),
  } satisfies RevocationHook);
}
