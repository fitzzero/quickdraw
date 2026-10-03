"use client";

// `qd.<service>.<search>.useSearch(q, options)` (RFC 0003 section 12.2): the
// search kit's method, as the user types.
//
// - `q` is trimmed, and sent once it has stayed the same for `debounceMs`
//   (200 by default); a query shorter than the method's `minLength` sends
//   nothing and shows nothing.
// - The search is the method's own `useQuery` (`../hooks.ts`), keyed by
//   `{ q, scope?, limit? }`: TanStack's signal reaches the call, so when the
//   next query replaces one still on its way, that call is cancelled
//   (`qd:cancel`) and the server stops it.
// - While a newer search is on its way, the last results in the same scope
//   stay shown.
// - A search kept to a scope of its collection returns that collection's
//   items. While a `useCollection` holds the scope, they are kept in its
//   state and shown as it holds them, so the scope's deltas (another user
//   renaming a result) show in the results too (`searchResults.ts`). There
//   is no subscription of the search's own.

import { useQuery, type QueryKey } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { SearchPage } from "../../contract/kits/searchSchemas";
import { useMethodQuery } from "../hooks";
import { collectionKey } from "../keys";
import type { CollectionEntry } from "./collectionLoads";
import { entryQuery } from "./host";
import { useLiveData, useOverlayView } from "./liveHooks";
import { searchCall, shownResults, type SearchCall, type SearchTarget } from "./searchResults";
import type { UseSearchOptions, UseSearchResult } from "./searchTypes";

type LiveData = ReturnType<typeof useLiveData>["live"];

/** How long typing must pause before `useSearch` sends a query, by default. */
export const SEARCH_DEBOUNCE_MS = 200;

/** `value` once it has stayed the same for `delayMs`; the first value at once. */
function useDebounced(value: string, delayMs: number): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    if (settled === value) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setSettled(value);
    }, delayMs);
    return () => {
      clearTimeout(timer);
    };
  }, [value, delayMs, settled]);
  return settled;
}

/** The scope a search's cache key holds, or `""`. */
function scopeOfKey(queryKey: QueryKey | undefined): string {
  const input = queryKey?.[4] as SearchCall | undefined;
  return typeof input?.scope === "string" ? input.scope : "";
}

/** TanStack's `placeholderData`: the last results while a newer search loads, in the same scope only. */
function sameScopeResults(scope: string) {
  return <Page>(
    previous: Page | undefined,
    previousQuery?: { readonly queryKey: QueryKey },
  ): Page | undefined => (scopeOfKey(previousQuery?.queryKey) === scope ? previous : undefined);
}

/**
 * The state of the scope the results are items of, while a hook holds it;
 * `null` otherwise. Observing the entry renders the search again when the
 * scope's deltas change it.
 */
function useHeldScope(live: LiveData, target: SearchTarget, scope: string) {
  const collection = target.collection ?? "";
  const key = collectionKey(target.service, collection, collection === "" ? "" : scope);
  const { data: entry } = useQuery(entryQuery<CollectionEntry>(key));
  const held =
    collection !== "" && scope !== "" && live.collections.holds(target.service, collection, scope);
  return held ? (entry?.state ?? null) : null;
}

/** `qd.<service>.<search>.useSearch(q, options)`. */
export function useSearch<Item>(
  target: SearchTarget,
  q: string,
  options: UseSearchOptions = {},
): UseSearchResult<Item> {
  const { queryClient, live } = useLiveData(`${target.service}.${target.method}.useSearch`);
  const typed = typeof q === "string" ? q.trim() : "";
  const debounced = useDebounced(typed, options.debounceMs ?? SEARCH_DEBOUNCE_MS);
  const scope = typeof options.scope === "string" ? options.scope : "";
  const wanted = options.enabled !== false && typed.length >= target.minLength;
  const active = wanted && debounced.length >= target.minLength;
  const { limit } = options;
  const input = useMemo(() => searchCall(debounced, scope, limit), [debounced, scope, limit]);
  const placeholderData = useMemo(() => sameScopeResults(scope), [scope]);
  const result = useMethodQuery<SearchPage<Item>, SearchPage<Item>, SearchCall>(target, input, {
    enabled: active,
    placeholderData,
  });
  const page = active ? result.data : undefined;
  const fresh = result.isPlaceholderData ? undefined : page;
  const state = useHeldScope(live, target, scope);
  const loaded = state !== null;
  useEffect(() => {
    if (fresh?.rev !== undefined && loaded && target.collection !== undefined) {
      live.collections.keep(target.service, target.collection, scope, fresh.items, fresh.rev);
    }
  }, [live, target, scope, fresh, loaded]);
  const view = useOverlayView(queryClient, target.service);
  const items = useMemo(
    () => shownResults(page, state, view, target.collection),
    [page, state, view, target.collection],
  );
  const isSearching = wanted && (debounced !== typed || result.isFetching);
  const hasMore = (page?.nextCursor ?? null) !== null;
  const error = active ? result.error : null;
  return useMemo(
    () => ({ items, hasMore, isSearching, isLoading: isSearching && page === undefined, error }),
    [items, hasMore, isSearching, page, error],
  );
}
