import type { CollectionDelta, CollectionSnapshotResponse } from "../shared/types";

/**
 * Pure merge logic for collection subscriptions — the correctness heart of
 * `useCollection`, kept free of React/socket dependencies so every rule is
 * unit-testable.
 *
 * Invariants:
 * - Everything is id-keyed; live deltas and paged history compose.
 * - Per-item last-writer-wins by `rev` (epoch ms). A delta older than what
 *   the cache holds for that id is ignored; snapshot/page items only
 *   overwrite cached items whose rev predates the response's rev.
 * - Removals leave a tombstone rev in `revById` so a stale `added` cannot
 *   resurrect a deleted row; snapshots garbage-collect stale tombstones.
 */
export interface CollectionCacheEntry<TItem extends { id: string }> {
  byId: Record<string, TItem>;
  /** Insertion/server order; render order applies `compare` on top. */
  order: string[];
  /** Last-known rev per id — includes tombstones for removed ids. */
  revById: Record<string, number>;
  nextCursor: string | null;
  totalCount: number | null;
  /** Rev of the last cursor-less snapshot applied. */
  snapshotRev: number;
}

export interface ApplyDeltaOptions {
  /** Where `added` lands when the id is new. Default "end". */
  insertPosition?: "start" | "end";
}

export interface ApplyDeltaResult<TItem extends { id: string }> {
  entry: CollectionCacheEntry<TItem>;
  /** True when the delta was a `reset` — caller schedules a re-snapshot. */
  resetRequested: boolean;
}

export function createEmptyEntry<TItem extends { id: string }>(): CollectionCacheEntry<TItem> {
  return {
    byId: {},
    order: [],
    revById: {},
    nextCursor: null,
    totalCount: null,
    snapshotRev: 0,
  };
}

/**
 * Apply a cursor-less snapshot (initial load or re-snapshot).
 *
 * - When `ids` is present it is the authoritative membership: cached items
 *   absent from it are pruned — unless a live delta newer than the snapshot
 *   put them there (`revById[id] > snapshot.rev`), in which case the live
 *   push wins.
 * - Page items upsert unless the cache holds a newer rev for that id.
 * - Order: page order first (fresh server order), then surviving previously
 *   known ids in their prior relative order (paged-in history stays).
 * - Tombstones older than the snapshot rev are garbage-collected; newer
 *   ones keep suppressing their id (the removal happened after the
 *   snapshot query ran).
 */
export function applySnapshot<TItem extends { id: string }>(
  prev: CollectionCacheEntry<TItem> | null | undefined,
  snapshot: CollectionSnapshotResponse<TItem>,
): CollectionCacheEntry<TItem> {
  const base = prev ?? createEmptyEntry<TItem>();
  const pageIds = new Set(snapshot.items.map((item) => item.id));
  const memberIds = snapshot.ids ? new Set(snapshot.ids) : null;

  const byId: Record<string, TItem> = {};
  const revById: Record<string, number> = {};

  // Carry over surviving cached items
  for (const id of base.order) {
    const item = base.byId[id];
    if (!item) continue;
    const rev = base.revById[id] ?? 0;
    const liveWins = rev > snapshot.rev;
    const pruned = memberIds !== null && !memberIds.has(id) && !pageIds.has(id) && !liveWins;
    if (pruned) continue;
    byId[id] = item;
    revById[id] = rev;
  }

  // Upsert page items (cached rev newer than the snapshot wins)
  for (const item of snapshot.items) {
    const cachedRev = revById[item.id];
    if (cachedRev !== undefined && cachedRev > snapshot.rev) continue;
    // A tombstone newer than the snapshot suppresses resurrection
    const tombstoneRev = base.revById[item.id];
    if (
      base.byId[item.id] === undefined &&
      tombstoneRev !== undefined &&
      tombstoneRev > snapshot.rev
    ) {
      continue;
    }
    byId[item.id] = item;
    revById[item.id] = snapshot.rev;
  }

  // Keep tombstones that still out-rev the snapshot
  for (const [id, rev] of Object.entries(base.revById)) {
    if (byId[id] === undefined && rev > snapshot.rev) {
      revById[id] = rev;
    }
  }

  // Page order first, then surviving prior order
  const order: string[] = [];
  const seen = new Set<string>();
  for (const item of snapshot.items) {
    if (byId[item.id] !== undefined && !seen.has(item.id)) {
      order.push(item.id);
      seen.add(item.id);
    }
  }
  for (const id of base.order) {
    if (byId[id] !== undefined && !seen.has(id)) {
      order.push(id);
      seen.add(id);
    }
  }

  return {
    byId,
    order,
    revById,
    nextCursor: snapshot.nextCursor,
    totalCount: snapshot.totalCount,
    snapshotRev: snapshot.rev,
  };
}

/**
 * Apply a cursored page (loadMore): upsert-only, never prune. Unseen ids
 * append at the end in page order; existing ids keep their position (and
 * their item, when the cache holds a newer rev).
 */
export function applyPage<TItem extends { id: string }>(
  prev: CollectionCacheEntry<TItem> | null | undefined,
  page: CollectionSnapshotResponse<TItem>,
): CollectionCacheEntry<TItem> {
  const base = prev ?? createEmptyEntry<TItem>();
  const byId = { ...base.byId };
  const revById = { ...base.revById };
  const order = [...base.order];
  const known = new Set(order);

  for (const item of page.items) {
    const cachedRev = revById[item.id];
    if (cachedRev !== undefined && cachedRev > page.rev) {
      // Cache holds a newer version (or a newer removal) — keep it
      continue;
    }
    byId[item.id] = item;
    revById[item.id] = page.rev;
    if (!known.has(item.id)) {
      order.push(item.id);
      known.add(item.id);
    }
  }

  return {
    byId,
    order,
    revById,
    nextCursor: page.nextCursor,
    totalCount: page.totalCount,
    snapshotRev: base.snapshotRev,
  };
}

/**
 * Apply a live delta. Returns the previous entry object unchanged when the
 * delta is stale (rev LWW) so referential equality can skip re-renders.
 */
export function applyDelta<TItem extends { id: string }>(
  prev: CollectionCacheEntry<TItem> | null | undefined,
  delta: CollectionDelta<TItem>,
  options?: ApplyDeltaOptions,
): ApplyDeltaResult<TItem> {
  const base = prev ?? createEmptyEntry<TItem>();

  if (delta.type === "reset") {
    return { entry: base, resetRequested: true };
  }

  if (delta.type === "removed") {
    const cachedRev = base.revById[delta.id];
    if (cachedRev !== undefined && delta.rev < cachedRev) {
      return { entry: base, resetRequested: false };
    }
    const existed = base.byId[delta.id] !== undefined;
    const byId = { ...base.byId };
    delete byId[delta.id];
    return {
      entry: {
        ...base,
        byId,
        order: existed ? base.order.filter((id) => id !== delta.id) : base.order,
        // Tombstone: keep the removal rev so a stale `added` can't resurrect
        revById: { ...base.revById, [delta.id]: delta.rev },
        totalCount:
          existed && base.totalCount !== null ? Math.max(0, base.totalCount - 1) : base.totalCount,
      },
      resetRequested: false,
    };
  }

  // added / updated — upsert semantics; the distinction is cosmetic
  const { item, rev } = delta;
  const cachedRev = base.revById[item.id];
  if (cachedRev !== undefined && rev < cachedRev) {
    return { entry: base, resetRequested: false };
  }

  const isNew = base.byId[item.id] === undefined;
  const insertPosition = options?.insertPosition ?? "end";

  return {
    entry: {
      ...base,
      byId: { ...base.byId, [item.id]: item },
      order: isNew
        ? insertPosition === "start"
          ? [item.id, ...base.order]
          : [...base.order, item.id]
        : base.order,
      revById: { ...base.revById, [item.id]: rev },
      totalCount: isNew && base.totalCount !== null ? base.totalCount + 1 : base.totalCount,
    },
    resetRequested: false,
  };
}

/**
 * Apply a batch of buffered deltas in arrival order (used when deltas
 * raced an in-flight snapshot). `resetRequested` is true if any was a reset.
 */
export function applyDeltas<TItem extends { id: string }>(
  prev: CollectionCacheEntry<TItem> | null | undefined,
  deltas: CollectionDelta<TItem>[],
  options?: ApplyDeltaOptions,
): ApplyDeltaResult<TItem> {
  let entry = prev ?? createEmptyEntry<TItem>();
  let resetRequested = false;
  for (const delta of deltas) {
    const result = applyDelta(entry, delta, options);
    entry = result.entry;
    resetRequested = resetRequested || result.resetRequested;
  }
  return { entry, resetRequested };
}
