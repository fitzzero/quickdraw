// The two caches the live stores run over (RFC 0003 section 11.5): a
// TanStack `QueryClient`'s, which the hooks read (`liveDataOf`,
// `../queryCache.ts`), and a script's live store's (`liveStoreOf`,
// `../memoryCache.ts`). The store suites run over both (`describe.each`),
// and read the entries through this.

import { QueryClient } from "@tanstack/react-query";
import type { QuickdrawConnection } from "../../connection";
import type { LiveKey } from "../host";
import { liveDataOf } from "../liveData";
import { liveCacheOf, liveStoreOf, type LiveStore } from "../liveStore";
import type { LiveData } from "../stores";

/** One cache, and the live data of one connection over it. */
export interface TestCache {
  /** The live data of `connection` over this cache, made on first use. */
  open(connection: QuickdrawConnection): LiveData;
  /** The entry under `key`, or `undefined`. */
  entry<T>(key: LiveKey): T | undefined;
  /** Removes the entry under `key` behind the stores' back. */
  drop(key: LiveKey): void;
}

/** A kind of cache: `make` returns a new one. */
export interface CacheKind {
  readonly name: string;
  /** A new cache; `gcTime` sets a `QueryClient`'s (a live store collects nothing by time). */
  make(options?: { readonly gcTime?: number }): TestCache;
}

/** The cache of `queryClient`. */
export function queryClientCache(queryClient: QueryClient): TestCache {
  return {
    open: (connection) => liveDataOf(connection, queryClient),
    entry: <T>(key: LiveKey) => queryClient.getQueryData<T>(key),
    drop(key) {
      queryClient.removeQueries({ queryKey: key, exact: true });
    },
  };
}

/** The cache of the live store of the connection it opens (one per connection). */
export function liveStoreCache(): TestCache {
  let store: LiveStore | undefined;
  const cache = () => {
    if (store === undefined) {
      throw new Error("open the live store first");
    }
    return liveCacheOf(store);
  };
  return {
    open(connection) {
      store = liveStoreOf(connection);
      return store;
    },
    entry: <T>(key: LiveKey) => cache().get(key) as T | undefined,
    drop(key) {
      cache().release(key);
    },
  };
}

export const CACHES: readonly CacheKind[] = [
  {
    name: "a QueryClient",
    make: (options = {}) =>
      queryClientCache(
        new QueryClient({
          defaultOptions: {
            queries: { retry: false, ...(options.gcTime === undefined ? {} : options) },
          },
        }),
      ),
  },
  { name: "a live store", make: () => liveStoreCache() },
];
