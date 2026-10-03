// What the live stores leave running (RFC 0003 sections 6, 7 and 11.5): no
// timer once their connection closes, or once the hooks that held their rows
// and scopes are gone. Over a socket the test drives, with fake timers.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeConnection, testQueryClient } from "./__tests__/fakeSocket";
import type { CollectionTarget } from "./collectionLoads";
import { liveDataOf } from "./liveData";

const target: CollectionTarget = {
  service: "chatService",
  collection: "byChat",
  def: { scope: "chatId", item: "entity", order: [["id", "asc"]] },
};

function setup() {
  const fake = fakeConnection();
  const live = liveDataOf(fake.connection, testQueryClient());
  return { fake, live };
}

/** Lets microtasks (a store's batched sends) run. */
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

/** A held row whose subscribe got no answer: the store waits 5 s to ask again. */
async function retryingRow() {
  const { fake, live } = setup();
  const release = live.entities.subscribe("chatService", ["m1"]);
  await flush();
  fake.fail("qd:sub", 0);
  expect(vi.getTimerCount()).toBe(1);
  return { fake, live, release };
}

/** A held scope with a reset reload, a page and an items request waiting to be asked for again. */
async function waitingScope() {
  const { fake, live } = setup();
  const holding = live.collections.subscribe(target, "chat-1");
  fake.answer("qd:col:sub", 0, {
    ok: true,
    rev: 100,
    items: [{ id: "a" }],
    total: 3,
    cursor: "1",
    limit: 100,
  });
  const more = holding.controller.loadMore();
  fake.fail("qd:col:sub", 1);
  const items = holding.controller.loadItems(["c"]);
  await flush();
  fake.fail("qd:col:items", 0);
  fake.deliver("qd:c", {
    s: "chatService",
    c: "byChat",
    scope: "chat-1",
    rev: 200,
    deltas: [{ t: "reset" }],
  });
  // The idle check, the page and items waits, and the reset's reload.
  expect(vi.getTimerCount()).toBe(4);
  return { fake, live, holding, more, items };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("live entities", () => {
  it("leave no timer once the connection closes", async () => {
    const { fake } = await retryingRow();
    fake.close();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("leave no timer once the last row is let go", async () => {
    const { release } = await retryingRow();
    release();
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("live collections", () => {
  it("leave no timer once the connection closes, and fail the items request that waited", async () => {
    const { fake, more, items } = await waitingScope();
    fake.close();
    expect(vi.getTimerCount()).toBe(0);
    await expect(more).resolves.toBeUndefined();
    await expect(items).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("leave no timer once the last holder lets the scope go", async () => {
    const { holding, more, items } = await waitingScope();
    holding.release();
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.getTimerCount()).toBe(0);
    await expect(more).resolves.toBeUndefined();
    await expect(items).resolves.toBeUndefined();
  });

  it("start their checks again when the connection opens again", async () => {
    const { fake, items } = await waitingScope();
    fake.close();
    await expect(items).rejects.toMatchObject({ code: "INTERNAL" });
    expect(vi.getTimerCount()).toBe(0);
    fake.setState({ status: "connected" });
    fake.reconnect();
    expect(fake.sent("qd:col:sub").at(-1)?.frame).toMatchObject({ since: 100 });
    expect(vi.getTimerCount()).toBe(1);
  });
});
