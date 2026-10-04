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
// nothing on the client). A row that exists again when the flushing node
// reads it (its id created again by a write whose flush went first) is not
// removed from the scopes it is in at that read (`kept`): that node sends
// it there itself.

import { collectionRoom, SERVER_EVENTS } from "../../contract/names";
import type { CollectionDelta, CollectionFrame, Revision } from "../../protocol/envelope";
import type { StorageRow } from "../storage";
import type { CollectionHub } from "./bind";
import type { BoundCollection } from "./bind";
import { scopeIn } from "./items";
import type { Move, Moves } from "./moves";

/** The server-to-server event unaddressed deltas are broadcast on behind a cluster adapter. */
export const UNNAMED_EVENT = "quickdraw:collection-unnamed";

/** What a flush could not address to a scope of one collection. */
export interface UnnamedDeltas {
  readonly s: string;
  readonly c: string;
  readonly rev: Revision;
  /** Rows that left scopes nobody can name: `removed` in every subscribed scope. */
  readonly removed: readonly string[];
  /** `[id, scope]`: a scope one of those rows is in at the flush's read, which keeps it. */
  readonly kept?: readonly (readonly [string, string])[];
  /** Junction rows went unseen: every subscribed scope resets. */
  readonly reset: boolean;
}

/**
 * The scopes a row that left scopes nobody can name is in at the flush's
 * read: its column's scope, or the `via` links its move found; none when the
 * row is gone.
 */
function keptScopes(
  collection: BoundCollection,
  move: Move,
  row: StorageRow | undefined,
): readonly string[] {
  if (row === undefined) {
    return [];
  }
  if (collection.scope.kind !== "column") {
    return [...move.entered, ...move.stayed];
  }
  const scope = scopeIn(collection, row);
  return typeof scope === "string" ? [scope] : [];
}

/**
 * What the moves of one collection could not address, or `undefined` when
 * they addressed everything. `rows`, the rows read for the flush's frames
 * behind a cluster adapter, name the scopes such a row is in again.
 */
export function unnamedOf(
  collection: BoundCollection,
  moves: Moves,
  rev: Revision,
  rows?: ReadonlyMap<string, StorageRow>,
): UnnamedDeltas | undefined {
  const unknown = moves.moves.filter((move) => move.unknownLeft);
  if (unknown.length === 0 && !moves.resetAll) {
    return undefined;
  }
  const kept = unknown.flatMap((move) =>
    keptScopes(collection, move, rows?.get(move.id)).map((scope) => [move.id, scope] as const),
  );
  return {
    s: collection.service.name,
    c: collection.name,
    rev,
    removed: unknown.map((move) => move.id),
    ...(kept.length > 0 ? { kept } : {}),
    reset: moves.resetAll,
  };
}

/** Behind a cluster adapter, tells the other nodes what the flush could not address. */
export function broadcastUnnamed(hub: CollectionHub, unnamed: UnnamedDeltas | undefined): void {
  if (unnamed !== undefined && hub.io !== undefined && !hub.probe.local()) {
    hub.io.serverSideEmit(UNNAMED_EVENT, unnamed);
  }
}

function isPair(value: unknown): value is readonly [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    typeof value[0] === "string" &&
    typeof value[1] === "string"
  );
}

/** A broadcast read, or `undefined` for anything malformed. */
function readUnnamed(value: unknown): UnnamedDeltas | undefined {
  const { s, c, rev, removed, kept, reset } = (value ?? {}) as Readonly<Record<string, unknown>>;
  const ids = Array.isArray(removed) && removed.every((id) => typeof id === "string");
  const pairs = kept === undefined || (Array.isArray(kept) && kept.every(isPair));
  const valid = typeof s === "string" && typeof c === "string" && Number.isSafeInteger(rev) && ids;
  return valid && pairs && typeof reset === "boolean"
    ? {
        s,
        c,
        rev: rev as number,
        removed: removed as string[],
        ...(kept === undefined ? {} : { kept: kept as [string, string][] }),
        reset,
      }
    : undefined;
}

/** The deltas one scope gets of another node's unaddressed ones: none for a row it keeps. */
function deltasFor(
  unnamed: UnnamedDeltas,
  kept: ReadonlySet<string>,
  scope: string,
): CollectionDelta[] {
  if (unnamed.reset) {
    return [{ t: "reset" }];
  }
  return unnamed.removed
    .filter((id) => !kept.has(`${id}\u0000${scope}`))
    .map((id) => ({ t: "removed", id }));
}

/** Sends another node's unaddressed deltas to every scope of the collection subscribed on this process. */
function sendHere(hub: CollectionHub, unnamed: UnnamedDeltas): void {
  const { io } = hub;
  const collection = hub.collections.routes.find(unnamed.s, unnamed.c);
  if (io === undefined || collection === undefined) {
    return;
  }
  const kept = new Set((unnamed.kept ?? []).map(([id, scope]) => `${id}\u0000${scope}`));
  for (const scope of hub.collections.scopes.scopes(unnamed.s, unnamed.c)) {
    const deltas = deltasFor(unnamed, kept, scope);
    if (deltas.length === 0) {
      continue;
    }
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
