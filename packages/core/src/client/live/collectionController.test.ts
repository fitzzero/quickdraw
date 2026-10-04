// A collection scope's pipeline (RFC 0003 sections 7.2 to 7.4 and 11.5) over
// a socket the test drives, so races happen in a chosen order. The first
// block is 4.1's `useCollection` tests
// (`legacy-src/client/useCollection.test.tsx`) on the 5.0 controller: a
// reconnect now resumes from a revision rather than loading everything again,
// a reset reloads after a random delay rather than a fixed 100 ms, and the
// hook-only cases (a disabled hook, `compare`, `onDelta`, `onError`) moved
// to the hook tests and the store tests or went with the options. The
// blocks after it are new; the same pipeline against the real server is in
// `live.test.ts`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { deferred, tick } from "../../server/__tests__/fixtures";
import { collectionKey } from "../keys";
import { mutateOptimistically, overlaysOf } from "../optimistic";
import { fakeConnection, testQueryClient } from "./__tests__/fakeSocket";
import type { CollectionEntry, CollectionTarget } from "./collectionLoads";
import { loadedIds } from "./collectionStore";
import { liveDataOf } from "./liveData";

interface Row {
  readonly id: string;
  readonly v: number;
}

const row = (id: string, v = 0): Row => ({ id, v });

const SCOPE = "chat-1";

const target: CollectionTarget = {
  service: "chatService",
  collection: "byChat",
  def: { scope: "chatId", item: "entity", order: [["id", "asc"]] },
};

const indexedTarget: CollectionTarget = {
  service: "chatService",
  collection: "board",
  def: {
    scope: "chatId",
    item: "entity",
    order: [
      ["v", "asc"],
      ["id", "asc"],
    ],
    index: ["v"],
  },
};

function snapshot(
  items: readonly Row[],
  options: { readonly rev?: number; readonly cursor?: string | null; readonly total?: number } = {},
) {
  return {
    ok: true,
    rev: options.rev ?? 100,
    items,
    total: options.total ?? items.length,
    cursor: options.cursor ?? null,
    limit: 100,
  };
}

function frame(rev: number, deltas: readonly unknown[], collection = "byChat") {
  return { s: "chatService", c: collection, scope: SCOPE, rev, deltas };
}

function setup(scopeTarget: CollectionTarget = target) {
  const fake = fakeConnection();
  const queryClient = testQueryClient();
  const live = liveDataOf(fake.connection, queryClient);
  const key = collectionKey(scopeTarget.service, scopeTarget.collection, SCOPE);
  const entry = () => queryClient.getQueryData<CollectionEntry<Row>>(key);
  const ids = (): string[] => {
    const state = entry()?.state;
    return state === null || state === undefined ? [] : loadedIds(state);
  };
  return { fake, live, entry, ids };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("4.1 useCollection cases, on the controller", () => {
  it("subscribes without a cursor, applies the snapshot, and applies deltas", () => {
    const { fake, live, entry, ids } = setup();
    live.collections.subscribe(target, SCOPE);

    expect(entry()).toBeUndefined();
    expect(fake.sent("qd:col:sub").map((sent) => sent.frame)).toEqual([
      { s: "chatService", c: "byChat", scope: SCOPE },
    ]);
    fake.answer("qd:col:sub", 0, snapshot([row("a", 1), row("b", 1)], { cursor: "2", total: 3 }));
    expect(ids()).toEqual(["a", "b"]);
    expect(entry()?.state?.totalCount).toBe(3);
    expect(entry()?.state?.nextCursor).toBe("2");

    fake.deliver("qd:c", frame(200, [{ t: "added", item: row("c", 1) }]));
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(entry()?.state?.totalCount).toBe(4);

    fake.deliver("qd:c", frame(300, [{ t: "removed", id: "a" }]));
    expect(ids()).toEqual(["b", "c"]);

    // An older delta is ignored.
    fake.deliver("qd:c", frame(250, [{ t: "added", item: row("a", 9) }]));
    expect(ids()).toEqual(["b", "c"]);
  });

  it("keeps the deltas that arrive while the snapshot is in flight, and applies them on top", () => {
    const { fake, live, entry, ids } = setup();
    live.collections.subscribe(target, SCOPE);

    // Deltas race the snapshot's answer.
    fake.deliver("qd:c", frame(300, [{ t: "added", item: row("c", 2) }]));
    fake.deliver("qd:c", frame(50, [{ t: "updated", item: row("a", 7) }]));
    expect(entry()).toBeUndefined();
    fake.answer("qd:col:sub", 0, snapshot([row("a", 1), row("b", 1)], { rev: 100 }));

    expect(ids()).toEqual(["a", "b", "c"]);
    // The newer kept add applied; the kept update older than the snapshot lost.
    expect(entry()?.state?.byId.get("a")).toEqual(row("a", 1));
    expect(entry()?.state?.byId.get("c")).toEqual(row("c", 2));
  });

  it("loadMore reads the next page by cursor and prunes nothing", async () => {
    const { fake, live, entry, ids } = setup();
    const { controller } = live.collections.subscribe(target, SCOPE);
    fake.answer("qd:col:sub", 0, snapshot([row("a")], { cursor: "1", total: 3 }));
    expect(entry()?.state?.nextCursor).toBe("1");

    const more = controller.loadMore();
    expect(entry()?.loadingMore).toBe(true);
    expect(fake.sent("qd:col:sub")[1]?.frame).toEqual({
      s: "chatService",
      c: "byChat",
      scope: SCOPE,
      cursor: "1",
    });
    fake.answer("qd:col:sub", 1, snapshot([row("b"), row("c")], { cursor: null, total: 3 }));
    await more;

    expect(ids()).toEqual(["a", "b", "c"]);
    expect(entry()?.state?.nextCursor).toBeNull();
    expect(entry()?.loadingMore).toBe(false);
  });

  it("after a reconnect, resumes from the revision held and applies the missed deltas in order", () => {
    const { fake, live, ids } = setup();
    live.collections.subscribe(target, SCOPE);
    fake.answer("qd:col:sub", 0, snapshot([row("a"), row("b")], { rev: 100 }));
    fake.deliver("qd:c", frame(150, [{ t: "patched", id: "a", d: { v: 1 } }]));

    fake.disconnect();
    // The state outlives the disconnect: nothing is cleared.
    expect(ids()).toEqual(["a", "b"]);
    fake.reconnect();
    expect(fake.sent("qd:col:sub")[1]?.frame).toEqual({
      s: "chatService",
      c: "byChat",
      scope: SCOPE,
      since: 150,
    });
    fake.answer("qd:col:sub", 1, {
      ok: true,
      resumed: true,
      rev: 400,
      deltas: [
        { t: "removed", id: "b" },
        { t: "added", item: row("c") },
        { t: "removed", id: "c" },
        { t: "added", item: row("c", 3) },
      ],
    });

    expect(ids()).toEqual(["a", "c"]);
    // One cursor-less subscribe, then one resume: no snapshot.
    expect(fake.sent("qd:col:sub")).toHaveLength(2);
  });

  it("a reset reloads the scope after a random delay, once for two resets", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fake, live } = setup();
    live.collections.subscribe(target, SCOPE);
    fake.answer("qd:col:sub", 0, snapshot([row("a")]));

    fake.deliver("qd:c", frame(200, [{ t: "reset" }]));
    fake.deliver("qd:c", frame(201, [{ t: "reset" }]));
    expect(fake.sent("qd:col:sub")).toHaveLength(1);
    await tick(150);
    expect(fake.sent("qd:col:sub")).toHaveLength(2);
    expect(fake.sent("qd:col:sub")[1]?.frame).not.toHaveProperty("since");
    await tick(150);
    expect(fake.sent("qd:col:sub")).toHaveLength(2);
  });

  it("waits between 100 and 2,000 ms before that reload", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const { fake, live } = setup();
    live.collections.subscribe(target, SCOPE);
    fake.answer("qd:col:sub", 0, snapshot([row("a")]));
    fake.deliver("qd:c", frame(200, [{ t: "reset" }]));
    await tick(1000);
    expect(fake.sent("qd:col:sub")).toHaveLength(1);
    await tick(150);
    expect(fake.sent("qd:col:sub")).toHaveLength(2);
  });

  it("shares one pipeline between holders, and unsubscribes a tick after the last lets go", async () => {
    const { fake, live, ids } = setup();
    const first = live.collections.subscribe(target, SCOPE);
    const second = live.collections.subscribe(target, SCOPE);
    expect(fake.sent("qd:col:sub")).toHaveLength(1);
    fake.answer("qd:col:sub", 0, snapshot([row("a")], { cursor: "1", total: 2 }));

    // The second holder drives the shared pipeline.
    const more = second.controller.loadMore();
    fake.answer("qd:col:sub", 1, snapshot([row("b")], { total: 2 }));
    await more;
    expect(ids()).toEqual(["a", "b"]);

    first.release();
    await tick();
    expect(fake.sent("qd:col:unsub")).toEqual([]);
    second.release();
    expect(fake.sent("qd:col:unsub")).toEqual([]);
    await tick();
    expect(fake.sent("qd:col:unsub").map((sent) => sent.frame)).toEqual([
      { s: "chatService", c: "byChat", scope: SCOPE },
    ]);
  });

  it("keeps the error of a refused snapshot, with no state", () => {
    const { fake, live, entry } = setup();
    live.collections.subscribe(target, SCOPE);
    fake.answer("qd:col:sub", 0, {
      ok: false,
      e: { code: "FORBIDDEN", message: "Insufficient permissions" },
    });

    expect(entry()?.state).toBeNull();
    expect(entry()?.error?.code).toBe("FORBIDDEN");
  });
});

describe("races and requests", () => {
  it("falls back to a snapshot when the server cannot resume, and reloads by id the items it did not refresh", async () => {
    const { fake, live, ids } = setup();
    const { controller } = live.collections.subscribe(target, SCOPE);
    fake.answer(
      "qd:col:sub",
      0,
      snapshot([row("a"), row("b")], { rev: 100, cursor: "2", total: 4 }),
    );
    const more = controller.loadMore();
    fake.answer("qd:col:sub", 1, snapshot([row("c"), row("d")], { rev: 120, total: 4 }));
    await more;

    fake.disconnect();
    fake.reconnect();
    expect(fake.sent("qd:col:sub")[2]?.frame).toMatchObject({ since: 100 });
    // Too long away: a snapshot instead, its first page only.
    fake.answer(
      "qd:col:sub",
      2,
      snapshot([row("a", 1), row("b", 1)], { rev: 500, cursor: "2", total: 3 }),
    );
    await tick();

    expect(ids()).toEqual(["a", "b", "c", "d"]);
    expect(fake.sent("qd:col:items").map((sent) => sent.frame)).toEqual([
      { s: "chatService", c: "byChat", scope: SCOPE, ids: ["c", "d"] },
    ]);
    // "d" was deleted meanwhile: the answer leaves it out.
    fake.answer("qd:col:items", 0, { ok: true, rev: 500, items: [row("c", 1)] });
    await tick();
    expect(ids()).toEqual(["a", "b", "c"]);
  });

  it("a reload cancels the page in flight: its answer is dropped", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fake, live, entry, ids } = setup();
    const { controller } = live.collections.subscribe(target, SCOPE);
    fake.answer("qd:col:sub", 0, snapshot([row("a")], { cursor: "1", total: 3 }));
    const more = controller.loadMore();
    fake.deliver("qd:c", frame(200, [{ t: "reset" }]));
    await tick(150);
    fake.answer("qd:col:sub", 2, snapshot([row("z")], { rev: 300, cursor: "9", total: 1 }));

    fake.answer("qd:col:sub", 1, snapshot([row("b"), row("c")], { total: 3 }));
    await more;
    expect(ids()).toEqual(["z", "a"]);
    expect(entry()?.state?.nextCursor).toBe("9");
    expect(entry()?.loadingMore).toBe(false);
  });

  it("loads the item a patch names but it does not hold with qd:col:items, never a partial one", async () => {
    const { fake, live, entry, ids } = setup();
    live.collections.subscribe(target, SCOPE);
    // Loaded whole: a member it does not hold is one it missed.
    fake.answer("qd:col:sub", 0, snapshot([row("a")], { total: 1 }));

    fake.deliver("qd:c", frame(200, [{ t: "patched", id: "far", d: { v: 5 } }]));
    expect(entry()?.state?.byId.has("far")).toBe(false);
    await tick();
    expect(fake.sent("qd:col:items").map((sent) => sent.frame)).toEqual([
      { s: "chatService", c: "byChat", scope: SCOPE, ids: ["far"] },
    ]);
    fake.answer("qd:col:items", 0, { ok: true, rev: 210, items: [row("far", 5)] });
    await tick();
    expect(ids()).toEqual(["a", "far"]);
    expect(entry()?.state?.byId.get("far")).toEqual(row("far", 5));
  });

  it("with load all, reads every page until the cursor is null, then stops", async () => {
    const { fake, live, ids } = setup();
    live.collections.subscribe(target, SCOPE, { loadAll: true });
    expect(fake.sent("qd:col:sub")[0]?.frame).toMatchObject({ limit: 500 });
    fake.answer("qd:col:sub", 0, snapshot([row("a")], { cursor: "1", total: 3 }));
    await tick();
    expect(fake.sent("qd:col:sub")[1]?.frame).toMatchObject({ cursor: "1", limit: 500 });
    fake.answer("qd:col:sub", 1, snapshot([row("b")], { cursor: "2", total: 3 }));
    await tick();
    fake.answer("qd:col:sub", 2, snapshot([row("c")], { cursor: null, total: 3 }));
    await tick(20);

    expect(ids()).toEqual(["a", "b", "c"]);
    expect(fake.sent("qd:col:sub")).toHaveLength(3);
  });

  it("with load all and no index, drops an item deleted during an outage once the reload's pages are read", async () => {
    const { fake, live, entry, ids } = setup();
    live.collections.subscribe(target, SCOPE, { loadAll: true });
    fake.answer("qd:col:sub", 0, snapshot([row("a"), row("b")], { cursor: "c1", total: 4 }));
    await tick();
    expect(fake.sent("qd:col:sub")[1]?.frame).toMatchObject({ cursor: "c1" });
    fake.answer("qd:col:sub", 1, snapshot([row("c"), row("x")], { rev: 101, total: 4 }));
    await tick();
    expect(ids()).toEqual(["a", "b", "c", "x"]);

    fake.disconnect();
    fake.reconnect();
    expect(fake.sent("qd:col:sub")[2]?.frame).toMatchObject({ since: 100 });
    // The server cannot resume: a snapshot, its first page only. "x" was deleted meanwhile.
    fake.answer(
      "qd:col:sub",
      2,
      snapshot([row("a"), row("b")], { rev: 200, cursor: "c2", total: 3 }),
    );
    await tick();
    // Still reading pages: nothing is dropped before the last one.
    expect(ids()).toEqual(["a", "b", "c", "x"]);
    expect(fake.sent("qd:col:sub")[3]?.frame).toMatchObject({ cursor: "c2" });
    fake.answer("qd:col:sub", 3, snapshot([row("c")], { rev: 200, total: 3 }));
    await tick();
    expect(ids()).toEqual(["a", "b", "c"]);
    expect(entry()?.state?.totalCount).toBe(3);
    expect(entry()?.state?.removed.get("x")).toBe(200);
    expect(fake.sent("qd:col:items")).toEqual([]);
  });

  it("keeps an optimistic layer over a snapshot read before the write and applied after its reply", async () => {
    const fake = fakeConnection();
    const queryClient = testQueryClient();
    const live = liveDataOf(fake.connection, queryClient);
    const overlays = overlaysOf(queryClient);
    const { controller } = live.collections.subscribe(target, SCOPE);
    fake.answer("qd:col:sub", 0, snapshot([row("a", 1)], { rev: 100 }));
    const reply = deferred<unknown>();
    const done = mutateOptimistically(
      queryClient,
      { service: "chatService", entityOutput: true },
      undefined,
      { id: "a", v: 9 },
      () => reply.promise,
    );
    // A reload is asked for while the write is in flight, and answered after its reply.
    const refreshed = controller.refresh();
    reply.resolve(row("a", 9));
    await done;
    fake.answer("qd:col:sub", 1, snapshot([row("a", 1)], { rev: 300 }));
    await refreshed;
    const shown = () => overlays.applyOverlay("chatService", row("a", 1), { collection: "byChat" });
    expect(shown()).toEqual(row("a", 9));
    // The write's own frame ends it.
    fake.deliver("qd:c", frame(301, [{ t: "patched", id: "a", d: { v: 9 } }]));
    expect(shown()).toEqual(row("a", 1));
  });

  it("drops a revoked scope's state and error-marks it; refresh loads it again", async () => {
    const { fake, live, entry, ids } = setup();
    const { controller } = live.collections.subscribe(target, SCOPE);
    fake.answer("qd:col:sub", 0, snapshot([row("a")]));

    fake.deliver("qd:revoked", {
      kind: "collection",
      reason: "access",
      s: "chatService",
      c: "byChat",
      scope: SCOPE,
    });
    expect(entry()?.state).toBeNull();
    expect(entry()?.error?.code).toBe("FORBIDDEN");

    const refreshed = controller.refresh();
    fake.answer("qd:col:sub", 1, snapshot([row("b")], { rev: 300 }));
    await refreshed;
    expect(ids()).toEqual(["b"]);
    expect(entry()?.error).toBeNull();
  });

  it("closes a scope whose anchor row was deleted with NOT_FOUND", () => {
    const { fake, live, entry } = setup();
    live.collections.subscribe(target, SCOPE);
    fake.answer("qd:col:sub", 0, snapshot([row("a")]));
    fake.deliver("qd:revoked", {
      kind: "collection",
      reason: "anchor-deleted",
      s: "chatService",
      c: "byChat",
      scope: SCOPE,
    });
    expect(entry()?.state).toBeNull();
    expect(entry()?.error?.code).toBe("NOT_FOUND");
  });

  it("keeps the index in order from the deltas of an indexed scope", () => {
    const { fake, live, entry, ids } = setup(indexedTarget);
    live.collections.subscribe(indexedTarget, SCOPE);
    fake.answer("qd:col:sub", 0, {
      ...snapshot([row("a", 1)], { cursor: "1", total: 2 }),
      index: [
        ["a", 100, 1],
        ["b", 100, 2],
      ],
    });
    fake.deliver(
      "qd:c",
      frame(
        200,
        [
          { t: "added", item: row("c", 0), index: ["c", 200, 0] },
          { t: "patched", id: "a", d: { v: 3 } },
        ],
        "board",
      ),
    );

    expect(entry()?.state?.index?.map((member) => member.id)).toEqual(["c", "b", "a"]);
    expect(ids()).toEqual(["c", "a"]);
  });
});

describe("one listener per frame type, and the lane", () => {
  it("serves every scope from one qd:c and one qd:revoked listener", () => {
    const { fake, live } = setup();
    for (const scope of ["s1", "s2", "s3"]) {
      live.collections.subscribe(target, scope);
    }
    expect(fake.listenerCount("qd:c")).toBe(1);
    expect(fake.listenerCount("qd:revoked")).toBe(1);
    expect(fake.listenerCount("qd:e")).toBe(1);
  });

  it("keeps at most eight subscription events in flight, before the hello says otherwise", () => {
    const { fake, live } = setup();
    for (let scope = 0; scope < 20; scope += 1) {
      live.collections.subscribe(target, `scope-${scope}`);
    }
    expect(fake.sent("qd:col:sub")).toHaveLength(8);
    expect(fake.connection.subscriptionLane.waiting()).toBe(12);
    fake.answer("qd:col:sub", 0, snapshot([]));
    expect(fake.sent("qd:col:sub")).toHaveLength(9);
  });
});
