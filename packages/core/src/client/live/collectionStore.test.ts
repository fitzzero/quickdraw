// The collection store's merge rules (RFC 0003 sections 7.2 to 7.5). The
// first four blocks are 4.1's collection cache tests
// (4.1 `src/client/collectionCache.test.ts`), case for case, on the 5.0
// store: one revision per frame rather than per delta, membership from the
// index rather than `ids`, tombstones in `removed`, and `added` placed by the
// collection's order rather than an `insertPosition`. The blocks after them
// are 5.0's own rules.

import { describe, expect, it } from "vitest";
import type { CollectionShape } from "./collectionIndex";
import {
  applyDeltas,
  applyFrames,
  applyItems,
  applyKept,
  applyPage,
  applySnapshot,
  emptyCollection,
  loadedIds,
  MAX_TOMBSTONES,
  staleIds,
  type CollectionState,
  type PageReply,
} from "./collectionStore";
import { showCollection, viewPredicate } from "./views";

interface Row {
  readonly id: string;
  readonly v: number;
}

const row = (id: string, v = 0): Row => ({ id, v });

/** A collection without an index whose items carry no order columns: new ids go last. */
const plain: CollectionShape = {};

/** A collection indexed by `v`, ordered by `v` then `id`. */
const indexed: CollectionShape = {
  index: ["v"],
  order: [
    ["v", "asc"],
    ["id", "asc"],
  ],
};

interface SnapOptions {
  readonly rev: number;
  readonly cursor?: string | null;
  readonly total?: number;
  /** The membership: index rows `[id, rev, v]` of these items. */
  readonly members?: readonly Row[];
  readonly clamped?: true;
  readonly indexTruncated?: true;
}

function snap(items: readonly Row[], options: SnapOptions): PageReply {
  return {
    rev: options.rev,
    items,
    total: options.total ?? options.members?.length ?? items.length,
    cursor: options.cursor ?? null,
    ...(options.members === undefined
      ? {}
      : { index: options.members.map((member) => [member.id, options.rev, member.v]) }),
    ...(options.clamped === undefined ? {} : { clamped: true }),
    ...(options.indexTruncated === undefined ? {} : { indexTruncated: true }),
  };
}

function added(item: Row, index?: readonly unknown[]) {
  return index === undefined ? { t: "added", item } : { t: "added", item, index };
}

/** Applies one delta at `rev`, as a frame of one delta. */
function apply(state: CollectionState<Row>, delta: unknown, rev: number, shape = plain) {
  return applyDeltas<Row>(state, [delta], rev, shape);
}

const ids = (state: CollectionState<Row>): string[] => loadedIds(state);

describe("applySnapshot (4.1 cases)", () => {
  it("populates an empty cache in server order", () => {
    const entry = applySnapshot<Row>(
      null,
      snap([row("a"), row("b")], { rev: 100, cursor: "2" }),
      plain,
    );

    expect(ids(entry)).toEqual(["a", "b"]);
    expect(entry.byId.get("a")).toEqual(row("a"));
    expect(Object.fromEntries(entry.revById)).toEqual({ a: 100, b: 100 });
    expect(entry.nextCursor).toBe("2");
    expect(entry.totalCount).toBe(2);
    expect(entry.snapshotRev).toBe(100);
    expect(entry.rev).toBe(100);
  });

  it("prunes cached items absent from the membership (the index)", () => {
    const all = [row("a"), row("b"), row("c")];
    const first = applySnapshot<Row>(null, snap(all, { rev: 100, members: all }), indexed);
    const second = applySnapshot<Row>(
      first,
      snap([row("a")], { rev: 200, members: [row("a")] }),
      indexed,
    );

    expect(ids(second)).toEqual(["a"]);
    expect(second.byId.has("b")).toBe(false);
    expect(second.revById.has("b")).toBe(false);
    expect(second.index?.map((member) => member.id)).toEqual(["a"]);
  });

  it("spares live items newer than the snapshot from pruning", () => {
    const first = applySnapshot<Row>(
      null,
      snap([row("a")], { rev: 100, members: [row("a")] }),
      indexed,
    );
    // A delta made "b" after the snapshot read ran.
    const { state: withLive } = apply(first, added(row("b", 1), ["b", 300, 1]), 300, indexed);
    // A reload whose read predates the delta: its index lacks "b".
    const second = applySnapshot<Row>(
      withLive,
      snap([row("a")], { rev: 200, members: [row("a")] }),
      indexed,
    );

    expect(second.byId.get("b")).toEqual(row("b", 1));
    expect(ids(second)).toContain("b");
    expect(second.index?.map((member) => member.id)).toEqual(["a", "b"]);
  });

  it("prunes live items older than the snapshot", () => {
    const first = applySnapshot<Row>(
      null,
      snap([row("a")], { rev: 100, members: [row("a")] }),
      indexed,
    );
    const { state: withLive } = apply(first, added(row("b"), ["b", 150, 0]), 150, indexed);
    const second = applySnapshot<Row>(
      withLive,
      snap([row("a")], { rev: 200, members: [row("a")] }),
      indexed,
    );

    expect(second.byId.has("b")).toBe(false);
    expect(second.index?.map((member) => member.id)).toEqual(["a"]);
  });

  it("keeps paged-in history when there is no index (unbounded scopes)", () => {
    const first = applySnapshot<Row>(
      null,
      snap([row("m3"), row("m2")], { rev: 100, cursor: "2" }),
      plain,
    );
    const paged = applyPage(first, snap([row("m1")], { rev: 100 }), plain);
    // A reload answers only the newest page, and no index.
    const second = applySnapshot(paged, snap([row("m4"), row("m3")], { rev: 200 }), plain);

    expect(ids(second)).toEqual(["m4", "m3", "m2", "m1"]);
    expect(second.byId.has("m1")).toBe(true);
  });

  it("does not overwrite cached items whose revision is newer than the snapshot", () => {
    const first = applySnapshot<Row>(null, snap([row("a", 1)], { rev: 100 }), plain);
    const { state: live } = apply(first, { t: "updated", item: row("a", 9) }, 300);
    const second = applySnapshot(live, snap([row("a", 2)], { rev: 200 }), plain);

    expect(second.byId.get("a")).toEqual(row("a", 9));
    expect(second.revById.get("a")).toBe(300);
  });

  it("overwrites cached items whose revision predates the snapshot", () => {
    const first = applySnapshot<Row>(null, snap([row("a", 1)], { rev: 100 }), plain);
    const second = applySnapshot(first, snap([row("a", 2)], { rev: 200 }), plain);

    expect(second.byId.get("a")).toEqual(row("a", 2));
    expect(second.revById.get("a")).toBe(200);
  });

  it("a removal newer than the snapshot keeps the snapshot's page from bringing the item back", () => {
    const first = applySnapshot<Row>(null, snap([row("a")], { rev: 100 }), plain);
    const { state: removed } = apply(first, { t: "removed", id: "a" }, 300);
    // A reload whose read ran before the removal still holds "a".
    const second = applySnapshot(removed, snap([row("a")], { rev: 200 }), plain);

    expect(second.byId.has("a")).toBe(false);
    expect(ids(second)).not.toContain("a");
    // The tombstone stays, to keep older data out.
    expect(second.removed.get("a")).toBe(300);
  });

  it("drops tombstones older than the snapshot", () => {
    const first = applySnapshot<Row>(null, snap([row("a")], { rev: 100 }), plain);
    const { state: removed } = apply(first, { t: "removed", id: "a" }, 150);
    // The reload ran after the removal, and the server says "a" is a member.
    const second = applySnapshot(removed, snap([row("a")], { rev: 200 }), plain);

    expect(second.byId.get("a")).toEqual(row("a"));
    expect(second.revById.get("a")).toBe(200);
    expect(second.removed.has("a")).toBe(false);
  });

  it("orders the fresh page first, then the other items held, in their order", () => {
    const first = applySnapshot<Row>(
      null,
      snap([row("a"), row("b"), row("c")], { rev: 100 }),
      plain,
    );
    const second = applySnapshot(first, snap([row("c"), row("d")], { rev: 200 }), plain);

    expect(ids(second)).toEqual(["c", "d", "a", "b"]);
  });
});

describe("applyPage (4.1 cases)", () => {
  it("adds unseen ids last, in page order, and never prunes", () => {
    const first = applySnapshot<Row>(
      null,
      snap([row("a"), row("b")], { rev: 100, cursor: "2" }),
      plain,
    );
    const paged = applyPage(
      first,
      snap([row("b"), row("c"), row("d")], { rev: 100, cursor: "5", total: 9 }),
      plain,
    );

    expect(ids(paged)).toEqual(["a", "b", "c", "d"]);
    expect(paged.nextCursor).toBe("5");
    expect(paged.totalCount).toBe(9);
    expect(paged.snapshotRev).toBe(100);
  });

  it("keeps cached items newer than the page (a delta raced the page)", () => {
    const first = applySnapshot<Row>(null, snap([row("a", 1)], { rev: 100 }), plain);
    const { state: live } = apply(first, { t: "updated", item: row("a", 9) }, 300);
    const paged = applyPage(live, snap([row("a", 2), row("b")], { rev: 200 }), plain);

    expect(paged.byId.get("a")).toEqual(row("a", 9));
    expect(paged.byId.get("b")).toEqual(row("b"));
  });

  it("does not bring back ids removed after the page's revision", () => {
    const first = applySnapshot<Row>(null, snap([row("a")], { rev: 100 }), plain);
    const { state: removed } = apply(first, { t: "removed", id: "a" }, 300);
    const paged = applyPage(removed, snap([row("a")], { rev: 200 }), plain);

    expect(paged.byId.has("a")).toBe(false);
    expect(ids(paged)).not.toContain("a");
  });

  it("brings back ids whose removal predates the page", () => {
    const first = applySnapshot<Row>(null, snap([row("a")], { rev: 100 }), plain);
    const { state: removed } = apply(first, { t: "removed", id: "a" }, 150);
    const paged = applyPage(removed, snap([row("a", 5)], { rev: 200 }), plain);

    expect(paged.byId.get("a")).toEqual(row("a", 5));
    expect(ids(paged)).toContain("a");
  });
});

describe("applyDeltas, one delta (4.1 cases)", () => {
  const base = (): CollectionState<Row> =>
    applySnapshot<Row>(null, snap([row("a"), row("b")], { rev: 100 }), plain);

  it("added goes last when the item carries no order columns, and adds to the count", () => {
    const { state, reset } = apply(base(), added(row("c")), 200);

    expect(reset).toBe(false);
    expect(ids(state)).toEqual(["a", "b", "c"]);
    expect(state.totalCount).toBe(3);
    expect(state.revById.get("c")).toBe(200);
  });

  it("added takes its place by the collection's order when items carry its columns (was insertPosition)", () => {
    const newestFirst: CollectionShape = {
      order: [
        ["v", "desc"],
        ["id", "asc"],
      ],
    };
    const first = applySnapshot<Row>(
      null,
      snap([row("b", 2), row("a", 1)], { rev: 100 }),
      newestFirst,
    );
    const { state } = apply(first, added(row("c", 3)), 200, newestFirst);
    const { state: between } = apply(state, added(row("d", 1)), 300, newestFirst);

    expect(ids(state)).toEqual(["c", "b", "a"]);
    expect(ids(between)).toEqual(["c", "b", "a", "d"]);
  });

  it("updated replaces the item in place without moving it or counting it", () => {
    const { state } = apply(base(), { t: "updated", item: row("a", 7) }, 200);

    expect(state.byId.get("a")).toEqual(row("a", 7));
    expect(ids(state)).toEqual(["a", "b"]);
    expect(state.totalCount).toBe(2);
  });

  it("updated on an unknown id of a scope loaded whole upserts it, and only added counts", () => {
    const { state } = apply(base(), { t: "updated", item: row("z") }, 200);

    expect(state.byId.get("z")).toEqual(row("z"));
    expect(ids(state)).toEqual(["a", "b", "z"]);
    // The count is the server's total: an updated member is one it already holds.
    expect(state.totalCount).toBe(2);
  });

  it("updated for a member beyond a paged window changes neither the count nor the items", () => {
    const first = applySnapshot<Row>(
      null,
      snap([row("a")], { rev: 10, total: 3, cursor: "p2" }),
      plain,
    );
    const after = apply(first, { t: "updated", item: row("c", 5) }, 11);

    expect(after.state.totalCount).toBe(3);
    expect(ids(after.state)).toEqual(["a"]);
    expect(after.state.rev).toBe(11);
    // While the whole scope is loaded, it is a member to show.
    const whole = applyDeltas<Row>(first, [{ t: "updated", item: row("c", 5) }], 11, plain, {
      loadAll: true,
    });
    expect(ids(whole.state)).toEqual(["a", "c"]);
    expect(whole.state.totalCount).toBe(3);
  });

  it("ignores added and updated older than the revision held (the same state object)", () => {
    const { state: live } = apply(base(), { t: "updated", item: row("a", 9) }, 300);
    const { state } = apply(live, { t: "updated", item: row("a", 1) }, 250);

    expect(state).toBe(live);
    expect(state.byId.get("a")).toEqual(row("a", 9));
  });

  it("applies revision ties: the later one wins", () => {
    const { state } = apply(base(), { t: "updated", item: row("a", 5) }, 100);
    expect(state.byId.get("a")).toEqual(row("a", 5));
  });

  it("removed deletes the item, lowers the count, and leaves a tombstone", () => {
    const { state } = apply(base(), { t: "removed", id: "a" }, 200);

    expect(state.byId.has("a")).toBe(false);
    expect(ids(state)).toEqual(["b"]);
    expect(state.totalCount).toBe(1);
    expect(state.removed.get("a")).toBe(200);
  });

  it("removed for an unknown id records the tombstone without touching the count", () => {
    const { state } = apply(base(), { t: "removed", id: "zz" }, 200);

    expect(ids(state)).toEqual(["a", "b"]);
    expect(state.totalCount).toBe(2);
    expect(state.removed.get("zz")).toBe(200);
  });

  it("ignores a removal older than the revision held (the same state object)", () => {
    const { state: live } = apply(base(), { t: "updated", item: row("a", 9) }, 300);
    const { state } = apply(live, { t: "removed", id: "a" }, 250);

    expect(state).toBe(live);
    expect(state.byId.get("a")).toEqual(row("a", 9));
  });

  it("an older added cannot bring back a removed id", () => {
    const { state: removed } = apply(base(), { t: "removed", id: "a" }, 300);
    const { state } = apply(removed, added(row("a")), 250);

    expect(state).toBe(removed);
    expect(state.byId.has("a")).toBe(false);
  });

  it("adds an item again after its removal when the add is newer (a move back)", () => {
    const { state: removed } = apply(base(), { t: "removed", id: "a" }, 200);
    const { state } = apply(removed, added(row("a", 2)), 300);

    expect(state.byId.get("a")).toEqual(row("a", 2));
    expect(ids(state)).toEqual(["b", "a"]);
    expect(state.totalCount).toBe(2);
    expect(state.removed.has("a")).toBe(false);
  });

  it("reset asks for a reload and leaves the state alone", () => {
    const prev = base();
    const { state, reset } = apply(prev, { t: "reset" }, 999);

    expect(reset).toBe(true);
    expect(state).toBe(prev);
  });

  it("starts from nothing when there is no state", () => {
    const { state } = applyDeltas<Row>(null, [added(row("a"))], 100, plain);
    expect(ids(state)).toEqual(["a"]);
    // The count stays unknown until a snapshot gives it.
    expect(state.totalCount).toBeNull();
  });
});

describe("applyFrames (4.1 applyDeltas cases)", () => {
  it("applies kept frames in the order they arrived, and reports a reset among them", () => {
    const { state, reset } = applyFrames<Row>(
      emptyCollection(),
      [
        { rev: 100, deltas: [added(row("a", 1))] },
        { rev: 200, deltas: [{ t: "updated", item: row("a", 2) }] },
        { rev: 300, deltas: [{ t: "reset" }] },
        { rev: 400, deltas: [added(row("b"))] },
      ],
      plain,
    );

    expect(state.byId.get("a")).toEqual(row("a", 2));
    expect(state.byId.get("b")).toEqual(row("b"));
    expect(reset).toBe(true);
  });

  it("ignores kept frames older than the snapshot they raced", () => {
    const fresh = applySnapshot<Row>(null, snap([row("a", 5)], { rev: 200 }), plain);
    const { state } = applyFrames(
      fresh,
      [
        { rev: 150, deltas: [{ t: "updated", item: row("a", 1) }] },
        { rev: 250, deltas: [added(row("b"))] },
      ],
      plain,
    );

    expect(state.byId.get("a")).toEqual(row("a", 5));
    expect(state.byId.get("b")).toEqual(row("b"));
  });
});

describe("revision order", () => {
  const base = (): CollectionState<Row> =>
    applySnapshot<Row>(null, snap([row("a", 1), row("b", 1)], { rev: 100 }), plain);

  it("ignores the older of two frames that arrive out of order, whatever their kinds", () => {
    const { state: newer } = apply(base(), { t: "patched", id: "a", d: { v: 3 } }, 300);
    const { state } = apply(newer, { t: "patched", id: "a", d: { v: 2 } }, 200);
    const { state: whole } = apply(state, { t: "updated", item: row("a", 8) }, 250);

    expect(state).toBe(newer);
    expect(whole).toBe(newer);
    expect(newer.byId.get("a")).toEqual(row("a", 3));
  });

  it("keeps a removed item out when an upsert arrives late with an older revision", () => {
    const { state: removed } = apply(base(), { t: "removed", id: "a" }, 300);
    const late = [
      apply(removed, added(row("a", 4)), 290).state,
      apply(removed, { t: "updated", item: row("a", 4) }, 290).state,
      applyPage(removed, snap([row("a", 4)], { rev: 290, cursor: "x" }), plain),
      applyItems(removed, [row("a", 4)], 290, plain, ["a"]),
    ];

    for (const state of late) {
      expect(state.byId.has("a")).toBe(false);
      expect(state.removed.get("a")).toBe(300);
    }
  });

  it("treats added for an id already held as an upsert: no second copy, no count change", () => {
    const { state } = apply(base(), added(row("a", 6)), 200);

    expect(ids(state)).toEqual(["a", "b"]);
    expect(state.byId.get("a")).toEqual(row("a", 6));
    expect(state.totalCount).toBe(2);
  });

  it("applies the deltas of one frame in the order sent: a removal then an add of one id keeps it", () => {
    // A resume answers every missed delta at one revision.
    const { state } = applyDeltas<Row>(
      base(),
      [{ t: "removed", id: "a" }, added(row("a", 4)), { t: "patched", id: "a", d: { v: 5 } }],
      400,
      plain,
    );

    expect(state.byId.get("a")).toEqual(row("a", 5));
    expect(state.removed.has("a")).toBe(false);
    expect(state.rev).toBe(400);
  });

  it("raises the scope's revision with every frame but a reset", () => {
    const { state } = apply(base(), { t: "patched", id: "b", d: { v: 2 } }, 150);
    const { state: reset } = apply(state, { t: "reset" }, 160);

    expect(state.rev).toBe(150);
    expect(reset.rev).toBe(150);
  });
});

describe("patches", () => {
  it("merges the changed fields into the item held", () => {
    const first = applySnapshot<Row & { readonly title: string }>(
      null,
      snap([{ id: "a", v: 1, title: "A" } as Row], { rev: 100 }),
      plain,
    );
    const { state, missing } = applyDeltas(
      first,
      [{ t: "patched", id: "a", d: { title: "B" } }],
      200,
      plain,
    );

    expect(state.byId.get("a")).toEqual({ id: "a", v: 1, title: "B" });
    expect(missing).toEqual([]);
  });

  it("reports an item it does not hold as missing instead of making a partial item", () => {
    const first = applySnapshot<Row>(null, snap([row("a")], { rev: 100 }), plain);
    const { state, missing } = apply(first, { t: "patched", id: "far", d: { v: 9 } }, 200);

    expect(missing).toEqual(["far"]);
    expect(state.byId.has("far")).toBe(false);
    expect(ids(state)).toEqual(["a"]);
    // The frame arrived, so a resume starts after it; the item comes with its own load.
    expect(state.rev).toBe(200);
  });

  it("ignores a patch of a member beyond a paged window, unless the whole scope is being loaded", () => {
    const first = applySnapshot<Row>(
      null,
      snap([row("a")], { rev: 100, cursor: "1", total: 9 }),
      plain,
    );
    const patched = { t: "patched", id: "far", d: { v: 9 } };
    const paged = apply(first, patched, 200);

    expect(paged.missing).toEqual([]);
    expect(ids(paged.state)).toEqual(["a"]);
    expect(paged.state.totalCount).toBe(9);
    expect(applyDeltas<Row>(first, [patched], 200, plain, { loadAll: true }).missing).toEqual([
      "far",
    ]);
  });

  it("reports a removed id as missing when a newer patch says it is back", () => {
    const first = applySnapshot<Row>(null, snap([row("a")], { rev: 100 }), plain);
    const { state: removed } = apply(first, { t: "removed", id: "a" }, 200);

    expect(apply(removed, { t: "patched", id: "a", d: { v: 1 } }, 300).missing).toEqual(["a"]);
    expect(apply(removed, { t: "patched", id: "a", d: { v: 1 } }, 150).missing).toEqual([]);
  });
});

describe("the index", () => {
  const members = [row("a", 1), row("b", 2), row("c", 3), row("d", 4)];
  /** Every member in the index, the first two loaded. */
  const base = (): CollectionState<Row> =>
    applySnapshot<Row>(
      null,
      snap(members.slice(0, 2), { rev: 100, cursor: "2", members }),
      indexed,
    );
  const order = (state: CollectionState<Row>): string[] =>
    (state.index ?? []).map((member) => member.id);

  it("holds every member in order, and shows the items loaded in that order", () => {
    const state = base();

    expect(state.index).toEqual(members.map((member) => ({ id: member.id, v: member.v })));
    expect(ids(state)).toEqual(["a", "b"]);
    expect(state.totalCount).toBe(4);
    expect(state.revById.get("d")).toBe(100);
  });

  it("puts an added member's row in its place", () => {
    const { state } = apply(base(), added(row("e", 2), ["e", 200, 2]), 200, indexed);

    expect(order(state)).toEqual(["a", "b", "e", "c", "d"]);
    expect(ids(state)).toEqual(["a", "b", "e"]);
    expect(state.totalCount).toBe(5);
  });

  it("moves a member whose order field a patch changes, and takes a removed one out", () => {
    const { state } = applyDeltas<Row>(
      base(),
      [
        { t: "patched", id: "a", d: { v: 5 } },
        { t: "removed", id: "c" },
      ],
      200,
      indexed,
    );

    expect(order(state)).toEqual(["b", "d", "a"]);
    expect(state.byId.get("a")).toEqual(row("a", 5));
    expect(state.totalCount).toBe(3);
  });

  it("changes the row of a member whose item is not loaded, without loading it", () => {
    const { state, missing } = apply(base(), { t: "patched", id: "d", d: { v: 0 } }, 200, indexed);

    expect(missing).toEqual([]);
    expect(order(state)).toEqual(["d", "a", "b", "c"]);
    expect(state.byId.has("d")).toBe(false);
    expect(state.revById.get("d")).toBe(200);
  });

  it("loads the item of such a member while the whole scope is being loaded", () => {
    const result = applyDeltas<Row>(
      base(),
      [{ t: "patched", id: "d", d: { v: 0 } }],
      200,
      indexed,
      {
        loadAll: true,
      },
    );
    expect(result.missing).toEqual(["d"]);
  });

  it("keeps a member's row changed after the snapshot read over the snapshot's", () => {
    const { state: live } = apply(base(), { t: "patched", id: "c", d: { v: 9 } }, 300, indexed);
    const reloaded = applySnapshot(live, snap(members.slice(0, 2), { rev: 200, members }), indexed);

    expect(reloaded.index?.find((member) => member.id === "c")).toEqual({ id: "c", v: 9 });
    expect(order(reloaded)).toEqual(["a", "b", "d", "c"]);
  });

  it("keeps a member removed after the snapshot read out of the snapshot's index", () => {
    const { state: removed } = apply(base(), { t: "removed", id: "b" }, 300, indexed);
    const reloaded = applySnapshot(removed, snap([row("a", 1)], { rev: 200, members }), indexed);

    expect(order(reloaded)).toEqual(["a", "c", "d"]);
    expect(reloaded.removed.get("b")).toBe(300);
  });

  it("takes clamped and indexTruncated from the snapshot, and holds no index above the cap", () => {
    const clamped = applySnapshot<Row>(
      null,
      snap([row("a")], { rev: 100, members, clamped: true }),
      indexed,
    );
    const truncated = applySnapshot<Row>(
      null,
      snap([row("a")], { rev: 100, total: 60_000, indexTruncated: true }),
      indexed,
    );

    expect(clamped.clamped).toBe(true);
    expect(clamped.indexTruncated).toBe(false);
    expect(truncated.index).toBeNull();
    expect(truncated.indexTruncated).toBe(true);
    expect(truncated.totalCount).toBe(60_000);
  });
});

describe("items loaded by id", () => {
  it("drops an item older than what a delta brought, and removes a requested id the answer leaves out", () => {
    const first = applySnapshot<Row>(null, snap([row("a", 1), row("b", 1)], { rev: 100 }), plain);
    const { state: live } = apply(first, { t: "patched", id: "a", d: { v: 7 } }, 300);
    const state = applyItems(live, [row("a", 2), row("c", 3)], 250, plain, ["a", "b", "c"]);

    expect(state.byId.get("a")).toEqual(row("a", 7));
    expect(state.byId.get("c")).toEqual(row("c", 3));
    expect(state.byId.has("b")).toBe(false);
    expect(state.removed.get("b")).toBe(250);
  });

  it("names the items a reload did not refresh", () => {
    const first = applySnapshot<Row>(null, snap([row("a"), row("b")], { rev: 100 }), plain);
    const paged = applyPage(first, snap([row("c")], { rev: 150 }), plain);
    const reloaded = applySnapshot(paged, snap([row("a")], { rev: 200, cursor: "1" }), plain);

    expect(staleIds(reloaded)).toEqual(["b", "c"]);
    expect(staleIds(applyItems(reloaded, [row("b")], 210, plain, ["b"]))).toEqual(["c"]);
  });
});

describe("items read outside the scope (a search's results)", () => {
  const members = [row("a", 1), row("b", 2), row("c", 3), row("d", 4)];
  /** Every member in the index, the first two loaded. */
  const indexedBase = (): CollectionState<Row> =>
    applySnapshot<Row>(
      null,
      snap(members.slice(0, 2), { rev: 100, cursor: "2", members }),
      indexed,
    );

  it("keeps an index member's item, unless the state holds a newer one, counting nothing", () => {
    const { state: live } = apply(
      indexedBase(),
      { t: "patched", id: "a", d: { v: 0 } },
      300,
      indexed,
    );
    const { state, missing } = applyKept(live, [row("d", 4), row("a", 1)], 200, indexed);

    expect(state.byId.get("d")).toEqual(row("d", 4));
    expect(state.byId.get("a")).toEqual(row("a", 0));
    expect(state.revById.get("d")).toBe(200);
    expect(ids(state)).toEqual(["a", "b", "d"]);
    expect(state.totalCount).toBe(4);
    expect(missing).toEqual([]);
    // A later patch of the member now applies to its item.
    const { state: patched } = apply(state, { t: "patched", id: "d", d: { v: 8 } }, 400, indexed);
    expect(patched.byId.get("d")).toEqual(row("d", 8));
  });

  it("leaves out an id the index does not hold, and names a member whose row is newer than the read", () => {
    const { state: live } = apply(
      indexedBase(),
      { t: "patched", id: "c", d: { v: 9 } },
      300,
      indexed,
    );
    const { state, missing } = applyKept(live, [row("c", 3), row("x", 5)], 200, indexed);

    expect(state.byId.has("c")).toBe(false);
    expect(state.byId.has("x")).toBe(false);
    expect(state.index?.some((member) => member.id === "x")).toBe(false);
    expect(missing).toEqual(["c"]);
  });

  it("without an index, never brings an item into a paged window, but does into a whole scope", () => {
    const paged = applySnapshot<Row>(
      null,
      snap([row("a"), row("b")], { rev: 100, cursor: "2" }),
      plain,
    );
    expect(applyKept(paged, [row("c")], 200, plain).state).toBe(paged);
    expect(applyKept(paged, [row("c")], 200, plain, { loadAll: true }).state.byId.has("c")).toBe(
      true,
    );
    const whole = applySnapshot<Row>(null, snap([row("a")], { rev: 100 }), plain);
    const { state } = applyKept(whole, [row("a", 2), row("c")], 200, plain);
    expect(ids(state)).toEqual(["a", "c"]);
    expect(state.byId.get("a")).toEqual(row("a", 2));
    expect(state.totalCount).toBe(1);
  });

  it("does not bring back an item removed after the read", () => {
    const whole = applySnapshot<Row>(null, snap([row("a"), row("b")], { rev: 100 }), plain);
    const { state: removed } = apply(whole, { t: "removed", id: "b" }, 300);
    expect(applyKept(removed, [row("b")], 200, plain).state).toBe(removed);
  });
});

describe("views", () => {
  interface Card {
    readonly id: string;
    readonly assigneeId: string | null;
    readonly status: string;
  }
  const shape: CollectionShape = {
    index: ["assigneeId", "status"],
    order: [["id", "asc"]],
  };
  const cards: Card[] = [
    { id: "a", assigneeId: "u1", status: "open" },
    { id: "b", assigneeId: "u2", status: "open" },
    { id: "c", assigneeId: "u1", status: "done" },
  ];
  const mine = viewPredicate(
    {
      views: {
        mine: (member: { readonly assigneeId: unknown }, who) => member.assigneeId === who.userId,
      },
    },
    "mine",
  );
  const show = (state: CollectionState<Card>, userId = "u1") =>
    showCollection(state, { view: mine, who: { userId }, overlay: (value) => value });

  function boardOf(loaded: readonly Card[]): CollectionState<Card> {
    return applySnapshot<Card>(
      null,
      {
        rev: 100,
        items: loaded,
        total: cards.length,
        cursor: null,
        index: cards.map((card) => [card.id, 100, card.assigneeId, card.status]),
      },
      shape,
    );
  }

  it("selects the members a view's predicate selects for the user, and their items loaded", () => {
    const view = show(boardOf(cards.slice(0, 2)));

    expect(view.index?.map((member) => member.id)).toEqual(["a", "c"]);
    expect(view.items.map((item) => item.id)).toEqual(["a"]);
    expect(show(boardOf(cards), "u2").items.map((item) => item.id)).toEqual(["b"]);
  });

  it("moves a member into and out of the view when a delta changes its index field", () => {
    const { state } = applyDeltas(
      boardOf(cards),
      [{ t: "patched", id: "b", d: { assigneeId: "u1" } }],
      200,
      shape,
    );
    const { state: away } = applyDeltas(
      state,
      [{ t: "patched", id: "a", d: { assigneeId: null } }],
      300,
      shape,
    );

    expect(show(state).index?.map((member) => member.id)).toEqual(["a", "b", "c"]);
    expect(show(away).index?.map((member) => member.id)).toEqual(["b", "c"]);
  });

  it("selects nothing for a view the collection does not declare", () => {
    const unknown = viewPredicate({ views: {} }, "theirs");
    const view = showCollection(boardOf(cards), {
      view: unknown,
      who: { userId: "u1" },
      overlay: (value) => value,
    });
    expect(view.index).toEqual([]);
    expect(viewPredicate({ views: {} }, undefined)).toBeUndefined();
  });

  it("runs over the items loaded when the scope is too large for an index", () => {
    const truncated = applySnapshot<Card>(
      null,
      { rev: 100, items: cards, total: 60_000, cursor: "x", indexTruncated: true },
      shape,
    );
    const view = show(truncated);

    expect(view.index).toBeUndefined();
    expect(view.items.map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("lays overlays over rows and items, and hides what an overlay removes", () => {
    const view = showCollection(boardOf(cards), {
      view: mine,
      who: { userId: "u1" },
      overlay: <T>(value: T) => {
        const { id } = value as { readonly id: string };
        if (id === "c") {
          return undefined;
        }
        return id === "b" ? ({ ...value, assigneeId: "u1" } as T) : value;
      },
    });

    expect(view.index?.map((member) => member.id)).toEqual(["a", "b"]);
    expect(view.items).toEqual([cards[0], { ...cards[1], assigneeId: "u1" }]);
  });
});

describe("items an optimistic update added", () => {
  const noOverlay = <T>(value: T): T => value;
  const by = (state: CollectionState<Row>, extra: readonly Row[], shape: CollectionShape) =>
    showCollection(state, { who: { userId: "u1" }, overlay: noOverlay, added: extra, shape });

  it("show in the index's order, items following it, and hide once the scope holds their id", () => {
    const state = applySnapshot<Row>(
      null,
      snap([row("a", 1), row("c", 3)], { rev: 10, members: [row("a", 1), row("c", 3)] }),
      indexed,
    );
    const view = by(state, [row("new", 2), row("last", 9)], indexed);
    expect(view.index?.map((member) => member.id)).toEqual(["a", "new", "c", "last"]);
    expect(view.items.map((item) => item.id)).toEqual(["a", "new", "c", "last"]);
    expect(view.byId.get("new")).toEqual(row("new", 2));
    // The server's own copy arrived: shown once, as the scope holds it.
    const { state: arrived } = apply(state, added(row("new", 2), ["new", 11, 2]), 11, indexed);
    expect(by(arrived, [row("new", 2)], indexed).items.map((item) => item.id)).toEqual([
      "a",
      "new",
      "c",
    ]);
  });

  it("show in their place by order without an index, else last", () => {
    const ordered: CollectionShape = { order: indexed.order };
    const state = applySnapshot<Row>(null, snap([row("a", 1), row("c", 3)], { rev: 10 }), ordered);
    expect(by(state, [row("b", 2)], ordered).items.map((item) => item.id)).toEqual(["a", "b", "c"]);
    // An item without the order's fields goes last.
    const loose = { id: "z" } as unknown as Row;
    expect(by(state, [loose, row("b", 2)], ordered).items.map((item) => item.id)).toEqual([
      "a",
      "b",
      "c",
      "z",
    ]);
    const unordered = applySnapshot<Row>(null, snap([row("a", 1)], { rev: 10 }), plain);
    expect(by(unordered, [row("b", 0)], plain).items.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("go through the view and the overlays like any member", () => {
    const state = applySnapshot<Row>(
      null,
      snap([row("a", 1)], { rev: 10, members: [row("a", 1)] }),
      indexed,
    );
    const view = showCollection(state, {
      view: (member) => member.v !== 5,
      who: { userId: "u1" },
      overlay: <T>(value: T) =>
        (value as { readonly id: string }).id === "hidden" ? undefined : value,
      added: [row("x", 5), row("hidden", 2), row("y", 2)],
      shape: indexed,
    });
    expect(view.items.map((item) => item.id)).toEqual(["a", "y"]);
  });
});

describe("cost", () => {
  /** Loads `total` items of a scope without an index, by `ordinal`, as a snapshot and pages of 500. */
  function loadWhole(total: number) {
    const shape: CollectionShape = {
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
    };
    const item = (n: number) => ({ id: `t${String(n).padStart(8, "0")}`, ordinal: n });
    const page = (start: number) =>
      Array.from({ length: Math.min(500, total - start) }, (_, offset) => item(start + offset));
    let state = applySnapshot(null, { rev: 1, items: page(0), total, cursor: "c" }, shape);
    const started = performance.now();
    for (let start = 500; start < total; start += 500) {
      const cursor = start + 500 >= total ? null : "c";
      state = applyPage(state, { rev: 2, items: page(start), total, cursor }, shape);
    }
    return { state, ms: performance.now() - started };
  }

  it("loads 20,000 items without an index in time linear in their number, in order", () => {
    const { state, ms } = loadWhole(20_000);
    const loaded = loadedIds(state);
    expect(loaded).toHaveLength(20_000);
    expect(loaded[0]).toBe("t00000000");
    expect(loaded.at(-1)).toBe("t00019999");
    expect(state.nextCursor).toBeNull();
    // Placing each item by scanning every item loaded took 8 s here; a
    // binary search takes a few hundred milliseconds even on a slow runner.
    expect(ms).toBeLessThan(2_000);
  });
});

describe("tombstones", () => {
  it("keeps the latest 1,000 per scope, dropping the oldest first", () => {
    let state = applySnapshot<Row>(null, snap([], { rev: 1 }), plain);
    for (let n = 1; n <= 1500; n += 1) {
      state = apply(state, { t: "removed", id: `gone-${n}` }, 1 + n).state;
    }
    expect(state.removed.size).toBe(MAX_TOMBSTONES);
    expect(state.removed.has("gone-500")).toBe(false);
    expect(state.removed.get("gone-501")).toBe(502);
    expect(state.removed.get("gone-1500")).toBe(1501);
    // A late add older than a removal still kept stays out.
    expect(ids(apply(state, added(row("gone-1500")), 1000).state)).toEqual([]);
  });

  it("shares them with the state before a frame that removes and restores nothing", () => {
    const first = applySnapshot<Row>(null, snap([row("a")], { rev: 100 }), plain);
    const removed = apply(first, { t: "removed", id: "b" }, 200).state;
    const next = applyDeltas<Row>(
      removed,
      [
        added(row("c")),
        { t: "updated", item: row("a", 4) },
        { t: "patched", id: "a", d: { v: 5 } },
      ],
      300,
      plain,
    ).state;
    expect(next).not.toBe(removed);
    expect(next.removed).toBe(removed.removed);
    const back = apply(next, added(row("b")), 400).state;
    expect(back.removed).not.toBe(removed.removed);
    expect(back.removed.has("b")).toBe(false);
  });
});
