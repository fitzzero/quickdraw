import { describe, it, expect } from "vitest";
import type { CollectionSnapshotResponse } from "../shared/types";
import {
  applyDelta,
  applyDeltas,
  applyPage,
  applySnapshot,
  createEmptyEntry,
  type CollectionCacheEntry,
} from "./collectionCache";

interface Row {
  id: string;
  v: number;
}

const row = (id: string, v = 0): Row => ({ id, v });

function snap(
  items: Row[],
  opts: Partial<Omit<CollectionSnapshotResponse<Row>, "items">> & { rev: number },
): CollectionSnapshotResponse<Row> {
  return {
    items,
    nextCursor: opts.nextCursor ?? null,
    totalCount: opts.totalCount ?? items.length,
    ids: opts.ids,
    idsTruncated: opts.idsTruncated,
    rev: opts.rev,
  };
}

describe("applySnapshot", () => {
  it("populates an empty cache in server order", () => {
    const entry = applySnapshot(null, snap([row("a"), row("b")], { rev: 100, nextCursor: "2" }));

    expect(entry.order).toEqual(["a", "b"]);
    expect(entry.byId.a).toEqual(row("a"));
    expect(entry.revById).toEqual({ a: 100, b: 100 });
    expect(entry.nextCursor).toBe("2");
    expect(entry.totalCount).toBe(2);
    expect(entry.snapshotRev).toBe(100);
  });

  it("prunes cached ids absent from the membership ids list", () => {
    const first = applySnapshot(
      null,
      snap([row("a"), row("b"), row("c")], { rev: 100, ids: ["a", "b", "c"] }),
    );
    const second = applySnapshot(first, snap([row("a")], { rev: 200, ids: ["a"] }));

    expect(second.order).toEqual(["a"]);
    expect(second.byId.b).toBeUndefined();
    expect(second.revById.b).toBeUndefined();
  });

  it("spares live items newer than the snapshot from pruning", () => {
    const first = applySnapshot(null, snap([row("a")], { rev: 100, ids: ["a"] }));
    // A delta created "b" after the snapshot query ran
    const { entry: withLive } = applyDelta(first, { type: "added", item: row("b"), rev: 300 });
    // Re-snapshot whose query predates the delta: ids lack "b"
    const second = applySnapshot(withLive, snap([row("a")], { rev: 200, ids: ["a"] }));

    expect(second.byId.b).toEqual(row("b"));
    expect(second.order).toContain("b");
  });

  it("prunes live items older than the snapshot", () => {
    const first = applySnapshot(null, snap([row("a")], { rev: 100, ids: ["a"] }));
    const { entry: withLive } = applyDelta(first, { type: "added", item: row("b"), rev: 150 });
    const second = applySnapshot(withLive, snap([row("a")], { rev: 200, ids: ["a"] }));

    expect(second.byId.b).toBeUndefined();
  });

  it("keeps paged-in history when ids is omitted (unbounded scopes)", () => {
    const first = applySnapshot(null, snap([row("m3"), row("m2")], { rev: 100, nextCursor: "2" }));
    const paged = applyPage(first, snap([row("m1")], { rev: 100, nextCursor: null }));
    // Reconnect re-snapshot returns only the newest page, no ids
    const second = applySnapshot(paged, snap([row("m4"), row("m3")], { rev: 200 }));

    expect(second.order).toEqual(["m4", "m3", "m2", "m1"]);
    expect(second.byId.m1).toBeDefined();
  });

  it("does not overwrite cached items whose rev is newer than the snapshot", () => {
    const first = applySnapshot(null, snap([row("a", 1)], { rev: 100 }));
    const { entry: live } = applyDelta(first, { type: "updated", item: row("a", 9), rev: 300 });
    const second = applySnapshot(live, snap([row("a", 2)], { rev: 200 }));

    expect(second.byId.a).toEqual(row("a", 9));
    expect(second.revById.a).toBe(300);
  });

  it("overwrites cached items whose rev predates the snapshot", () => {
    const first = applySnapshot(null, snap([row("a", 1)], { rev: 100 }));
    const second = applySnapshot(first, snap([row("a", 2)], { rev: 200 }));

    expect(second.byId.a).toEqual(row("a", 2));
    expect(second.revById.a).toBe(200);
  });

  it("a removal newer than the snapshot suppresses resurrection by the snapshot page", () => {
    const first = applySnapshot(null, snap([row("a")], { rev: 100 }));
    const { entry: removed } = applyDelta(first, { type: "removed", id: "a", rev: 300 });
    // Snapshot whose query ran before the removal still contains "a"
    const second = applySnapshot(removed, snap([row("a")], { rev: 200 }));

    expect(second.byId.a).toBeUndefined();
    expect(second.order).not.toContain("a");
    // The tombstone survives to keep suppressing older data
    expect(second.revById.a).toBe(300);
  });

  it("garbage-collects tombstones older than the snapshot", () => {
    const first = applySnapshot(null, snap([row("a")], { rev: 100 }));
    const { entry: removed } = applyDelta(first, { type: "removed", id: "a", rev: 150 });
    // The snapshot ran after the removal and the server says "a" is a member
    const second = applySnapshot(removed, snap([row("a")], { rev: 200 }));

    expect(second.byId.a).toEqual(row("a"));
    expect(second.revById.a).toBe(200);
  });

  it("orders the fresh page first, then surviving prior ids in prior order", () => {
    const first = applySnapshot(
      null,
      snap([row("a"), row("b"), row("c")], { rev: 100, nextCursor: null }),
    );
    const second = applySnapshot(first, snap([row("c"), row("d")], { rev: 200 }));

    expect(second.order).toEqual(["c", "d", "a", "b"]);
  });
});

describe("applyPage", () => {
  it("appends unseen ids at the end in page order and never prunes", () => {
    const first = applySnapshot(null, snap([row("a"), row("b")], { rev: 100, nextCursor: "2" }));
    const paged = applyPage(
      first,
      snap([row("b"), row("c"), row("d")], { rev: 100, nextCursor: "5", totalCount: 9 }),
    );

    expect(paged.order).toEqual(["a", "b", "c", "d"]);
    expect(paged.nextCursor).toBe("5");
    expect(paged.totalCount).toBe(9);
    expect(paged.snapshotRev).toBe(100);
  });

  it("keeps cached items newer than the page (live delta raced the page)", () => {
    const first = applySnapshot(null, snap([row("a", 1)], { rev: 100 }));
    const { entry: live } = applyDelta(first, { type: "updated", item: row("a", 9), rev: 300 });
    const paged = applyPage(live, snap([row("a", 2), row("b")], { rev: 200 }));

    expect(paged.byId.a).toEqual(row("a", 9));
    expect(paged.byId.b).toEqual(row("b"));
  });

  it("does not resurrect ids removed after the page's rev", () => {
    const first = applySnapshot(null, snap([row("a")], { rev: 100 }));
    const { entry: removed } = applyDelta(first, { type: "removed", id: "a", rev: 300 });
    const paged = applyPage(removed, snap([row("a")], { rev: 200 }));

    expect(paged.byId.a).toBeUndefined();
    expect(paged.order).not.toContain("a");
  });

  it("resurrects ids whose removal predates the page", () => {
    const first = applySnapshot(null, snap([row("a")], { rev: 100 }));
    const { entry: removed } = applyDelta(first, { type: "removed", id: "a", rev: 150 });
    const paged = applyPage(removed, snap([row("a", 5)], { rev: 200 }));

    expect(paged.byId.a).toEqual(row("a", 5));
    expect(paged.order).toContain("a");
  });
});

describe("applyDelta", () => {
  const base = (): CollectionCacheEntry<Row> =>
    applySnapshot(null, snap([row("a"), row("b")], { rev: 100 }));

  it("added inserts at the end by default and bumps totalCount", () => {
    const { entry, resetRequested } = applyDelta(base(), {
      type: "added",
      item: row("c"),
      rev: 200,
    });

    expect(resetRequested).toBe(false);
    expect(entry.order).toEqual(["a", "b", "c"]);
    expect(entry.totalCount).toBe(3);
    expect(entry.revById.c).toBe(200);
  });

  it("added respects insertPosition start", () => {
    const { entry } = applyDelta(
      base(),
      { type: "added", item: row("c"), rev: 200 },
      { insertPosition: "start" },
    );
    expect(entry.order).toEqual(["c", "a", "b"]);
  });

  it("updated replaces the item in place without reordering or recounting", () => {
    const { entry } = applyDelta(base(), { type: "updated", item: row("a", 7), rev: 200 });

    expect(entry.byId.a).toEqual(row("a", 7));
    expect(entry.order).toEqual(["a", "b"]);
    expect(entry.totalCount).toBe(2);
  });

  it("updated on an unknown id upserts (added-vs-updated is cosmetic)", () => {
    const { entry } = applyDelta(base(), { type: "updated", item: row("z"), rev: 200 });

    expect(entry.byId.z).toEqual(row("z"));
    expect(entry.order).toEqual(["a", "b", "z"]);
    expect(entry.totalCount).toBe(3);
  });

  it("ignores added/updated older than the held rev (same entry reference)", () => {
    const prev = base();
    const { entry: live } = applyDelta(prev, { type: "updated", item: row("a", 9), rev: 300 });
    const { entry } = applyDelta(live, { type: "updated", item: row("a", 1), rev: 250 });

    expect(entry).toBe(live);
    expect(entry.byId.a).toEqual(row("a", 9));
  });

  it("applies rev ties (last write wins on equal rev)", () => {
    const prev = base();
    const { entry } = applyDelta(prev, { type: "updated", item: row("a", 5), rev: 100 });
    expect(entry.byId.a).toEqual(row("a", 5));
  });

  it("removed deletes the row, decrements totalCount, and leaves a tombstone", () => {
    const { entry } = applyDelta(base(), { type: "removed", id: "a", rev: 200 });

    expect(entry.byId.a).toBeUndefined();
    expect(entry.order).toEqual(["b"]);
    expect(entry.totalCount).toBe(1);
    expect(entry.revById.a).toBe(200);
  });

  it("removed for an unknown id records the tombstone without touching counts", () => {
    const { entry } = applyDelta(base(), { type: "removed", id: "zz", rev: 200 });

    expect(entry.order).toEqual(["a", "b"]);
    expect(entry.totalCount).toBe(2);
    expect(entry.revById.zz).toBe(200);
  });

  it("ignores a removal older than the held rev (same entry reference)", () => {
    const prev = base();
    const { entry: live } = applyDelta(prev, { type: "updated", item: row("a", 9), rev: 300 });
    const { entry } = applyDelta(live, { type: "removed", id: "a", rev: 250 });

    expect(entry).toBe(live);
    expect(entry.byId.a).toEqual(row("a", 9));
  });

  it("a stale added cannot resurrect a tombstoned id", () => {
    const { entry: removed } = applyDelta(base(), { type: "removed", id: "a", rev: 300 });
    const { entry } = applyDelta(removed, { type: "added", item: row("a"), rev: 250 });

    expect(entry).toBe(removed);
    expect(entry.byId.a).toBeUndefined();
  });

  it("re-adds after removal when the add is newer (scope move back)", () => {
    const { entry: removed } = applyDelta(base(), { type: "removed", id: "a", rev: 200 });
    const { entry } = applyDelta(removed, { type: "added", item: row("a", 2), rev: 300 });

    expect(entry.byId.a).toEqual(row("a", 2));
    expect(entry.order).toEqual(["b", "a"]);
    expect(entry.totalCount).toBe(2);
  });

  it("reset requests a re-snapshot and leaves the entry untouched", () => {
    const prev = base();
    const { entry, resetRequested } = applyDelta(prev, { type: "reset", rev: 999 });

    expect(resetRequested).toBe(true);
    expect(entry).toBe(prev);
  });

  it("handles a null previous entry", () => {
    const { entry } = applyDelta(null, { type: "added", item: row("a"), rev: 100 });
    expect(entry.order).toEqual(["a"]);
    // totalCount stays unknown until a snapshot provides it
    expect(entry.totalCount).toBeNull();
  });
});

describe("applyDeltas", () => {
  it("applies buffered deltas in arrival order and aggregates resetRequested", () => {
    const prev = createEmptyEntry<Row>();
    const { entry, resetRequested } = applyDeltas(prev, [
      { type: "added", item: row("a", 1), rev: 100 },
      { type: "updated", item: row("a", 2), rev: 200 },
      { type: "reset", rev: 300 },
      { type: "added", item: row("b"), rev: 400 },
    ]);

    expect(entry.byId.a).toEqual(row("a", 2));
    expect(entry.byId.b).toEqual(row("b"));
    expect(resetRequested).toBe(true);
  });

  it("buffered deltas older than the snapshot they raced are ignored", () => {
    const fresh = applySnapshot(null, snap([row("a", 5)], { rev: 200 }));
    const { entry } = applyDeltas(fresh, [
      { type: "updated", item: row("a", 1), rev: 150 },
      { type: "added", item: row("b"), rev: 250 },
    ]);

    expect(entry.byId.a).toEqual(row("a", 5));
    expect(entry.byId.b).toEqual(row("b"));
  });
});
