// The live data's cache in a TanStack `QueryClient` (RFC 0003 sections 6, 7
// and 11.5): the `LiveCache` (`host.ts`) of the live data the hooks read
// (`liveData.ts`). Each entry is a query under its key, so the hooks read it
// as they read any query, and app code and devtools see it. Entries are
// written without TanStack's structural sharing: the stores write them
// whole, and already keep every unchanged object. A hook observes its entry
// with a query that never fetches (`entryQuery`, `liveHooks.ts`), which also
// keeps TanStack from collecting the entry while it is shown; an entry
// nobody shows any more is collected after `gcTime`, as any query is, so
// `release` does nothing here.
//
// React-free.

import type { QueryClient } from "@tanstack/react-query";
import type { LiveCache, LiveKey } from "./host";

/** The live data's cache in `queryClient`. */
export function queryCacheOf(queryClient: QueryClient): LiveCache {
  return Object.freeze({
    get: (key: LiveKey): unknown => queryClient.getQueryData(key),
    set(key: LiveKey, value: unknown): void {
      const options = queryClient.defaultQueryOptions({ queryKey: key, structuralSharing: false });
      queryClient.getQueryCache().build(queryClient, options).setData(value, { manual: true });
    },
    // TanStack collects the entry after `gcTime` once no hook observes it.
    release: () => undefined,
  });
}
