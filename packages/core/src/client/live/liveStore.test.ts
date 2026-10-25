// A script's live store (RFC 0003 section 11.5) over a socket the test
// drives: one store per connection, what its cache keeps and for how long,
// what the cache session does to it, and when the holdings call their
// listeners. The store suites run over it as well as over a QueryClient
// (`__tests__/caches.ts`), and `test/client-core/liveStore.test.ts` runs it
// against a real server with React and TanStack refused.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract } from "../../contract/defineContract";
import { tick } from "../../server/__tests__/fixtures";
import { collectionKey, entityKey } from "../keys";
import { fakeConnection, fakeHello, testQueryClient } from "./__tests__/fakeSocket";
import { holdCollection } from "./holdCollection";
import { holdEntity } from "./holdEntity";
import type { CollectionSnapshot, EntitySnapshot, StreamSnapshot } from "./holding";
import { holdStream } from "./holdStream";
import { liveDataOf } from "./liveData";
import { liveCacheOf, liveStoreOf } from "./liveStore";

const chat = defineContract("chatService", {
  entity: z.object({ id: z.string(), chatId: z.string(), v: z.number(), owner: z.string() }),
  collections: {
    byChat: { scope: "chatId", item: "entity", order: [["id", "asc"]] },
    board: {
      scope: "chatId",
      item: "entity",
      order: [
        ["v", "asc"],
        ["id", "asc"],
      ],
      index: ["v", "owner"],
      views: { mine: (row, who) => row.owner === who.userId },
    },
  },
  streams: {
    ticker: { item: z.object({ n: z.number() }), scope: "room", access: "authenticated" },
    news: { item: z.string(), access: "public" },
  },
});

/** No entity, and a stream the host of each world's room serves. */
const game = defineContract("gameService", {
  streams: {
    world: {
      item: z.number(),
      scope: "worldId",
      access: { room: (worldId) => `world:${worldId}` },
      serve: "host",
    },
  },
});

type Message = z.infer<typeof chat.entity>;

const message = (id: string, v = 0, owner = "u1"): Message => ({ id, chatId: "c1", v, owner });

function snapshot(items: readonly Message[], rev = 100, cursor: string | null = null) {
  return {
    ok: true,
    rev,
    items,
    total: items.length + (cursor === null ? 0 : 1),
    cursor,
    limit: 100,
  };
}

function frame(rev: number, deltas: readonly unknown[], collection = "byChat") {
  return { s: "chatService", c: collection, scope: "c1", rev, deltas };
}

const rowReply = (row: Message, rev = 100) => ({ ok: true, r: [{ ok: true, rev, d: row }] });

/** Lets microtasks run: a store's batched sends, the holdings' listeners. */
async function flush(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await Promise.resolve();
  }
}

function setup() {
  const fake = fakeConnection();
  const live = liveStoreOf(fake.connection);
  return { fake, live, cache: liveCacheOf(live) };
}

/** A held row `m1` and scope `c1` of `byChat`, both loaded. */
async function loaded() {
  const t = setup();
  const scope = holdCollection(
    t.live,
    { contract: chat, collection: "byChat", scope: "c1" },
    () => undefined,
  );
  const row = holdEntity(t.live, { contract: chat, id: "m1" }, () => undefined);
  t.fake.answer("qd:col:sub", 0, snapshot([message("m1")]));
  await flush();
  t.fake.answer("qd:sub", 0, rowReply(message("m1")));
  await flush();
  const rowKey = entityKey("chatService", "m1");
  const scopeKey = collectionKey("chatService", "byChat", "c1");
  expect(t.cache.get(rowKey)).toMatchObject({ data: message("m1") });
  expect(scope.current().items).toEqual([message("m1")]);
  return { ...t, scope, row, rowKey, scopeKey };
}

describe("liveStoreOf", () => {
  it("keeps one store per connection, with one listener per frame type", () => {
    const { fake, live } = setup();
    expect(liveStoreOf(fake.connection)).toBe(live);
    expect(live.connection).toBe(fake.connection);
    expect(fake.listenerCount("qd:c")).toBe(1);
    expect(fake.listenerCount("qd:e")).toBe(1);
    expect(fake.listenerCount("qd:stream")).toBe(1);
    expect(liveStoreOf(fakeConnection().connection)).not.toBe(live);
  });

  it("refuses a connection a QueryClient's live data follows, and the other way round", () => {
    const provided = fakeConnection();
    liveDataOf(provided.connection, testQueryClient());
    expect(() => liveStoreOf(provided.connection)).toThrow(
      /liveStoreOf: the live data of a QueryClient follows this connection/,
    );
    const { fake } = setup();
    expect(() => liveDataOf(fake.connection, testQueryClient())).toThrow(
      /liveDataOf: a live store \(liveStoreOf\) follows this connection/,
    );
    // Neither attached anything more to the socket.
    expect(provided.listenerCount("qd:c")).toBe(1);
    expect(fake.listenerCount("qd:c")).toBe(1);
  });
});

describe("the live store's cache", () => {
  it("keeps an entry while a holding holds it, and removes it a tick after the last one ends", async () => {
    const { fake, live, cache } = setup();
    const key = entityKey("chatService", "m1");
    const first = holdEntity(live, { contract: chat, id: "m1" }, () => undefined);
    const second = holdEntity(live, { contract: chat, id: "m1" }, () => undefined);
    await flush();
    expect(fake.sent("qd:sub")).toHaveLength(1);
    fake.answer("qd:sub", 0, rowReply(message("m1")));
    first.release();
    await tick(5);
    expect(cache.get(key)).toMatchObject({ data: message("m1") });

    second.release();
    expect(cache.get(key)).toBeDefined();
    await tick(5);
    expect(cache.get(key)).toBeUndefined();
    expect(fake.sent("qd:unsub")).toHaveLength(1);
  });

  it("removes a scope's entry a tick after its last holding ends", async () => {
    const { fake, live, cache } = setup();
    const key = collectionKey("chatService", "byChat", "c1");
    const scope = holdCollection(
      live,
      { contract: chat, collection: "byChat", scope: "c1" },
      () => undefined,
    );
    fake.answer("qd:col:sub", 0, snapshot([message("m1")]));
    expect(cache.get(key)).toBeDefined();
    scope.release();
    await tick(5);
    expect(cache.get(key)).toBeUndefined();
    expect(fake.sent("qd:col:unsub")).toHaveLength(1);
  });
});

describe("the live store's session", () => {
  it("another user's hello removes every entry, held or not, and the store loads what it holds for them", async () => {
    const { fake, cache, scope, rowKey, scopeKey } = await loaded();
    const unheld = entityKey("chatService", "gone");
    cache.set(unheld, { data: message("gone") });
    fake.setState({ hello: null });
    fake.setState({ hello: fakeHello("u2") });
    expect(cache.get(unheld)).toBeUndefined();
    // Held: emptied, and asked for again from scratch.
    expect(cache.get(rowKey)).toMatchObject({ data: undefined });
    expect(cache.get(scopeKey)).toMatchObject({ state: null, error: null });
    expect(scope.current()).toMatchObject({ items: [], isLoading: true });
    await flush();
    expect(fake.sent("qd:sub").at(-1)?.frame).toEqual({ s: "chatService", ids: ["m1"] });
    expect(fake.sent("qd:col:sub").at(-1)?.frame).toEqual({
      s: "chatService",
      c: "byChat",
      scope: "c1",
    });
  });

  it("a session the server ends removes every entry; a refusal INTERNAL keeps them", async () => {
    const ends = [
      (fake: ReturnType<typeof fakeConnection>): void => {
        fake.setState({ hello: null, status: "disconnected" });
        fake.deliver("disconnect", "io server disconnect");
      },
      (fake: ReturnType<typeof fakeConnection>): void => {
        fake.setState({ hello: null, status: "disconnected" });
        fake.deliver(
          "connect_error",
          Object.assign(new Error("Authentication failed"), { data: { code: "UNAUTHENTICATED" } }),
        );
      },
    ];
    for (const end of ends) {
      const { fake, cache, row, rowKey, scopeKey } = await loaded();
      const unheld = entityKey("chatService", "gone");
      cache.set(unheld, { data: message("gone") });
      end(fake);
      expect(cache.get(unheld)).toBeUndefined();
      expect(cache.get(scopeKey)).toMatchObject({ state: null, error: null });
      expect(cache.get(rowKey)).toMatchObject({ data: undefined });
      expect(row.current()).toMatchObject({ data: undefined, isLoading: true });
    }

    const { fake, cache, rowKey, scopeKey } = await loaded();
    fake.setState({ hello: null, status: "disconnected" });
    fake.deliver(
      "connect_error",
      Object.assign(new Error("Authentication unavailable"), { data: { code: "INTERNAL" } }),
    );
    fake.setState({ hello: fakeHello("u1"), status: "connected" });
    expect(cache.get(rowKey)).toMatchObject({ data: message("m1") });
    expect(cache.get(scopeKey)).toMatchObject({ state: expect.anything() });
  });

  it("holdings show nothing while new credentials await their hello, and the cache again for the same user", async () => {
    const { fake, live, cache, scope, row, rowKey } = await loaded();
    const seen: EntitySnapshot<Message>[] = [];
    const watched = holdEntity(live, { contract: chat, id: "m1" }, (shown) => {
      seen.push(shown);
    });
    const news = holdStream(live, { contract: chat, stream: "news" }, () => undefined);
    fake.answer("qd:stream:sub", 0, { ok: true, seed: ["first"] });
    await flush();
    expect(seen.at(-1)?.data).toEqual(message("m1"));
    expect(news.current()).toEqual({ items: ["first"], isLoading: false, error: null });
    // New credentials (`setAuth`): the hello clears until the server answers them.
    fake.setState({ hello: null });
    expect(row.current()).toEqual({
      data: undefined,
      isLoading: true,
      isRemoved: false,
      error: null,
    });
    expect(scope.current()).toMatchObject({ items: [], isLoading: true, totalCount: null });
    expect(news.current()).toEqual({ items: [], isLoading: true, error: null });
    await flush();
    expect(seen.at(-1)).toMatchObject({ data: undefined, isLoading: true });
    // Nothing was removed meanwhile.
    expect(cache.get(rowKey)).toMatchObject({ data: message("m1") });

    const subs = fake.sent("qd:sub").length;
    fake.setState({ hello: fakeHello("u1") });
    expect(row.current().data).toEqual(message("m1"));
    expect(scope.current().items).toEqual([message("m1")]);
    expect(news.current().items).toEqual(["first"]);
    await flush();
    expect(seen.at(-1)?.data).toEqual(message("m1"));
    // The same user: what is held is resumed with its revisions, not loaded from scratch.
    expect(
      fake
        .sent("qd:sub")
        .slice(subs)
        .map((sent) => sent.frame),
    ).toEqual([{ s: "chatService", ids: ["m1"], revs: [100] }]);
    watched.release();
  });
});

describe("the holdings' listeners", () => {
  it("are first called after hold* returns, then once a microtask with the latest snapshot", async () => {
    const { fake, live } = setup();
    const seen: CollectionSnapshot<Message, unknown>[] = [];
    const holders: unknown[] = [];
    const cards = holdCollection(
      live,
      { contract: chat, collection: "byChat", scope: "c1" },
      (scope) => {
        seen.push(scope);
        // Assigned by now: the first call comes after holdCollection returned.
        holders.push(cards);
      },
    );
    expect(seen).toEqual([]);
    await Promise.resolve();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ items: [], isLoading: true, error: null });
    expect(holders).toEqual([cards]);

    // Two changes in one turn: one call, with the latest.
    fake.answer("qd:col:sub", 0, snapshot([message("a")]));
    fake.deliver("qd:c", frame(200, [{ t: "added", item: message("b") }]));
    expect(seen).toHaveLength(1);
    await Promise.resolve();
    expect(seen).toHaveLength(2);
    expect(seen[1]?.items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(cards.current()).toBe(seen[1]);

    // A change that shows nothing new (a state change of the connection) calls nothing.
    fake.setState({ serviceAccess: {} });
    await flush();
    expect(seen).toHaveLength(2);
    expect(cards.current()).toBe(seen[1]);
  });

  it("may release the holding from its first call", async () => {
    const { fake, live } = setup();
    const calls: StreamSnapshot<string>[] = [];
    const news = holdStream(live, { contract: chat, stream: "news" }, (feed) => {
      calls.push(feed);
      news.release();
    });
    await flush();
    expect(calls).toHaveLength(1);
    fake.answer("qd:stream:sub", 0, { ok: true, seed: ["first"] });
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("are called no more once released, and current() keeps what it showed then", async () => {
    const { fake, live } = setup();
    const seen: CollectionSnapshot<Message, unknown>[] = [];
    const cards = holdCollection(
      live,
      { contract: chat, collection: "byChat", scope: "c1" },
      (scope) => {
        seen.push(scope);
      },
    );
    fake.answer("qd:col:sub", 0, snapshot([message("a")]));
    await flush();
    const shown = cards.current();
    expect(shown.items).toEqual([message("a")]);
    // A change queued before the release is not told after it.
    fake.deliver("qd:c", frame(200, [{ t: "added", item: message("b") }]));
    const told = seen.length;
    cards.release();
    cards.release();
    // Its actions do nothing now, though the store holds the scope a tick longer.
    void cards.refresh();
    void cards.loadItems(["z"]);
    void cards.loadMore();
    await tick(5);
    expect(seen).toHaveLength(told);
    expect(cards.current().items.map((item) => item.id)).toEqual(["a", "b"]);
    expect(fake.sent("qd:col:sub")).toHaveLength(1);
    expect(fake.sent("qd:col:items")).toEqual([]);
  });
});

describe("what the holdings show", () => {
  it("a collection's view selects the members for the connection's user", async () => {
    const { fake, live } = setup();
    const mine = holdCollection(
      live,
      { contract: chat, collection: "board", scope: "c1", view: "mine" },
      () => undefined,
    );
    fake.answer("qd:col:sub", 0, {
      ...snapshot([message("a", 1, "u1"), message("b", 2, "u2")]),
      index: [
        ["a", 100, 1, "u1"],
        ["b", 100, 2, "u2"],
      ],
    });
    await flush();
    expect(mine.current().items.map((item) => item.id)).toEqual(["a"]);
    expect(mine.current().index?.map((row) => row.id)).toEqual(["a"]);
    expect(mine.current().totalCount).toBe(2);
    fake.deliver("qd:c", frame(200, [{ t: "patched", id: "b", d: { owner: "u1" } }], "board"));
    await flush();
    expect(mine.current().items.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("a scope is asked for with its limit, and with load all every page of it", async () => {
    const limited = setup();
    holdCollection(
      limited.live,
      { contract: chat, collection: "byChat", scope: "c1", limit: 2 },
      () => undefined,
    );
    expect(limited.fake.sent("qd:col:sub")[0]?.frame).toMatchObject({ limit: 2 });
    const { fake, live } = setup();
    const all = holdCollection(
      live,
      { contract: chat, collection: "byChat", scope: "c1", load: "all" },
      () => undefined,
    );
    fake.answer("qd:col:sub", 0, snapshot([message("a")], 100, "1"));
    await tick();
    expect(fake.sent("qd:col:sub")[1]?.frame).toMatchObject({ cursor: "1" });
    fake.answer("qd:col:sub", 1, snapshot([message("b")], 100));
    await tick();
    expect(all.current().items.map((item) => item.id)).toEqual(["a", "b"]);
  });

  it("a host-served feed is asked of the host of its scope's room, never the server", async () => {
    const { fake, live } = setup();
    const world = holdStream(
      live,
      { contract: game, stream: "world", scope: "1" },
      () => undefined,
    );
    await flush();
    expect(fake.sent("qd:stream:sub")).toEqual([]);
    // No host serves world:1 yet.
    expect(world.current()).toEqual({ items: [], isLoading: true, error: null });
    world.release();
  });

  it("a feed shows its seed and what is pushed after it, the latest max of it", async () => {
    const { fake, live } = setup();
    const short = holdStream(
      live,
      { contract: chat, stream: "ticker", scope: "lobby", max: 2 },
      () => undefined,
    );
    const long = holdStream(
      live,
      { contract: chat, stream: "ticker", scope: "lobby", max: 4 },
      () => undefined,
    );
    expect(fake.sent("qd:stream:sub").map((sent) => sent.frame)).toEqual([
      { s: "chatService", stream: "ticker", scope: "lobby" },
    ]);
    expect(short.current()).toEqual({ items: [], isLoading: true, error: null });
    fake.answer("qd:stream:sub", 0, { ok: true, seed: [{ n: 1 }, { n: 2 }] });
    for (const n of [3, 4, 5]) {
      fake.deliver("qd:stream", ["chatService", "ticker", "lobby", { n }]);
    }
    expect(short.current().items).toEqual([{ n: 4 }, { n: 5 }]);
    expect(long.current().items).toEqual([{ n: 2 }, { n: 3 }, { n: 4 }, { n: 5 }]);
  });

  it("refuses what the contract does not declare, and a scope or id that is not a non-empty string", () => {
    const { live } = setup();
    const nothing = (): void => undefined;
    const loose = chat as unknown as Parameters<typeof holdStream>[1]["contract"];
    expect(() =>
      holdCollection(live, { contract: chat, collection: "byChat", scope: "" }, nothing),
    ).toThrow(new TypeError("holdCollection: scope must be a non-empty string"));
    expect(() =>
      holdCollection(live, { contract: loose, collection: "nope", scope: "c1" } as never, nothing),
    ).toThrow(new TypeError("holdCollection: chatService declares no collection nope"));
    expect(() => holdEntity(live, { contract: chat, id: "" }, nothing)).toThrow(
      new TypeError("holdEntity: id must be a non-empty string"),
    );
    expect(() => holdEntity(live, { contract: game, id: "m1" } as never, nothing)).toThrow(
      new TypeError("holdEntity: gameService declares no entity"),
    );
    expect(() => holdStream(live, { contract: chat, stream: "ticker" } as never, nothing)).toThrow(
      new TypeError("holdStream: ticker is a scoped stream: scope must be a non-empty string"),
    );
    expect(() =>
      holdStream(live, { contract: chat, stream: "news", scope: "lobby" } as never, nothing),
    ).toThrow(new TypeError("holdStream: news is a global stream: it takes no scope"));
    expect(() => holdStream(live, { contract: loose, stream: "nope" } as never, nothing)).toThrow(
      new TypeError("holdStream: chatService declares no stream nope"),
    );
    expect(() => liveCacheOf({} as never)).toThrow(TypeError);
  });
});
