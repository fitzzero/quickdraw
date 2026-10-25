// The live store's cache (RFC 0003 section 11.5, `memoryCache.ts`): what it
// keeps and whom it tells. The store suites run over it as well
// (`__tests__/caches.ts`), but they cannot see everything it promises: after
// `clear()`, the stores' `forget()` writes every held key again, which tells
// its listeners whether or not `clear()` did. So `clear()` telling the
// listeners of each entry it removes is pinned here.

import { describe, expect, it, vi } from "vitest";
import { collectionKey, entityKey } from "../keys";
import { createMemoryCache } from "./memoryCache";

const row = entityKey("chatService", "m1");
const other = entityKey("chatService", "m2");
const scope = collectionKey("chatService", "byChat", "c1");

describe("the memory cache", () => {
  it("keeps an entry by the value of its key until it is released; holding keeps nothing more", () => {
    const cache = createMemoryCache();
    cache.hold(row);
    expect(cache.get(row)).toBeUndefined();
    cache.set(row, { v: 1 });
    expect(cache.get(entityKey("chatService", "m1"))).toEqual({ v: 1 });
    expect(cache.get(other)).toBeUndefined();
    cache.release(row);
    expect(cache.get(row)).toBeUndefined();
  });

  it("tells a key's listeners when its entry is set or released, and nobody for a key it has no entry of", () => {
    const cache = createMemoryCache();
    const heardRow = vi.fn();
    const heardOther = vi.fn();
    const stop = cache.listen(row, heardRow);
    cache.listen(other, heardOther);
    cache.set(row, { v: 1 });
    expect(heardRow).toHaveBeenCalledTimes(1);
    cache.release(row);
    expect(heardRow).toHaveBeenCalledTimes(2);
    cache.release(other);
    expect(heardOther).not.toHaveBeenCalled();
    stop();
    cache.set(row, { v: 2 });
    expect(heardRow).toHaveBeenCalledTimes(2);
  });

  it("clear() removes every entry and tells each one's listeners once, after it is gone", () => {
    const cache = createMemoryCache();
    const seen: unknown[] = [];
    const heardScope = vi.fn();
    const heardOther = vi.fn();
    cache.listen(row, () => seen.push(cache.get(row)));
    cache.listen(scope, heardScope);
    cache.listen(other, heardOther);
    cache.set(row, { v: 1 });
    cache.set(scope, { state: null });
    heardScope.mockClear();

    cache.clear();
    expect(cache.get(row)).toBeUndefined();
    expect(cache.get(scope)).toBeUndefined();
    expect(seen).toEqual([{ v: 1 }, undefined]);
    expect(heardScope).toHaveBeenCalledTimes(1);
    // No entry under it: nothing to tell.
    expect(heardOther).not.toHaveBeenCalled();
    cache.clear();
    expect(heardScope).toHaveBeenCalledTimes(1);
  });
});
