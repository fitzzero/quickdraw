// Sending collection frames (RFC 0003 sections 5.3 and 7.2), and the scopes a
// flush closes or resets rather than updates:
//
// - every frame goes to the scope's room as `qd:c { s, c, scope, rev,
//   deltas }`, and into the scope's resume buffer;
// - deleting the row a scope is anchored on (a chat, for its messages) sends
//   `qd:revoked { kind: "collection", reason: "anchor-deleted" }` to every
//   scope room keyed by that row's id and empties those rooms: the rows a
//   database cascade removed with it produce no tracked writes, so closing
//   the scope is the whole answer, and nothing else goes to it;
// - when the flush failed (this sink or another one), every scope its writes
//   name gets a `reset`, and a collection whose writes name no scope (a
//   touch, a `via` entry) resets every scope subscribed on this process;
// - a collection nobody on this process subscribes to (with rooms visible
//   here) reads and sends nothing: the scopes its writes name lose their
//   resume from before the flush, and a write that names none (a touch, a
//   `via` entry, an `affects` hop) costs the whole collection its resume.
//
// 4.1 offered these as hand-written calls (`emitCollectionReset`,
// `kickFromCollection`; `legacy-src/server/collections.ts:300-318`).

import { collectionRoom, SERVER_EVENTS } from "../../contract/names";
import type { CollectionDelta, CollectionFrame, Revision } from "../../protocol/envelope";
import { modelKey } from "../storage";
import type { WriteRecord } from "../uow/types";
import type { BoundCollection, CollectionHub } from "./bind";
import { groupOf } from "./scopes";

type Io = NonNullable<CollectionHub["io"]>;

/** Sends one scope's frame for a flush and keeps it for resumes; a `reset` frame resets the buffer. */
export function sendFrame(
  hub: CollectionHub,
  io: Io | undefined,
  collection: BoundCollection,
  scope: string,
  rev: Revision,
  deltas: readonly CollectionDelta[],
): void {
  if (deltas.length === 0) {
    return;
  }
  const s = collection.service.name;
  const room = collectionRoom(s, collection.name, scope);
  const frame: CollectionFrame = { s, c: collection.name, scope, rev, deltas };
  io?.to(room).emit(SERVER_EVENTS.collection, frame);
  if (deltas.some((delta) => delta.t === "reset")) {
    hub.collections.buffer.reset(room, rev);
  } else {
    hub.collections.buffer.record(room, rev, deltas);
  }
}

/** Revokes every subscription to one scope whose anchor row was deleted, and empties its room. */
function closeScope(
  hub: CollectionHub,
  io: Io,
  collection: BoundCollection,
  scope: string,
  rev: Revision,
): void {
  const s = collection.service.name;
  const room = collectionRoom(s, collection.name, scope);
  hub.collections.buffer.reset(room, rev);
  const local = [...(io.sockets.adapter.rooms.get(room) ?? [])];
  if (local.length === 0 && hub.probe.local()) {
    return;
  }
  io.to(room).emit(SERVER_EVENTS.revoked, {
    kind: "collection",
    reason: "anchor-deleted",
    s,
    c: collection.name,
    scope,
  });
  for (const socketId of local) {
    const socket = io.sockets.sockets.get(socketId);
    if (socket !== undefined) {
      hub.collections.scopes.delete(socket, room);
    }
  }
  // Behind a cluster adapter, the other nodes' sockets leave too.
  io.in(room).socketsLeave(room);
}

/** Closes the scopes keyed by each row the flush deleted that collections are anchored on; returns their rooms. */
export function closeAnchors(
  hub: CollectionHub,
  io: Io,
  writes: readonly WriteRecord[],
  rev: Revision,
): Set<string> {
  const closed = new Set<string>();
  for (const write of writes) {
    const anchored = hub.collections.routes.byAnchorModel.get(modelKey(write.model));
    if (write.op !== "delete" || anchored === undefined) {
      continue;
    }
    for (const collection of anchored) {
      closed.add(collectionRoom(collection.service.name, collection.name, write.id));
      closeScope(hub, io, collection, write.id, rev);
    }
  }
  return closed;
}

/** The scopes a write's values name in a collection, or `undefined` when they name none. */
function namedScopes(collection: BoundCollection, write: WriteRecord): string[] | undefined {
  const { scope } = collection;
  const junction = scope.kind === "via" && modelKey(write.model) === modelKey(scope.model);
  if (scope.kind === "via" && !junction) {
    return undefined;
  }
  const column = scope.kind === "column" ? scope.column : scope.scope;
  const named = [write.before?.[column], write.after?.[column]].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return named.length === 0 ? undefined : named;
}

/**
 * The flush changed a collection nobody here subscribes to: no frame, and no
 * resume from before it of the scopes it changed. `refresh` are rows only an
 * `affects` hop touched.
 */
export function skipTouched(
  hub: CollectionHub,
  collection: BoundCollection,
  writes: readonly WriteRecord[],
  refresh: readonly string[],
  rev: Revision,
): void {
  const s = collection.service.name;
  const { scope } = collection;
  const junction = scope.kind === "via" ? modelKey(scope.model) : undefined;
  const concerns = (write: WriteRecord): boolean => {
    const model = modelKey(write.model);
    return model === collection.model || model === junction;
  };
  let unnamed = refresh.length > 0;
  for (const write of writes.filter(concerns)) {
    const named = namedScopes(collection, write);
    unnamed ||= named === undefined;
    for (const value of named ?? []) {
      hub.collections.buffer.skip(collectionRoom(s, collection.name, value), rev);
    }
  }
  if (unnamed) {
    hub.collections.buffer.skipAll(groupOf(s, collection.name));
  }
}

/** Sends a `reset` to every scope the flush's writes touched: the flush failed. */
export function resetTouched(
  hub: CollectionHub,
  io: Io,
  writes: readonly WriteRecord[],
  rev: Revision,
): void {
  const touched = new Map<BoundCollection, Set<string>>();
  const { routes } = hub.collections;
  for (const write of writes) {
    const key = modelKey(write.model);
    for (const collection of [
      ...(routes.byModel.get(key) ?? []),
      ...(routes.byJunction.get(key) ?? []),
    ]) {
      const scopes =
        namedScopes(collection, write) ??
        hub.collections.scopes.scopes(collection.service.name, collection.name);
      touched.set(collection, new Set([...(touched.get(collection) ?? []), ...scopes]));
    }
  }
  for (const [collection, scopes] of touched) {
    for (const scope of scopes) {
      sendFrame(hub, io, collection, scope, rev, [{ t: "reset" }]);
    }
  }
}
