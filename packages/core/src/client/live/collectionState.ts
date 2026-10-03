// The state of one collection scope as the cache holds it (RFC 0003 sections
// 7.3 and 7.4), and what reading it needs: the empty state, the items loaded
// in the order they are shown, and the items a reload left behind. Split from
// `collectionStore.ts`, which changes it (deltas, pages, items) and documents
// its rules, and `collectionSnapshot.ts` (snapshots).
//
// Pure functions, React-free.

import type { Revision } from "../../protocol/envelope";
import type { IndexRow } from "./collectionIndex";

/** An item of a collection: any object with a string `id`. */
export type CollectionItem = { readonly id: string };

/** What the cache holds for one collection scope. */
export interface CollectionState<Item extends CollectionItem = CollectionItem> {
  /** The items loaded, by id. */
  readonly byId: ReadonlyMap<string, Item>;
  /**
   * The ids of the items loaded, in order, while no index is held: the
   * server's order of the pages, then items that arrived later, in their
   * place by `order` when they carry its columns and last otherwise.
   */
  readonly order: readonly string[];
  /** The newest revision held for each member: a loaded item, or an index row. */
  readonly revById: ReadonlyMap<string, Revision>;
  /**
   * Tombstones: the revision each removed id was removed at, the latest
   * {@link MAX_TOMBSTONES} of them. A snapshot drops those it is newer than.
   */
  readonly removed: ReadonlyMap<string, Revision>;
  /** One row per member, in order, when the collection declares an index and the scope fits in it. */
  readonly index: readonly IndexRow[] | null;
  /** The scope has more members than an index holds (50,000): no index, and views run over loaded items. */
  readonly indexTruncated: boolean;
  /** The page size asked for was above the collection's `maxLimit`, and was lowered to it. */
  readonly clamped: boolean;
  /** The cursor of the next page; `null` after the last one. */
  readonly nextCursor: string | null;
  /** How many members the scope has; `null` before the first snapshot. */
  readonly totalCount: number | null;
  /** The revision of the last snapshot. */
  readonly snapshotRev: Revision;
  /** The newest revision applied to the scope: what a resume sends as `since`. */
  readonly rev: Revision;
}

/**
 * A page as the store reads it: the answer to `qd:col:sub` without `since`
 * (`CollectionSnapshot`), checked for its required fields only.
 */
export interface PageReply {
  readonly rev: Revision;
  readonly items: readonly unknown[];
  readonly total: number;
  readonly cursor: string | null;
  readonly clamped?: unknown;
  readonly index?: unknown;
  readonly indexTruncated?: unknown;
}

/**
 * The most tombstones a scope keeps. A tombstone keeps a frame, page or
 * items answer older than a removal from bringing the item back; those
 * arrive soon after it, so the oldest go first once a scope that is never
 * reloaded has removed this many items.
 */
export const MAX_TOMBSTONES = 1000;

/**
 * Records that `id` was removed at `rev` in `tombstones` (a copy being
 * written), as its newest entry, and drops the oldest past
 * {@link MAX_TOMBSTONES}.
 */
export function addTombstone(tombstones: Map<string, Revision>, id: string, rev: Revision): void {
  tombstones.delete(id);
  tombstones.set(id, rev);
  for (const oldest of tombstones.keys()) {
    if (tombstones.size <= MAX_TOMBSTONES) {
      return;
    }
    tombstones.delete(oldest);
  }
}

/** The state of a scope nothing arrived for yet. */
export function emptyCollection<Item extends CollectionItem>(): CollectionState<Item> {
  return Object.freeze({
    byId: new Map(),
    order: [],
    revById: new Map(),
    removed: new Map(),
    index: null,
    indexTruncated: false,
    clamped: false,
    nextCursor: null,
    totalCount: null,
    snapshotRev: 0,
    rev: 0,
  });
}

/** The ids of the items loaded, in the order they are shown. */
export function loadedIds(state: CollectionState<CollectionItem>): string[] {
  if (state.index === null) {
    return [...state.order];
  }
  return state.index.map((row) => row.id).filter((id) => state.byId.has(id));
}

/** Loaded items older than the last snapshot and not refreshed by it: their data may be out of date. */
export function staleIds(state: CollectionState<CollectionItem>): string[] {
  return loadedIds(state).filter((id) => (state.revById.get(id) ?? 0) < state.snapshotRev);
}

/**
 * Drops the loaded items a reload did not refresh, from a scope without an
 * index whose every page was read again after its last snapshot: an item
 * older than that snapshot was on none of its pages, in no delta and in no
 * items answer since, so it is no longer a member. Each leaves a tombstone
 * at the snapshot's revision; the count stays the server's. A state with an
 * index (whose snapshot already pruned by membership) is returned as it is.
 */
export function pruneStale<Item extends CollectionItem>(
  state: CollectionState<Item>,
): CollectionState<Item> {
  const stale = new Set(staleIds(state));
  if (stale.size === 0 || state.index !== null) {
    return state;
  }
  const byId = new Map(state.byId);
  const revById = new Map(state.revById);
  const removed = new Map(state.removed);
  for (const id of stale) {
    byId.delete(id);
    revById.delete(id);
    addTombstone(removed, id, state.snapshotRev);
  }
  return Object.freeze({
    ...state,
    byId,
    revById,
    removed,
    order: state.order.filter((id) => !stale.has(id)),
  });
}
