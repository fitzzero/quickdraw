// The checks live collections run on their own (RFC 0003 section 11.5): a
// resume when the page shows again after 30 s hidden, and one every 5
// minutes give or take 20%, while a scope is held. Runs under jsdom for the
// page's visibility; without a DOM only the timer runs (`live.test.ts`).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeConnection, testQueryClient } from "./__tests__/fakeSocket";
import type { CollectionTarget } from "./collectionLoads";
import { liveDataOf } from "./liveData";
import { IDLE_CHECK_MS, VISIBLE_AFTER_MS } from "./resume";

const target: CollectionTarget = {
  service: "chatService",
  collection: "byChat",
  def: { scope: "chatId", item: "entity", order: [["id", "asc"]] },
};

let visibility: DocumentVisibilityState = "visible";

function setVisibility(state: DocumentVisibilityState): void {
  visibility = state;
  document.dispatchEvent(new Event("visibilitychange"));
}

/** A held scope, loaded at revision 100. */
function heldScope() {
  const fake = fakeConnection();
  const live = liveDataOf(fake.connection, testQueryClient());
  const holding = live.collections.subscribe(target, "chat-1");
  fake.answer("qd:col:sub", 0, {
    ok: true,
    rev: 100,
    items: [],
    total: 0,
    cursor: null,
    limit: 100,
  });
  const resumes = (): unknown[] =>
    fake
      .sent("qd:col:sub")
      .slice(1)
      .map((sent) => sent.frame);
  return { fake, holding, resumes };
}

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("the visibility check", () => {
  it("resumes every held scope when the page shows again after 30 s hidden", () => {
    const { resumes } = heldScope();
    setVisibility("hidden");
    vi.advanceTimersByTime(VISIBLE_AFTER_MS + 1000);
    setVisibility("visible");
    expect(resumes()).toEqual([{ s: "chatService", c: "byChat", scope: "chat-1", since: 100 }]);
  });

  it("does nothing after a shorter absence", () => {
    const { resumes } = heldScope();
    setVisibility("hidden");
    vi.advanceTimersByTime(VISIBLE_AFTER_MS - 1000);
    setVisibility("visible");
    expect(resumes()).toEqual([]);
  });

  it("stops listening once no scope is held", () => {
    const { holding, resumes } = heldScope();
    holding.release();
    vi.advanceTimersByTime(1);
    setVisibility("hidden");
    vi.advanceTimersByTime(VISIBLE_AFTER_MS + 1000);
    setVisibility("visible");
    expect(resumes()).toEqual([]);
  });
});

describe("the idle check", () => {
  it("resumes every held scope every 5 minutes, give or take 20%", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { fake, resumes } = heldScope();
    vi.advanceTimersByTime(IDLE_CHECK_MS * 0.8 - 1);
    expect(resumes()).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(resumes()).toHaveLength(1);
    fake.answer("qd:col:sub", 1, { ok: true, resumed: true, rev: 100, deltas: [] });
    vi.advanceTimersByTime(IDLE_CHECK_MS * 0.8);
    expect(resumes()).toHaveLength(2);
  });

  it("waits at most 6 minutes", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.999_999);
    const { resumes } = heldScope();
    vi.advanceTimersByTime(IDLE_CHECK_MS * 1.2 - 10);
    expect(resumes()).toEqual([]);
    vi.advanceTimersByTime(10);
    expect(resumes()).toHaveLength(1);
  });

  it("skips a scope whose load is still in flight", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const { resumes } = heldScope();
    vi.advanceTimersByTime(IDLE_CHECK_MS * 0.8);
    vi.advanceTimersByTime(IDLE_CHECK_MS * 0.8);
    expect(resumes()).toHaveLength(1);
  });
});
