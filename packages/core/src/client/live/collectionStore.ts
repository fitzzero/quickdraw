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
//   drops it.
//
// and adds what 5.0's protocol carries:
//
// - one revision per frame (`qd:c { rev, deltas }`): the deltas of a frame,
//   and of a resume reply, share it and apply in the order sent, so with
//   equal revisions the later one wins;
// - `added` for an id already held is an upsert (a touch), and changes no
//   count;
// - `patched` merges the changed fields into the item. With no item held it
//   never makes a partial one: the id is reported `missing`, for the
//   controller to load with `qd:col:items`, unless only the index holds the
//   member and the whole scope is not being loaded;
// - the index (`collectionIndex.ts`): the snapshot's rows are the scope's
//   membership, so items of non-members are pruned as 4.1 pruned by `ids`;
//   `added` brings its row, and `patched` and `updated` change its fields
//   and its place; a row newer than the snapshot is kept over it;
// - `clamped` and `indexTruncated` from the snapshot.
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
  patchIndexRow,
  positionOf,
  type CollectionShape,
  type IndexRow,
} from "./collectionIndex";

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
  /** Tombstones: the revision each removed id was removed at. */
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

/** A copy of a state that one batch of changes is made on. */
interface Work<Item extends CollectionItem> {
  readonly shape: CollectionShape;
  readonly byId: Map<string, Item>;
  readonly order: string[];
  readonly revById: Map<string, Revision>;
  readonly removed: Map<string, Revision>;
  readonly index: IndexRow[] | null;
  /** The index's rows by id, made on first use. */
  indexById: Map<string, IndexRow> | undefined;
  totalCount: number | null;
  changed: boolean;
}

function workOn<Item extends CollectionItem>(
  base: CollectionState<Item>,
  shape: CollectionShape,
): Work<Item> {
  return {
    shape,
    byId: new Map(base.byId),
    order: [...base.order],
    revById: new Map(base.revById),
    removed: new Map(base.removed),
    index: base.index === null ? null : [...base.index],
    indexById: undefined,
    totalCount: base.totalCount,
    changed: false,
  };
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

/** Adds the id of a newly loaded item to the order: in its place when its values allow, else last. */
function placeLoaded(work: Work<CollectionItem>, item: CollectionItem): void {
  const { order } = work.shape;
  const values = item as Readonly<Record<string, unknown>>;
  const loaded = work.order.map((id) => work.byId.get(id) as Readonly<Record<string, unknown>>);
  const placeable = order !== undefined && loaded.every((row) => hasOrderValues(order, row));
  const at =
    placeable && hasOrderValues(order, values)
      ? insertionPoint(order, loaded, values)
      : work.order.length;
  work.order.splice(at, 0, item.id);
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
  work.removed.delete(id);
  work.byId.set(id, item);
  work.revById.set(id, rev);
  if (work.index !== null) {
    placeIndexRow(work, row ?? indexRowFromItem(work.shape, item));
  } else if (!known) {
    placeLoaded(work, item);
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
  work.removed.set(id, rev);
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
    missing.push(id);
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
  if ((delta.t === "added" || delta.t === "updated") && hasId(delta.item)) {
    const row = delta.t === "added" ? indexRowOf(work.shape, delta.index) : undefined;
    upsert(work, delta.item, rev, true, row);
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

/** The index row the state holds for `id`, or one made from its item. */
function heldRow(
  base: CollectionState<CollectionItem>,
  held: ReadonlyMap<string, IndexRow>,
  shape: CollectionShape,
  id: string,
): IndexRow | undefined {
  const item = base.byId.get(id);
  return held.get(id) ?? (item === undefined ? undefined : indexRowFromItem(shape, item));
}

/** The index after a snapshot, and the revision of each member in it. */
interface SnapshotIndex {
  readonly rows: IndexRow[];
  readonly revs: Map<string, Revision>;
}

/**
 * The snapshot's index merged with what the state holds: a member removed
 * after the snapshot was read stays out, and a member changed or added after
 * it keeps the row the state holds, in its place. `null` without an index.
 */
function snapshotIndex(
  base: CollectionState<CollectionItem>,
  snapshot: PageReply,
  shape: CollectionShape,
): SnapshotIndex | null {
  const wires: readonly unknown[] | undefined = Array.isArray(snapshot.index)
    ? (snapshot.index as readonly unknown[])
    : undefined;
  if (wires === undefined) {
    return null;
  }
  const held = new Map((base.index ?? []).map((row) => [row.id, row]));
  const newer = (id: string): boolean =>
    (base.revById.get(id) ?? Number.NEGATIVE_INFINITY) > snapshot.rev;
  const rows: IndexRow[] = [];
  const late: IndexRow[] = [];
  const revs = new Map<string, Revision>();
  // A member newer than the snapshot keeps the row the state holds; with
  // none held, the snapshot's row (`fallback`) is the best known.
  const keep = (id: string, fallback?: IndexRow): void => {
    const row = heldRow(base, held, shape, id) ?? fallback;
    if (row !== undefined) {
      late.push(row);
      revs.set(id, base.revById.get(id) ?? snapshot.rev);
    }
  };
  for (const wire of wires) {
    const row = indexRowOf(shape, wire);
    const removedAfter =
      (base.removed.get(row?.id ?? "") ?? Number.NEGATIVE_INFINITY) > snapshot.rev;
    if (row === undefined || revs.has(row.id) || removedAfter) {
      continue;
    }
    if (newer(row.id)) {
      keep(row.id, row);
    } else {
      rows.push(row);
      revs.set(row.id, snapshot.rev);
    }
  }
  for (const id of base.revById.keys()) {
    if (!revs.has(id) && newer(id)) {
      keep(id);
    }
  }
  const { order } = shape;
  for (const row of late) {
    rows.splice(order === undefined ? rows.length : insertionPoint(order, rows, row), 0, row);
  }
  return { rows, revs };
}

/** The items a snapshot keeps: those held that are members (or newer than it), then its page's. */
function snapshotItems<Item extends CollectionItem>(
  base: CollectionState<Item>,
  snapshot: PageReply,
  members: ReadonlySet<string> | null,
): { readonly byId: Map<string, Item>; readonly revById: Map<string, Revision> } {
  const byId = new Map<string, Item>();
  const revById = new Map<string, Revision>();
  for (const id of loadedIds(base)) {
    const rev = base.revById.get(id) ?? 0;
    const pruned = members !== null && !members.has(id) && rev <= snapshot.rev;
    if (!pruned) {
      byId.set(id, base.byId.get(id) as Item);
      revById.set(id, rev);
    }
  }
  for (const item of snapshot.items) {
    const tombstone = hasId(item) ? base.removed.get(item.id) : undefined;
    const cached = hasId(item) ? revById.get(item.id) : undefined;
    const older = (cached ?? tombstone ?? Number.NEGATIVE_INFINITY) > snapshot.rev;
    if (hasId(item) && !older && (members === null || members.has(item.id))) {
      byId.set(item.id, item as Item);
      revById.set(item.id, snapshot.rev);
    }
  }
  return { byId, revById };
}

/** The order of loaded items after a snapshot without an index: its page first, then the others as before. */
function snapshotOrder(
  base: CollectionState<CollectionItem>,
  snapshot: PageReply,
  byId: ReadonlyMap<string, unknown>,
): string[] {
  const order = new Set<string>();
  for (const item of snapshot.items) {
    if (hasId(item) && byId.has(item.id)) {
      order.add(item.id);
    }
  }
  for (const id of loadedIds(base)) {
    if (byId.has(id)) {
      order.add(id);
    }
  }
  return [...order];
}

/**
 * Applies a snapshot: the answer to `qd:col:sub` without a cursor (a first
 * load, a reload after `reset`, or a resume the server could not serve).
 *
 * - With an index, the index is the scope's membership: held items of
 *   members stay, others are pruned unless a delta newer than the snapshot
 *   put them there. Without one, every held item stays (pages loaded before
 *   are kept), as 4.1 did when the server sent no `ids`.
 * - Page items replace held ones unless the state holds a newer item or a
 *   newer tombstone for them.
 * - Tombstones older than the snapshot are dropped; newer ones stay.
 */
export function applySnapshot<Item extends CollectionItem>(
  prev: CollectionState<Item> | null | undefined,
  snapshot: PageReply,
  shape: CollectionShape,
): CollectionState<Item> {
  const base = prev ?? emptyCollection<Item>();
  const index = snapshotIndex(base, snapshot, shape);
  const members = index === null ? null : new Set(index.revs.keys());
  const { byId, revById } = snapshotItems(base, snapshot, members);
  for (const [id, rev] of index?.revs ?? []) {
    if (!revById.has(id)) {
      revById.set(id, rev);
    }
  }
  return Object.freeze({
    byId,
    order: index === null ? snapshotOrder(base, snapshot, byId) : [],
    revById,
    removed: new Map([...base.removed].filter(([, rev]) => rev > snapshot.rev)),
    index: index?.rows ?? null,
    indexTruncated: snapshot.indexTruncated === true,
    clamped: snapshot.clamped === true,
    nextCursor: snapshot.cursor,
    totalCount: index === null ? snapshot.total : index.rows.length,
    snapshotRev: snapshot.rev,
    rev: Math.max(base.rev, snapshot.rev),
  });
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

/** Loaded items older than the last snapshot and not refreshed by it: their data may be out of date. */
export function staleIds(state: CollectionState<CollectionItem>): string[] {
  return loadedIds(state).filter((id) => (state.revById.get(id) ?? 0) < state.snapshotRev);
}
