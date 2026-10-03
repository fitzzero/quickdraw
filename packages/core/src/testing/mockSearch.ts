// The mock client's `useSearch` (`mockClient.ts`), on the member of a method
// the search kit made: the method's stub answers each query at once, with no
// debounce, server or collection cache, so a component test sets the results
// it shows with `mockResolvedValue({ items, nextCursor })` and reads what was
// searched for in `calls`.

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { methodKey } from "../client/keys";
import { searchCall, searchTargetOf, type SearchTarget } from "../client/live/searchResults";
import type { UseSearchOptions, UseSearchResult } from "../client/live/searchTypes";
import type { MethodTarget } from "../client/members";
import type { AnyContract } from "../contract/defineContract";
import type { SearchPage } from "../contract/kits/searchSchemas";
import type { MethodDef } from "../contract/methods";
import type { QuickdrawError } from "../protocol/errors";

/** Answers one call of the stubbed method. */
type Invoke = (input: unknown) => Promise<unknown>;

const NO_RESULTS: readonly never[] = Object.freeze([]);

function useMockSearch(
  queryClient: QueryClient,
  invoke: Invoke,
  target: SearchTarget,
  q: string,
  options: UseSearchOptions,
): UseSearchResult<unknown> {
  const typed = typeof q === "string" ? q.trim() : "";
  const scope = typeof options.scope === "string" ? options.scope : "";
  const input = searchCall(typed, scope, options.limit);
  const active = options.enabled !== false && typed.length >= target.minLength;
  const result = useQuery(
    {
      queryKey: methodKey(target.service, target.method, input),
      queryFn: () => invoke(input) as Promise<SearchPage<unknown>>,
      enabled: active,
      retry: false,
    },
    queryClient,
  );
  const page = active ? result.data : undefined;
  return {
    items: page?.items ?? NO_RESULTS,
    hasMore: (page?.nextCursor ?? null) !== null,
    isSearching: active && result.isFetching,
    isLoading: active && result.isFetching && page === undefined,
    error: active ? (result.error as QuickdrawError | null) : null,
  };
}

/** The mock `useSearch` a query member gets when the search kit made its method; nothing otherwise. */
export function mockSearchMember(
  queryClient: QueryClient,
  invoke: Invoke,
  target: MethodTarget,
  definition: MethodDef,
  contract: AnyContract,
): Readonly<Record<string, unknown>> {
  const search = searchTargetOf(target, definition, contract);
  if (search === undefined) {
    return {};
  }
  return {
    useSearch: (q: string, options: UseSearchOptions = {}) =>
      useMockSearch(queryClient, invoke, search, q, options),
  };
}
