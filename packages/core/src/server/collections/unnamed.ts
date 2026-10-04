// The collection deltas a flush cannot address to a scope, across a cluster
// (RFC 0003 section 7.2, and the gap section 17 recorded for pack C): a row
// removed without the values that place it (a `ctx.touch` with `removed`, a
// `via` entry whose links a database cascade removed) left scopes nobody can
// name, and junction rows removed without values make every scope of their
// collection unsure. The flushing node sends `removed` (or `reset`) to every
// scope it has subscribers in; other nodes' scopes are not visible to it.
// Behind a cluster adapter it therefore also broadcasts what it could not
// address, and every other node sends the same deltas to its own subscribed
// scopes of the collection, to its own sockets only (a scope subscribed on
// both nodes may get them twice; a `removed` or `reset` repeated changes
// nothing on the client).

import { collectionRoom, SERVER_EVENTS } from "../../contract/names";
import type { CollectionDelta, CollectionFrame, Revision } from "../../protocol/envelope";
import type { CollectionHub } from "./bind";
import type { BoundCollection } from "./bind";
import type { Moves } from "./moves";

/** The server-to-server event unaddressed deltas are broadcast on behind a cluster adapter. */
export const UNNAMED_EVENT = "quickdraw:collection-unnamed";

/** What a flush could not address to a scope of one collection. */
export interface UnnamedDeltas {
  readonly s: string;
  readonly c: string;
  readonly rev: Revision;
  /** Rows that left scopes nobody can name: `removed` in every subscribed scope. */
  readonly removed: readonly string[];
  /** Junction rows went unseen: every subscribed scope resets. */
  readonly reset: boolean;
}

/** What the moves of one collection could not address, or `undefined` when they addressed everything. */
export function unnamedOf(
  collection: BoundCollection,
  moves: Moves,
  rev: Revision,
): UnnamedDeltas | undefined {
  const removed = moves.moves.filter((move) => move.unknownLeft).map((move) => move.id);
  if (removed.length === 0 && !moves.resetAll) {
    return undefined;
  }
  return { s: collection.service.name, c: collection.name, rev, removed, reset: moves.resetAll };
}

/** Behind a cluster adapter, tells the other nodes what the flush could not address. */
export function broadcastUnnamed(hub: CollectionHub, unnamed: UnnamedDeltas | undefined): void {
  if (unnamed !== undefined && hub.io !== undefined && !hub.probe.local()) {
    hub.io.serverSideEmit(UNNAMED_EVENT, unnamed);
  }
}

/** A broadcast read, or `undefined` for anything malformed. */
function readUnnamed(value: unknown): UnnamedDeltas | undefined {
  const { s, c, rev, removed, reset } = (value ?? {}) as Readonly<Record<string, unknown>>;
  const ids = Array.isArray(removed) && removed.every((id) => typeof id === "string");
  const valid = typeof s === "string" && typeof c === "string" && Number.isSafeInteger(rev) && ids;
  return valid && typeof reset === "boolean"
    ? { s, c, rev: rev as number, removed: removed as string[], reset }
    : undefined;
}

/** Sends another node's unaddressed deltas to every scope of the collection subscribed on this process. */
function sendHere(hub: CollectionHub, unnamed: UnnamedDeltas): void {
  const { io } = hub;
  const collection = hub.collections.routes.find(unnamed.s, unnamed.c);
  if (io === undefined || collection === undefined) {
    return;
  }
  const deltas: CollectionDelta[] = unnamed.reset
    ? [{ t: "reset" }]
    : unnamed.removed.map((id) => ({ t: "removed", id }));
  for (const scope of hub.collections.scopes.scopes(unnamed.s, unnamed.c)) {
    const room = collectionRoom(unnamed.s, unnamed.c, scope);
    const frame: CollectionFrame = { s: unnamed.s, c: unnamed.c, scope, rev: unnamed.rev, deltas };
    io.local.to(room).emit(SERVER_EVENTS.collection, frame);
    if (unnamed.reset) {
      hub.collections.buffer.reset(room, unnamed.rev);
    } else {
      hub.collections.buffer.record(room, unnamed.rev, deltas);
    }
  }
}

/** Listens for the deltas other nodes could not address, on the server the live data was given. */
export function listenForUnnamed(hub: CollectionHub): void {
  hub.io?.on(UNNAMED_EVENT, (broadcast: unknown) => {
    const unnamed = readUnnamed(broadcast);
    if (unnamed !== undefined && (unnamed.reset || unnamed.removed.length > 0)) {
      sendHere(hub, unnamed);
    }
  });
}
