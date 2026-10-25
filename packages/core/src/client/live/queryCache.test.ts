// How long the live data's entries stay in a `QueryClient` (RFC 0003
// sections 6, 7 and 11.5): as long as the stores hold their row or scope,
// with or without a hook to show it, and `gcTime` after neither does. Over a
// socket the test drives, with fake timers. A `QueryClient` in Node collects
// nothing unless told to (its `gcTime` is infinite on a server), so these
// give it a `gcTime` of a minute (a browser's and React Native's is five),
// short of the collections' idle check, which runs every 4 to 6 minutes.

import { QueryClient, QueryObserver, type QueryKey } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { collectionKey, entityKey } from "../keys";
import { fakeConnection, fakeHello } from "./__tests__/fakeSocket";
import type { CollectionEntry, CollectionTarget } from "./collectionLoads";
import { loadedIds } from "./collectionStore";
import type { EntityEntry } from "./entities";
import { liveDataOf } from "./liveData";
import { entryQuery } from "./queryCache";

const GC_TIME = 60_000;
const SCOPE = "chat-1";
const SCOPE_KEY = collectionKey("chatService", "byChat", SCOPE);
const ROW_KEY = entityKey("chatService", "m1");

const target: CollectionTarget = {
  service: "chatService",
  collection: "byChat",
  def: { scope: "chatId", item: "entity", order: [["id", "asc"]] },
};

function setup() {
  const fake = fakeConnection();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: GC_TIME } },
  });
  const live = liveDataOf(fake.connection, queryClient);
  const scope = () => queryClient.getQueryData<CollectionEntry>(SCOPE_KEY);
  const items = (): string[] | undefined => {
    const state = scope()?.state;
    return state === null || state === undefined ? undefined : loadedIds(state);
  };
  const row = () => queryClient.getQueryData<EntityEntry<{ readonly text: string }>>(ROW_KEY);
  const query = (key: QueryKey) => queryClient.getQueryCache().find({ queryKey: key, exact: true });
  return { fake, queryClient, live, scope, items, row, query };
}

type Setup = ReturnType<typeof setup>;

/** Runs the batched sends (a microtask) and the registry's closes (a tick). */
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(1);
}

async function pastGcTime(): Promise<void> {
  await vi.advanceTimersByTimeAsync(GC_TIME + 1);
}

function snapshot(ids: readonly string[], rev = 100) {
  const items = ids.map((id) => ({ id, text: id }));
  return { ok: true, rev, items, total: ids.length, cursor: null, limit: 100 };
}

function added(rev: number, id: string) {
  return {
    s: "chatService",
    c: "byChat",
    scope: SCOPE,
    rev,
    deltas: [{ t: "added", item: { id, text: id } }],
  };
}

/** Holds the scope with no hook, and answers its load (the `index`th `qd:col:sub`) with a and b. */
function holdScope(t: Setup, index = 0) {
  const holding = t.live.collections.subscribe(target, SCOPE);
  t.fake.answer("qd:col:sub", index, snapshot(["a", "b"]));
  return holding;
}

/** Holds row m1 with no hook, and answers its subscription (the `index`th `qd:sub`). */
async function holdRow(t: Setup, index = 0) {
  const release = t.live.entities.subscribe("chatService", ["m1"]);
  await settle();
  t.fake.answer("qd:sub", index, { ok: true, r: [{ ok: true, rev: 100, d: { text: "Hello" } }] });
  return release;
}

/** What a live hook's `useQuery(entryQuery(key))` makes: an observer of the entry; returns its unmount. */
function mountHook(t: Setup, key: QueryKey): () => void {
  return new QueryObserver(t.queryClient, entryQuery(key)).subscribe(() => undefined);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a row or scope held without a hook", () => {
  it("keeps a scope's state past gcTime, and applies the next delta to it without loading it again", async () => {
    const t = setup();
    holdScope(t);
    await pastGcTime();
    expect(t.items()).toEqual(["a", "b"]);

    t.fake.deliver("qd:c", added(200, "c"));
    expect(t.items()).toEqual(["a", "b", "c"]);
    expect(t.fake.sent("qd:col:sub")).toHaveLength(1);
  });

  it("keeps a row past gcTime, and applies the next patch to it without asking for it again", async () => {
    const t = setup();
    await holdRow(t);
    await pastGcTime();
    expect(t.row()?.data).toEqual({ text: "Hello" });

    t.fake.deliver("qd:e", { t: "p", s: "chatService", id: "m1", rev: 200, d: { text: "Edited" } });
    await settle();
    expect(t.row()?.data).toEqual({ text: "Edited" });
    expect(t.fake.sent("qd:sub")).toHaveLength(1);
  });

  it("keeps a row held again while its entry is cached, though the answer writes nothing", async () => {
    const t = setup();
    const release = await holdRow(t);
    release();
    await settle();
    await vi.advanceTimersByTimeAsync(GC_TIME / 2);
    t.live.entities.subscribe("chatService", ["m1"]);
    await settle();
    expect(t.fake.sent("qd:sub")[1]?.frame).toEqual({ s: "chatService", ids: ["m1"], revs: [100] });
    t.fake.answer("qd:sub", 1, { ok: true, r: [{ ok: true, rev: 100, nm: true }] });

    // Past the gcTime its release started, and past one more.
    await pastGcTime();
    expect(t.row()?.data).toEqual({ text: "Hello" });
    expect(t.fake.sent("qd:sub")).toHaveLength(2);
  });

  it("lets the entry go gcTime after the stores let the row or scope go", async () => {
    const t = setup();
    const holding = holdScope(t);
    const release = await holdRow(t);
    holding.release();
    release();
    await settle();
    await vi.advanceTimersByTimeAsync(GC_TIME - 10);
    expect(t.items()).toEqual(["a", "b"]);
    expect(t.row()?.data).toEqual({ text: "Hello" });

    await vi.advanceTimersByTimeAsync(20);
    expect(t.query(SCOPE_KEY)).toBeUndefined();
    expect(t.query(ROW_KEY)).toBeUndefined();
  });

  it("keeps an entry a hook shows once the stores let it go, until the hook lets it go too", async () => {
    const t = setup();
    const holding = holdScope(t);
    // A hook that leaves while the stores hold the scope leaves the entry held.
    mountHook(t, SCOPE_KEY)();
    await pastGcTime();
    expect(t.items()).toEqual(["a", "b"]);

    const unmount = mountHook(t, SCOPE_KEY);
    holding.release();
    await settle();
    await pastGcTime();
    expect(t.items()).toEqual(["a", "b"]);
    expect(t.query(SCOPE_KEY)?.getObserversCount()).toBe(1);

    unmount();
    await pastGcTime();
    expect(t.query(SCOPE_KEY)).toBeUndefined();
  });
});

describe("held entries the cache loses", () => {
  it("are emptied by another user's hello, stay removed, and the next user's are held", async () => {
    const t = setup();
    holdScope(t);
    await holdRow(t);
    const ada = { scope: t.query(SCOPE_KEY), row: t.query(ROW_KEY) };

    t.fake.setState({ hello: null });
    t.fake.setState({ hello: fakeHello("u2") });
    // `forget` wrote each held entry empty, into a query of its own.
    expect(t.scope()?.state).toBeNull();
    expect(t.row()?.data).toBeUndefined();
    expect(t.query(SCOPE_KEY)).not.toBe(ada.scope);
    expect(t.query(ROW_KEY)).not.toBe(ada.row);
    expect(ada.scope?.getObserversCount()).toBe(0);
    expect(ada.row?.getObserversCount()).toBe(0);

    t.fake.answer("qd:col:sub", 1, snapshot(["c"]));
    await settle();
    t.fake.answer("qd:sub", 1, { ok: true, r: [{ ok: true, rev: 300, d: { text: "Theirs" } }] });
    await pastGcTime();
    expect(t.items()).toEqual(["c"]);
    expect(t.row()?.data).toEqual({ text: "Theirs" });
    expect(t.queryClient.getQueryCache().getAll()).not.toContain(ada.scope);
    expect(t.queryClient.getQueryCache().getAll()).not.toContain(ada.row);
  });

  it("stay removed when the app removes them, until the stores write them again, and are held then", async () => {
    const t = setup();
    await holdRow(t);
    t.queryClient.removeQueries({ queryKey: ROW_KEY });
    await pastGcTime();
    expect(t.query(ROW_KEY)).toBeUndefined();

    // The store reads the row, finds none, and asks for it: still nothing is cached.
    t.fake.deliver("qd:e", { t: "p", s: "chatService", id: "m1", rev: 200, d: { text: "Edited" } });
    await settle();
    expect(t.fake.sent("qd:sub")[1]?.frame).toEqual({ s: "chatService", ids: ["m1"] });
    expect(t.query(ROW_KEY)).toBeUndefined();
    t.fake.answer("qd:sub", 1, { ok: true, r: [{ ok: true, rev: 200, d: { text: "Edited" } }] });
    await pastGcTime();
    expect(t.row()?.data).toEqual({ text: "Edited" });
    expect(t.query(ROW_KEY)?.getObserversCount()).toBe(1);
  });
});
