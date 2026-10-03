// A collection scope's snapshot (RFC 0003 sections 7.3 and 7.4): the answer
// to `qd:col:sub` without a cursor, merged with the state held by revision.
// Split from `collectionStore.ts`, whose header states the rules.
//
// Pure functions, React-free.

import type { Revision } from "../../protocol/envelope";
import {
  hasId,
  indexRowFromItem,
  indexRowOf,
  insertionPoint,
  type CollectionShape,
  type IndexRow,
} from "./collectionIndex";
import {
  emptyCollection,
  loadedIds,
  type CollectionItem,
  type CollectionState,
  type PageReply,
} from "./collectionState";

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
