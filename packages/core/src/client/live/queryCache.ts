// The live data's cache in a TanStack `QueryClient` (RFC 0003 sections 6, 7
// and 11.5): the `LiveCache` (`host.ts`) of the live data the hooks read
// (`liveData.ts`). Each entry is a query under its key, so the hooks read it
// as they read any query, and app code and devtools see it. Entries are
// written without TanStack's structural sharing: the stores write them
// whole, and already keep every unchanged object.
//
// TanStack collects a query `gcTime` after it is built or after its last
// observer leaves, if none observes it then, whoever wrote it. So the stores
// observe each entry they hold, from `hold` to `release`, with the query a
// hook observes its entry with (`entryQuery`): a row or scope held without a
// hook (by code that calls `liveDataOf`, in React Native say) keeps its
// entry for as long as it is held, as it does while a hook shows it. `hold`
// builds the entry's query when none is cached, as a hook's mount does.
// After `release`, TanStack collects the entry `gcTime` after no hook shows
// it any more. The stores' observer builds no query after `hold`: an entry
// removed meanwhile (the session's `removeQueries` when another user's hello
// arrives) stays removed until the stores write it again, and the observer
// then moves to the query that write built.
//
// React-free.

import { QueryObserver, hashKey, type QueryClient, type QueryKey } from "@tanstack/react-query";
import type { LiveCache, LiveKey } from "./host";

/**
 * What an entry is observed with, by a hook or by the stores holding it: a
 * query that is never fetched, never stale, never shared structurally, and
 * never shown with a placeholder.
 */
export interface EntryQueryOptions<T> {
  readonly queryKey: QueryKey;
  readonly queryFn: () => T | null;
  readonly enabled: false;
  readonly staleTime: number;
  readonly structuralSharing: false;
  readonly placeholderData: undefined;
}

/** The options of the query the entry under `queryKey` is observed with. */
export function entryQuery<T>(queryKey: QueryKey): EntryQueryOptions<T> {
  return {
    queryKey,
    // Never called: the query is disabled, and only the stores write the entry.
    queryFn: () => null,
    enabled: false,
    staleTime: Number.POSITIVE_INFINITY,
    structuralSharing: false,
    // Given, so no `placeholderData` default of the `QueryClient` applies (`keepPreviousData`,
    // say): TanStack would take the placeholder from the last entry this hook's observer showed,
    // another row's, another scope's or another user's, until the stores write this one.
    placeholderData: undefined,
  };
}

/** The observer the stores hold an entry with, and the function that ends it. */
interface Holder {
  readonly observer: QueryObserver<unknown>;
  readonly stop: () => void;
}

/** The live data's cache in `queryClient`. */
export function queryCacheOf(queryClient: QueryClient): LiveCache {
  // By `hashKey`, TanStack's default hash: the map's own, whatever the client hashes queries with.
  const holders = new Map<string, Holder>();
  return Object.freeze({
    get: (key: LiveKey): unknown => queryClient.getQueryData(key),
    set(key: LiveKey, value: unknown): void {
      const options = queryClient.defaultQueryOptions({ queryKey: key, structuralSharing: false });
      const query = queryClient.getQueryCache().build(queryClient, options);
      query.setData(value, { manual: true });
      const holder = holders.get(hashKey(key));
      if (holder !== undefined && holder.observer.getCurrentQuery() !== (query as unknown)) {
        // The query it observed was removed, and this write built the entry again.
        holder.observer.setOptions(entryQuery(key));
      }
    },
    hold(key: LiveKey): void {
      if (!holders.has(hashKey(key))) {
        const observer = new QueryObserver<unknown>(queryClient, entryQuery(key));
        holders.set(hashKey(key), { observer, stop: observer.subscribe(() => undefined) });
      }
    },
    release(key: LiveKey): void {
      holders.get(hashKey(key))?.stop();
      holders.delete(hashKey(key));
    },
  });
}
