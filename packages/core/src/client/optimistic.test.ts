// The overlay store of optimistic mutations (RFC 0003 section 11.4), without
// React: layers opened when a call is sent, dropped when it fails, kept
// after it succeeds (shown over rows read before it finished, not over rows
// read after) until a newer revision, stacked in call order, and shown only
// over the fields a row has.

import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { QuickdrawError, listOf, nullable } from "../index";
import { deferred, type Deferred } from "../server/__tests__/fixtures";
import { collectionKey } from "./keys";
import { overlaysOf, resetOverlays, settleAdditions, storeOf } from "./optimistic";
import { mutateOptimistically, type OptimisticTarget } from "./optimisticCall";
import { rowShapeOf, showRows } from "./overlayRows";

const task: OptimisticTarget = { service: "taskService", entityOutput: true };
const row = Object.freeze({ id: "t1", title: "T1", status: "open" });
const other = Object.freeze({ id: "t2", title: "T2", status: "open" });

/** One mutation call whose reply the test gives. */
function send(
  client: QueryClient,
  input: unknown,
  optimistic?: Parameters<typeof mutateOptimistically>[2],
) {
  const reply = deferred<unknown>();
  const call = vi.fn(() => reply.promise);
  const done = mutateOptimistically(client, task, optimistic, input, call);
  return { reply, call, done };
}

describe("a pending call", () => {
  it("shows its input's fields over the rows that have them, and only those rows", () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const { call } = send(client, { id: "t1", title: "New", notify: true });
    expect(call).toHaveBeenCalledTimes(1);
    expect(overlays.applyOverlay("taskService", row)).toEqual({
      id: "t1",
      title: "New",
      status: "open",
    });
    expect(overlays.applyOverlay("taskService", other)).toBe(other);
    expect(overlays.applyOverlay("labelService", row)).toBe(row);
    expect(overlays.applyOverlay("taskService", "not a row")).toBe("not a row");
  });

  it("is dropped when the call fails", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const { reply, done } = send(client, { id: "t1", title: "New" });
    reply.reject(new QuickdrawError("CONFLICT", "That title is taken"));
    await expect(done).rejects.toMatchObject({ code: "CONFLICT" });
    expect(overlays.applyOverlay("taskService", row)).toBe(row);
  });

  it("stacks with other calls in call order, and each is dropped with its own call", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const first = send(client, { id: "t1", title: "First" });
    const second = send(client, { id: "t1", status: "done" });
    const third = send(client, { id: "t1", title: "Third" });
    expect(overlays.applyOverlay("taskService", row)).toEqual({
      id: "t1",
      title: "Third",
      status: "done",
    });
    third.reply.reject(new QuickdrawError("FORBIDDEN", "No"));
    await expect(third.done).rejects.toThrow("No");
    expect(overlays.applyOverlay("taskService", row)).toEqual({
      id: "t1",
      title: "First",
      status: "done",
    });
    first.reply.resolve({ ...row, title: "First" });
    second.reply.resolve({ ...row, status: "done" });
    await Promise.all([first.done, second.done]);
    expect(overlays.applyOverlay("taskService", row)).toEqual({
      id: "t1",
      title: "First",
      status: "done",
    });
  });
});

describe("a finished call", () => {
  it("shows the reply's values over rows read before it finished, and not over rows read after", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const readBefore = overlays.now();
    const { reply, done } = send(client, { id: "t1", title: "  New  " });
    const readWhilePending = overlays.now();
    reply.resolve({ ...row, title: "New" });
    expect(await done).toEqual({ ...row, title: "New" });
    const readAfter = overlays.now();
    const shown = { ...row, title: "New" };
    expect(overlays.applyOverlay("taskService", row)).toEqual(shown);
    expect(overlays.applyOverlay("taskService", row, { readAt: readBefore })).toEqual(shown);
    expect(overlays.applyOverlay("taskService", row, { readAt: readWhilePending })).toEqual(shown);
    expect(overlays.applyOverlay("taskService", row, { readAt: readAfter })).toBe(row);
    const view = overlays.view("taskService");
    expect(showRows(view, "list", [row], readBefore)).toEqual([shown]);
    expect(showRows(view, "list", [row], readAfter)).toEqual([row]);
  });

  it("is still shown while pending, whenever the row was read", () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    send(client, { id: "t1", title: "New" });
    expect(overlays.applyOverlay("taskService", row, { readAt: overlays.now() + 10 })).toEqual({
      ...row,
      title: "New",
    });
  });

  it("keeps its layer until a revision newer than every one seen before the write", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    overlays.observe("taskService", "t1", 5);
    const { reply, done } = send(client, { id: "t1", title: "New" });
    // Before the reply, a frame comes from an earlier flush.
    overlays.observe("taskService", "t1", 7);
    reply.resolve({ ...row, title: "New" });
    await done;
    overlays.observe("taskService", "t1", 6);
    overlays.observe("taskService", "t1", 7);
    expect(overlays.applyOverlay("taskService", row)).toEqual({ ...row, title: "New" });
    overlays.observe("taskService", "t1", 8);
    expect(overlays.applyOverlay("taskService", row)).toBe(row);
  });

  it("with no revision seen before the write, ends at the first one after it", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const { reply, done } = send(client, { id: "t1", title: "New" });
    reply.resolve(null);
    await done;
    overlays.observe("taskService", "t1", Number.NaN);
    expect(overlays.applyOverlay("taskService", row)).toEqual({ ...row, title: "New" });
    overlays.observe("taskService", "t1", 1);
    expect(overlays.applyOverlay("taskService", row)).toBe(row);
  });

  it("is not ended by the reply to a read sent before its reply, whatever its revision", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    overlays.observe("taskService", "t1", 5);
    const { reply, done } = send(client, { id: "t1", title: "New" });
    // A snapshot or a page is asked for while the call is in flight...
    const snapshotSent = overlays.now();
    reply.resolve({ ...row, title: "New" });
    await done;
    // ...and answered after the reply, with a revision newer than any seen.
    overlays.observe("taskService", "t1", 50, snapshotSent);
    expect(overlays.applyOverlay("taskService", row)).toEqual({ ...row, title: "New" });
    // A read sent after the reply holds the write.
    overlays.observe("taskService", "t1", 50, overlays.now());
    expect(overlays.applyOverlay("taskService", row)).toBe(row);
  });

  it("keeps the revision of a row with a layer while a thousand other rows are seen", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    overlays.observe("taskService", "t1", 7);
    // A first call holds a layer on the row, then a large board is read.
    send(client, { id: "t1", title: "Pending" });
    for (let seen = 0; seen < 1500; seen += 1) {
      overlays.observe("taskService", `other-${seen}`, 100 + seen);
    }
    const second = send(client, { id: "t1", status: "done" });
    second.reply.resolve({ ...row, status: "done" });
    await second.done;
    // A frame no newer than what was seen before the second write does not end it.
    overlays.observe("taskService", "t1", 7);
    expect(overlays.applyOverlay("taskService", row)?.status).toBe("done");
    overlays.observe("taskService", "t1", 8);
    expect(overlays.applyOverlay("taskService", row)?.status).toBe("open");
  });

  it("drops a finished layer that nothing ended within 10 s, a custom one on an unfollowed row too", async () => {
    vi.useFakeTimers();
    try {
      const client = new QueryClient();
      const overlays = overlaysOf(client);
      const told = vi.fn();
      overlays.subscribe(told);
      const { reply, done } = send(client, { id: "t1", title: "New" }, (input, cache) => {
        cache.patchEntity((input as { id: string }).id, { title: "New" });
        cache.patchItem("board", "t9", { title: "Never followed" });
      });
      reply.resolve({ ...row, title: "New" });
      await done;
      const unfollowed = { id: "t9", title: "T9" };
      expect(overlays.applyOverlay("taskService", unfollowed, { collection: "board" })).toEqual({
        id: "t9",
        title: "Never followed",
      });
      told.mockClear();
      vi.advanceTimersByTime(9999);
      expect(overlays.applyOverlay("taskService", row)).toEqual({ ...row, title: "New" });
      vi.advanceTimersByTime(1);
      expect(overlays.applyOverlay("taskService", row)).toBe(row);
      expect(overlays.applyOverlay("taskService", unfollowed, { collection: "board" })).toBe(
        unfollowed,
      );
      expect(told).toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("finishes when the reply arrives, so a frame handled before the call's promise settles still ends it", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    overlays.observe("taskService", "t1", 5);
    const reply = deferred<unknown>();
    const done = mutateOptimistically(
      client,
      task,
      undefined,
      { id: "t1", title: "New" },
      (replied) => {
        // The reply arrives, and in the same task the flush's frame after it.
        queueMicrotask(() => {
          replied({ ...row, title: "New" });
          overlays.observe("taskService", "t1", 6);
          reply.resolve({ ...row, title: "New" });
        });
        return reply.promise;
      },
    );
    await done;
    expect(overlays.applyOverlay("taskService", row)).toBe(row);
  });
});

describe("a custom optimistic update", () => {
  it("hides removed rows from lists and nullable results, and patches items of one collection only", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const { reply, done } = send(client, { id: "t1" }, (input, cache) => {
      cache.removeEntity("t2");
      cache.patchItem("board", (input as { id: string }).id, { title: "On the board" });
    });
    const view = overlays.view("taskService");
    expect(showRows(view, "list", [row, other], undefined)).toEqual([row]);
    const unchanged = [row];
    expect(showRows(view, "list", unchanged, undefined)).toBe(unchanged);
    expect(showRows(view, "nullable", other, undefined)).toBeNull();
    expect(showRows(view, "one", other, undefined)).toBe(other);
    expect(overlays.applyOverlay("taskService", row)).toBe(row);
    expect(overlays.applyOverlay("taskService", row, { collection: "board" })).toEqual({
      ...row,
      title: "On the board",
    });
    expect(overlays.applyOverlay("taskService", row, { collection: "mine" })).toBe(row);
    reply.reject(new QuickdrawError("FORBIDDEN", "No"));
    await expect(done).rejects.toThrow("No");
    const both = [row, other];
    expect(showRows(overlays.view("taskService"), "list", both, undefined)).toBe(both);
  });

  it("is used instead of the default, and a throw drops what it wrote without sending", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const { call, done } = send(client, { id: "t1", title: "New" }, (_input, cache) => {
      cache.patchEntity("t2", { title: "Elsewhere" });
      throw new Error("the update failed");
    });
    await expect(done).rejects.toThrow("the update failed");
    expect(call).not.toHaveBeenCalled();
    expect(overlays.applyOverlay("taskService", other)).toBe(other);
  });
});

describe("an added item", () => {
  const board = { service: "taskService", entityOutput: false } as const;
  const scopeOf =
    (client: QueryClient) =>
    (scope = "p1") =>
      overlaysOf(client).view("taskService").added("board", scope);

  /** A create whose update adds `item` to the board of p1; the test gives the reply. */
  function create(client: QueryClient, item: Record<string, unknown>) {
    const reply = deferred<unknown>();
    const done = mutateOptimistically(
      client,
      board,
      (_input, cache) => cache.addItem("board", "p1", item),
      { title: item.title },
      () => reply.promise,
    );
    return { reply, done };
  }

  /** Writes the board's state as the collection controller caches it, holding `ids`. */
  function hold(client: QueryClient, ids: readonly string[]): void {
    client.setQueryData(collectionKey("taskService", "board", "p1"), {
      state: {
        byId: new Map(ids.map((id) => [id, { id }])),
        revById: new Map(ids.map((id) => [id, 1])),
      },
      error: null,
      loadingMore: false,
    });
  }

  it("shows at once under a provisional id, flagged pending, in its own scope only", () => {
    const client = new QueryClient();
    const added = scopeOf(client);
    create(client, { title: "Draft", ordinal: 3 });
    expect(added()).toEqual([
      {
        item: { id: expect.stringMatching(/^qd:new:\d+$/), title: "Draft", ordinal: 3 },
        pending: true,
      },
    ]);
    expect(added("p2")).toEqual([]);
    expect(overlaysOf(client).view("labelService").added("board", "p1")).toEqual([]);
  });

  it("is dropped when the call fails", async () => {
    const client = new QueryClient();
    const { reply, done } = create(client, { title: "Draft" });
    reply.reject(new QuickdrawError("VALIDATION", "No title"));
    await expect(done).rejects.toMatchObject({ code: "VALIDATION" });
    expect(scopeOf(client)()).toEqual([]);
  });

  it('with onRefused: "keep", stays refused with its error until dismissed or sent again (finding F6.4)', async () => {
    const client = new QueryClient();
    const view = () => overlaysOf(client).view("taskService");
    const replies: Deferred<unknown>[] = [];
    const sendNext = () => {
      const reply = deferred<unknown>();
      replies.push(reply);
      return reply.promise;
    };
    const done = mutateOptimistically(
      client,
      board,
      (_input, cache) => cache.addItem("board", "p1", { title: "Draft" }, { onRefused: "keep" }),
      { title: "Draft" },
      sendNext,
    );
    replies[0]?.reject(new QuickdrawError("RATE_LIMITED", "Slow down"));
    await expect(done).rejects.toMatchObject({ code: "RATE_LIMITED" });
    // Out of the items, and kept as refused with the call's error.
    expect(view().added("board", "p1")).toEqual([]);
    const [refused] = view().refused("board", "p1");
    expect(refused).toMatchObject({ item: { title: "Draft" }, error: { code: "RATE_LIMITED" } });
    // Sent again: the update adds it anew, pending, and the reply settles it.
    storeOf(client).dismiss(refused?.addition as never);
    const again = refused?.addition.refusal?.retry();
    expect(view().refused("board", "p1")).toEqual([]);
    expect(view().added("board", "p1")).toEqual([
      { item: expect.objectContaining({ title: "Draft" }), pending: true },
    ]);
    replies[1]?.resolve({ id: "t9", title: "Draft" });
    await again;
    expect(view().added("board", "p1")).toEqual([
      { item: { id: "t9", title: "Draft" }, pending: false },
    ]);
    // A bad option is refused as the update runs.
    await expect(
      mutateOptimistically(
        client,
        board,
        (_input, cache) =>
          cache.addItem("board", "p1", { title: "x" }, { onRefused: "maybe" as "keep" }),
        {},
        sendNext,
      ),
    ).rejects.toThrow('addItem: onRefused is "keep" or "drop"');
  });

  it("takes the id and the values the reply names, and is no longer pending", async () => {
    const client = new QueryClient();
    const { reply, done } = create(client, { title: " Draft ", ordinal: 3 });
    reply.resolve({ id: "t9", title: "Draft", status: "open" });
    await done;
    // Only the fields the item has take the reply's values.
    expect(scopeOf(client)()).toEqual([
      { item: { id: "t9", title: "Draft", ordinal: 3 }, pending: false },
    ]);
  });

  it("is dropped when the reply names no id, or when its scope already holds the one it names", async () => {
    const client = new QueryClient();
    const nameless = create(client, { title: "Draft" });
    nameless.reply.resolve(null);
    await nameless.done;
    expect(scopeOf(client)()).toEqual([]);
    const held = create(client, { title: "Draft" });
    hold(client, ["t9"]);
    held.reply.resolve({ id: "t9" });
    await held.done;
    expect(scopeOf(client)()).toEqual([]);
  });

  it("ends when its scope holds its id, a delta names it, or a load sent after its reply answers without it", async () => {
    const client = new QueryClient();
    const holds = (ids: readonly string[]) => (id: string) => ids.includes(id);
    const settle = (evidence: Parameters<typeof settleAdditions>[4]) => {
      settleAdditions(client, "taskService", "board", "p1", evidence);
    };
    const pending = create(client, { title: "Pending" });
    const first = create(client, { title: "First" });
    const second = create(client, { title: "Second" });
    const third = create(client, { title: "Third" });
    const readBefore = overlaysOf(client).now();
    first.reply.resolve({ id: "t1" });
    second.reply.resolve({ id: "t2" });
    third.reply.resolve({ id: "t3" });
    await Promise.all([first.done, second.done, third.done]);
    const ids = () => scopeOf(client)().map((added) => added.item.id);
    // A read sent before the replies says nothing about them; one that holds nothing of them neither.
    settle({ holds: holds([]), readAt: readBefore });
    expect(ids()).toEqual([expect.stringMatching(/^qd:new:/), "t1", "t2", "t3"]);
    settle({ holds: holds(["t1"]) });
    expect(ids()).toEqual([expect.stringMatching(/^qd:new:/), "t2", "t3"]);
    // A delta named it: added and removed again in one frame, say.
    settle({ holds: holds([]), named: new Set(["t2"]) });
    expect(ids()).toEqual([expect.stringMatching(/^qd:new:/), "t3"]);
    // A load sent after the reply answered without it: not a member.
    settle({ holds: holds([]), readAt: overlaysOf(client).now() });
    // The call in flight stays whatever the scope says.
    expect(scopeOf(client)()).toEqual([
      { item: { id: expect.stringMatching(/^qd:new:/), title: "Pending" }, pending: true },
    ]);
    pending.reply.reject(new QuickdrawError("INTERNAL", "Dropped"));
    await expect(pending.done).rejects.toThrow("Dropped");
  });

  it("is dropped 10 s after its reply when nothing ended it, and on a reset", async () => {
    vi.useFakeTimers();
    try {
      const client = new QueryClient();
      const { reply, done } = create(client, { title: "Draft" });
      reply.resolve({ id: "t9" });
      await done;
      vi.advanceTimersByTime(9_999);
      expect(scopeOf(client)()).toHaveLength(1);
      vi.advanceTimersByTime(1);
      expect(scopeOf(client)()).toEqual([]);
      create(client, { title: "Again" });
      resetOverlays(client);
      expect(scopeOf(client)()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps an id the update gives, and refuses a scope or an id it cannot show", async () => {
    const client = new QueryClient();
    create(client, { id: "client-made", title: "Draft" });
    expect(scopeOf(client)()[0]?.item.id).toBe("client-made");
    const refused = (update: Parameters<typeof mutateOptimistically>[2]) =>
      mutateOptimistically(client, board, update, {}, () => Promise.resolve(null));
    await expect(
      refused((_input, cache) => cache.addItem("board", "", { title: "x" })),
    ).rejects.toThrow("addItem: the scope must be the scope's value, a non-empty string");
    await expect(
      refused((_input, cache) => cache.addItem("board", "p1", { id: "", title: "x" })),
    ).rejects.toThrow("addItem: an item's id must be a non-empty string, or left out");
  });

  it("with addEntity, joins every collection of entity rows whose scope column and where the row matches", () => {
    const client = new QueryClient();
    const target = {
      service: "taskService",
      entityOutput: false,
      collections: {
        byProject: { scope: "projectId", item: "entity", order: [["id", "asc"]] },
        open: {
          scope: "projectId",
          item: "entity",
          order: [["id", "asc"]],
          where: { status: "open" },
        },
        done: {
          scope: "projectId",
          item: "entity",
          order: [["id", "asc"]],
          where: { status: "done" },
        },
        cards: { scope: "projectId", item: "card", order: [["id", "asc"]] },
        mine: { scope: "assigneeId", item: "entity", order: [["id", "asc"]] },
      },
    } as const;
    void mutateOptimistically(
      client,
      target,
      (_input, cache) => cache.addEntity({ projectId: "p1", status: "open", assigneeId: null }),
      {},
      () => deferred<unknown>().promise,
    );
    const view = overlaysOf(client).view("taskService");
    const where = (collection: string, scope = "p1") => view.added(collection, scope).length;
    expect([
      where("byProject"),
      where("open"),
      where("done"),
      where("cards"),
      where("mine", ""),
    ]).toEqual([1, 1, 0, 0, 0]);
  });
});

describe("calls that open no layer", () => {
  it.each([
    ["optimistic: false", { id: "t1", title: "New" }, false, task],
    ["an input without an id", { title: "New" }, undefined, task],
    [
      "an output that is not the entity",
      { id: "t1", title: "New" },
      undefined,
      { ...task, entityOutput: false },
    ],
  ] as const)("%s sends at once and shows nothing", async (_label, input, optimistic, target) => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const listener = vi.fn();
    overlays.subscribe(listener);
    const result = await mutateOptimistically(
      client,
      target,
      optimistic,
      input,
      async () => "sent",
    );
    expect(result).toBe("sent");
    expect(overlays.applyOverlay("taskService", row)).toBe(row);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("the store", () => {
  it("is one per QueryClient, tells subscribers of changes, and keeps a view per service until it changes", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    expect(overlaysOf(client)).toBe(overlays);
    expect(overlaysOf(new QueryClient())).not.toBe(overlays);
    const listener = vi.fn();
    const stop = overlays.subscribe(listener);
    const tasks = overlays.view("taskService");
    const labels = overlays.view("labelService");
    expect(overlays.view("taskService")).toBe(tasks);
    const { reply, done } = send(client, { id: "t1", title: "New" });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(overlays.view("taskService")).not.toBe(tasks);
    expect(overlays.view("labelService")).toBe(labels);
    reply.resolve(null);
    await done;
    expect(listener).toHaveBeenCalledTimes(2);
    overlays.observe("taskService", "t1", 1);
    expect(listener).toHaveBeenCalledTimes(3);
    expect(overlays.view("taskService").apply(row)).toBe(row);
    stop();
    send(client, { id: "t1", title: "Again" });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("keeps at most 1,000 layers, dropping the oldest finished ones first", async () => {
    const client = new QueryClient();
    const overlays = overlaysOf(client);
    const finished = send(client, { id: "old", title: "Finished" });
    finished.reply.resolve(null);
    await finished.done;
    const pending = send(client, { id: "pending", title: "Pending" });
    for (let index = 0; index < 999; index += 1) {
      send(client, { id: `t${index}`, title: "Many" });
    }
    expect(overlays.applyOverlay("taskService", { id: "old", title: "Old" })).toEqual({
      id: "old",
      title: "Old",
    });
    expect(overlays.applyOverlay("taskService", { id: "pending", title: "Old" })).toEqual({
      id: "pending",
      title: "Pending",
    });
    void pending;
  });
});

describe("row shapes", () => {
  it("are read from a method's output", () => {
    expect(rowShapeOf("entity")).toBe("one");
    expect(rowShapeOf("card")).toBe("one");
    expect(rowShapeOf(nullable("entity"))).toBe("nullable");
    expect(rowShapeOf(listOf("card"))).toBe("list");
    expect(rowShapeOf(z.object({ kind: z.literal("list") }))).toBeUndefined();
    expect(rowShapeOf(undefined)).toBeUndefined();
  });
});
