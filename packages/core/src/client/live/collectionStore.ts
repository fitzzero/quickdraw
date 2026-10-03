// How a collection scope's cached state changes (RFC 0003 sections 7.2 to
// 7.4): the merge logic behind `useCollection`, free of React and sockets so
// every rule is tested on its own. Ported from 4.1's collection cache
// (`legacy-src/client/collectionCache.ts`), whose rules hold:
//
// - everything is keyed by id, so live deltas and pages loaded later compose;
// - per item, the newest revision wins: a delta older than what the state
//   holds for that id is ignored, and a snapshot or page item overwrites
//   only what is not newer than the page;
// - a removal leaves a tombstone at its revision, so an older `added` or
//   page cannot bring the item back; a snapshot at or after the tombstone
//   drops it. A scope keeps the latest 1,000 (`MAX_TOMBSTONES`), and a
//   frame that removes nothing shares them with the state before it rather
//   than copying them.
//
// and adds what 5.0's protocol carries:
//
// - one revision per frame (`qd:c { rev, deltas }`): the deltas of a frame,
//   and of a resume reply, share it and apply in the order sent, so with
//   equal revisions the later one wins;
// - `added` for an id already held is an upsert (a touch), and changes no
//   count;
// - the count is the server's `total`, changed only by `added` and
//   `removed`: `updated` and `patched` name members the total already holds;
// - `patched` merges the changed fields into the item. With no item held it
//   never makes a partial one: the id is reported `missing`, for the
//   controller to load with `qd:col:items`, unless only the index holds the
//   member and the whole scope is not being loaded;
// - without an index, a member a page has not loaded yet is beyond the items
//   shown: `updated` and `patched` for it are ignored while more pages
//   follow, unless the whole scope is being loaded, so they never put an
//   item into a paged window out of its place;
// - the index (`collectionIndex.ts`): the snapshot's rows are the scope's
//   membership, so items of non-members are pruned as 4.1 pruned by `ids`;
//   `added` brings its row, and `patched` and `updated` change its fields
//   and its place; a row newer than the snapshot is kept over it;
// - `clamped` and `indexTruncated` from the snapshot.
//
// The state's shape and the helpers that read it are in `collectionState.ts`,
// snapshots in `collectionSnapshot.ts`; this module re-exports both, and
// applies deltas, later pages and items loaded by id.
//
// Pure functions, React-free.

import type { CollectionDelta, Revision } from "../../protocol/envelope";
import { isRecord } from "../../protocol/guards";
import {
  hasId,
  hasOrderValues,
  indexRowFromItem,
  indexRowOf,
  insertionPoint,
  insertionPointBy,
  patchIndexRow,
  positionOf,
  type CollectionShape,
  type IndexRow,
} from "./collectionIndex";
import {
  addTombstone,
  emptyCollection,
  type CollectionItem,
  type CollectionState,
  type PageReply,
} from "./collectionState";

export { applySnapshot } from "./collectionSnapshot";
export {
  MAX_TOMBSTONES,
  emptyCollection,
  loadedIds,
  pruneStale,
  staleIds,
  type CollectionItem,
  type CollectionState,
  type PageReply,
} from "./collectionState";

/** What applying deltas did. */
export interface DeltaResult<Item extends CollectionItem = CollectionItem> {
  /** The new state: the same object when nothing changed. */
  readonly state: CollectionState<Item>;
  /** A `reset` arrived: load the scope again. */
  readonly reset: boolean;
  /** Ids a `patched` delta found no item for, to load with `qd:col:items`. */
  readonly missing: readonly string[];
}

/** Options of {@link applyDeltas}. */
export interface DeltaOptions {
  /** True while the whole scope is loaded: a patch of a member only the index holds loads its item. */
  readonly loadAll?: boolean;
}

/** A copy of a state that one batch of changes is made on. */
interface Work<Item extends CollectionItem> {
  readonly shape: CollectionShape;
  readonly byId: Map<string, Item>;
  readonly order: string[];
  readonly revById: Map<string, Revision>;
  /**
   * The tombstones: the base state's own map until the batch changes one,
   * when `tombstones` copies it, so a frame that removes nothing shares it.
   */
  removed: ReadonlyMap<string, Revision>;
  /** True once `removed` is this batch's copy. */
  removedCopied: boolean;
  readonly index: IndexRow[] | null;
  /** The index's rows by id, made on first use. */
  indexById: Map<string, IndexRow> | undefined;
  totalCount: number | null;
  /** More pages follow the items loaded. */
  readonly paged: boolean;
  /**
   * Whether every item in `order` carries the `order` columns, so a new one
   * can be placed among them by its values: worked out once per batch, on
   * first use, and kept as items come and go.
   */
  placeable: boolean | undefined;
  changed: boolean;
}

type Values = Readonly<Record<string, unknown>>;

function workOn<Item extends CollectionItem>(
  base: CollectionState<Item>,
  shape: CollectionShape,
): Work<Item> {
  return {
    shape,
    byId: new Map(base.byId),
    order: [...base.order],
    revById: new Map(base.revById),
    removed: base.removed,
    removedCopied: false,
    index: base.index === null ? null : [...base.index],
    indexById: undefined,
    totalCount: base.totalCount,
    paged: base.nextCursor !== null,
    placeable: undefined,
    changed: false,
  };
}

/**
 * True when a change of member `id` may bring its item in: it is loaded, the
 * index places it, the whole scope is being loaded, or no page follows the
 * items loaded. Otherwise it is beyond the paged window shown.
 */
function mayBringIn(work: Work<CollectionItem>, id: string, loadAll: boolean): boolean {
  return work.byId.has(id) || work.index !== null || loadAll || !work.paged;
}

/** The state `work` made, over `base`; `base` itself when nothing changed and `extra` is empty. */
function finish<Item extends CollectionItem>(
  base: CollectionState<Item>,
  work: Work<Item>,
  extra: Partial<CollectionState<Item>> = {},
): CollectionState<Item> {
  if (!work.changed && Object.keys(extra).length === 0) {
    return base;
  }
  return Object.freeze({
    ...base,
    byId: work.byId,
    order: work.index === null ? work.order : [],
    revById: work.revById,
    removed: work.removed,
    index: work.index,
    totalCount: work.index === null ? work.totalCount : work.index.length,
    ...extra,
  });
}

/** The batch's tombstones, to change: copied from the base state on the first change. */
function tombstones(work: Work<CollectionItem>): Map<string, Revision> {
  if (!work.removedCopied) {
    work.removed = new Map(work.removed);
    work.removedCopied = true;
  }
  return work.removed as Map<string, Revision>;
}

/** True when the state holds something newer for `id` than `rev`: an item, a row or a tombstone. */
function isStale(work: Work<CollectionItem>, id: string, rev: Revision): boolean {
  const held = work.revById.get(id) ?? work.removed.get(id);
  return held !== undefined && rev < held;
}

function rowsById(work: Work<CollectionItem>): Map<string, IndexRow> {
  work.indexById ??= new Map((work.index ?? []).map((row) => [row.id, row]));
  return work.indexById;
}

/** Takes the row of `id` out of the index. */
function takeIndexRow(work: Work<CollectionItem>, id: string): void {
  const index = work.index;
  const held = rowsById(work).get(id);
  if (index === null || held === undefined) {
    return;
  }
  const position = positionOf(work.shape.order, index, held);
  if (position >= 0) {
    index.splice(position, 1);
  }
  rowsById(work).delete(id);
}

/** Puts `row` in the index at its place, replacing the row of its id. */
function placeIndexRow(work: Work<CollectionItem>, row: IndexRow): void {
  const index = work.index;
  if (index === null) {
    return;
  }
  takeIndexRow(work, row.id);
  const { order } = work.shape;
  index.splice(order === undefined ? index.length : insertionPoint(order, index, row), 0, row);
  rowsById(work).set(row.id, row);
}

/** True when every item in `work.order` carries the `order` columns; read once per batch. */
function canPlace(work: Work<CollectionItem>): boolean {
  const { order } = work.shape;
  if (order === undefined) {
    return false;
  }
  work.placeable ??= work.order.every((id) => hasOrderValues(order, work.byId.get(id) as Values));
  return work.placeable;
}

/**
 * Adds the id of a newly loaded item to the order: in its place when its
 * values and those of every item loaded allow, found by a binary search over
 * the order, else last. A page in the server's order lands at the end, so a
 * whole scope loads in time linear in its size.
 */
function placeLoaded(work: Work<CollectionItem>, item: CollectionItem): void {
  const { order } = work.shape;
  const values = item as Values;
  if (order === undefined || !canPlace(work) || !hasOrderValues(order, values)) {
    work.order.push(item.id);
    work.placeable = order === undefined ? undefined : false;
    return;
  }
  const valuesAt = (position: number): Values =>
    work.byId.get(work.order[position] as string) as Values;
  work.order.splice(insertionPointBy(order, work.order.length, valuesAt, values), 0, item.id);
}

/**
 * Upserts `item` at revision `rev`, unless something newer is held. `row` is
 * its index row when it came with one. `counts` says whether a new id is a
 * new member (a delta) rather than one the count already holds (a page).
 */
function upsert(
  work: Work<CollectionItem>,
  item: CollectionItem,
  rev: Revision,
  counts: boolean,
  row?: IndexRow,
): void {
  const { id } = item;
  if (isStale(work, id, rev)) {
    return;
  }
  const known = work.revById.has(id);
  if (work.removed.has(id)) {
    tombstones(work).delete(id);
  }
  work.byId.set(id, item);
  work.revById.set(id, rev);
  if (work.index !== null) {
    placeIndexRow(work, row ?? indexRowFromItem(work.shape, item));
  } else if (!known) {
    placeLoaded(work, item);
  } else if (work.placeable === true && !hasOrderValues(work.shape.order, item as Values)) {
    work.placeable = false;
  }
  if (!known && counts && work.totalCount !== null) {
    work.totalCount += 1;
  }
  work.changed = true;
}

/** Removes `id` at revision `rev`, leaving a tombstone, unless something newer is held. */
function remove(work: Work<CollectionItem>, id: string, rev: Revision): void {
  if (isStale(work, id, rev)) {
    return;
  }
  const known = work.revById.has(id);
  work.byId.delete(id);
  work.revById.delete(id);
  takeIndexRow(work, id);
  const position = work.order.indexOf(id);
  if (position >= 0) {
    work.order.splice(position, 1);
  }
  if (position >= 0 && work.placeable === false) {
    // The item without the order's columns may be the one that left: work it out again.
    work.placeable = undefined;
  }
  addTombstone(tombstones(work), id, rev);
  if (known && work.totalCount !== null) {
    work.totalCount = Math.max(0, work.totalCount - 1);
  }
  work.changed = true;
}

/** Merges a patch of `id` at revision `rev`; reports the id when its item must be loaded instead. */
function patch(
  work: Work<CollectionItem>,
  delta: { readonly id: string; readonly d: unknown },
  rev: Revision,
  loadAll: boolean,
  missing: string[],
): void {
  const { id, d } = delta;
  if (isStale(work, id, rev)) {
    return;
  }
  if (!work.revById.has(id)) {
    // A member this state does not know, or one it removed: never a partial item.
    if (mayBringIn(work, id, loadAll)) {
      missing.push(id);
    }
    return;
  }
  work.revById.set(id, rev);
  work.changed = true;
  const row = rowsById(work).get(id);
  if (work.index !== null && row !== undefined) {
    placeIndexRow(work, patchIndexRow(work.shape, row, d));
  }
  const item = work.byId.get(id);
  if (item !== undefined) {
    work.byId.set(id, isRecord(d) ? { ...item, ...d } : item);
  } else if (work.index === null || loadAll) {
    missing.push(id);
  }
}

/** Applies one delta; returns true for a `reset`. */
function applyOne(
  work: Work<CollectionItem>,
  delta: unknown,
  rev: Revision,
  loadAll: boolean,
  missing: string[],
): boolean {
  if (!isRecord(delta)) {
    return false;
  }
  if (delta.t === "reset") {
    return true;
  }
  if (delta.t === "added" && hasId(delta.item)) {
    upsert(work, delta.item, rev, true, indexRowOf(work.shape, delta.index));
  } else if (delta.t === "updated" && hasId(delta.item)) {
    if (mayBringIn(work, delta.item.id, loadAll)) {
      upsert(work, delta.item, rev, false);
    }
  } else if (delta.t === "patched" && typeof delta.id === "string") {
    patch(work, { id: delta.id, d: delta.d }, rev, loadAll, missing);
  } else if (delta.t === "removed" && typeof delta.id === "string") {
    remove(work, delta.id, rev);
  }
  return false;
}

/**
 * Applies the deltas of one `qd:c` frame (or of a resume reply), all at
 * revision `rev`, in the order sent. The scope's `rev` rises to `rev`
 * unless the frame holds a `reset`.
 */
export function applyDeltas<Item extends CollectionItem>(
  prev: CollectionState<Item> | null | undefined,
  deltas: readonly CollectionDelta<Item>[] | readonly unknown[],
  rev: Revision,
  shape: CollectionShape,
  options: DeltaOptions = {},
): DeltaResult<Item> {
  const base = prev ?? emptyCollection<Item>();
  const work = workOn(base, shape) as Work<CollectionItem>;
  const missing: string[] = [];
  let reset = false;
  for (const delta of deltas) {
    reset = applyOne(work, delta, rev, options.loadAll === true, missing) || reset;
  }
  const rises = !reset && rev > base.rev;
  const state = finish(base, work as Work<Item>, rises ? { rev } : {});
  return { state, reset, missing };
}

/** One frame's revision and deltas (`CollectionDelta`), not checked yet. */
export interface DeltaBatch {
  readonly rev: Revision;
  readonly deltas: readonly unknown[];
}

/** Applies frames in the order they arrived, each at its own revision. */
export function applyFrames<Item extends CollectionItem>(
  prev: CollectionState<Item> | null | undefined,
  frames: readonly DeltaBatch[],
  shape: CollectionShape,
  options: DeltaOptions = {},
): DeltaResult<Item> {
  let state = prev ?? emptyCollection<Item>();
  let reset = false;
  const missing: string[] = [];
  for (const frame of frames) {
    const result = applyDeltas(state, frame.deltas, frame.rev, shape, options);
    state = result.state;
    reset ||= result.reset;
    missing.push(...result.missing);
  }
  return { state, reset, missing };
}

/**
 * Applies a later page (the answer to `qd:col:sub` with a cursor): items are
 * upserted unless the state holds newer ones, nothing is pruned, and new ids
 * go last (or in their place by `order`, without an index).
 */
export function applyPage<Item extends CollectionItem>(
  prev: CollectionState<Item> | null | undefined,
  page: PageReply,
  shape: CollectionShape,
): CollectionState<Item> {
  const base = prev ?? emptyCollection<Item>();
  const work = workOn(base, shape) as Work<CollectionItem>;
  for (const item of page.items) {
    if (hasId(item)) {
      upsert(work, item, page.rev, false);
    }
  }
  return finish(base, work as Work<Item>, {
    nextCursor: page.cursor,
    clamped: page.clamped === true,
    ...(work.index === null ? { totalCount: page.total } : {}),
  });
}

/**
 * Applies the answer to `qd:col:items` for `requested` ids, read at `rev`:
 * items are upserted unless the state holds newer ones, and a requested id
 * the answer leaves out is not a member, so it is removed (unless the state
 * holds something newer for it).
 */
export function applyItems<Item extends CollectionItem>(
  prev: CollectionState<Item> | null | undefined,
  items: readonly unknown[],
  rev: Revision,
  shape: CollectionShape,
  requested: readonly string[],
): CollectionState<Item> {
  const base = prev ?? emptyCollection<Item>();
  const work = workOn(base, shape) as Work<CollectionItem>;
  const returned = new Set<string>();
  for (const item of items) {
    if (hasId(item)) {
      returned.add(item.id);
      upsert(work, item, rev, false);
    }
  }
  for (const id of requested) {
    if (!returned.has(id)) {
      remove(work, id, rev);
    }
  }
  return finish(base, work as Work<Item>);
}
