// The types of `qd.<service>.<search>.useSearch` (RFC 0003 section 12.2),
// for a method the search kit made: its options and result, and the member
// type the typed client adds to that method's member (`clientTypes.ts`).

import type { AnyContract } from "../../contract/defineContract";
import type { InputOf, MethodName, MethodOf, OutputOf } from "../../contract/infer";
import type { SearchPage } from "../../contract/kits/searchSchemas";
import type { QuickdrawError } from "../../protocol/errors";

/** Options of `useSearch`; `Scoped` when the search keeps to the scopes of a collection. */
export interface UseSearchOptions<Scoped extends boolean = boolean> {
  /**
   * One scope of the search's collection (a project id): only its members
   * are searched, and while a `useCollection` holds the same scope, the
   * results stay current with its deltas. `null` or empty searches every
   * row the user can read.
   */
  readonly scope?: Scoped extends true ? string | null : never;
  /** How long typing must pause before a search is sent, in milliseconds. Default 200. */
  readonly debounceMs?: number;
  /** How many results to ask for: the server's default (20) when absent, at most 100. */
  readonly limit?: number;
  /** `false` sends nothing and shows nothing. Default `true`. */
  readonly enabled?: boolean;
}

/** What `useSearch` returns. */
export interface UseSearchResult<Item> {
  /**
   * The results, in the server's order: the latest search's, or, while a
   * newer search in the same scope is on its way, the last ones that
   * answered. Empty while the query is shorter than the method's
   * `minLength`.
   */
  readonly items: readonly Item[];
  /** True when the server found more results than it sent: a longer query narrows them. */
  readonly hasMore: boolean;
  /** True while a search waits for typing to pause or for the server's answer. */
  readonly isSearching: boolean;
  /** True while a search is on its way and no results are shown yet. */
  readonly isLoading: boolean;
  /** Why the latest search failed, or `null`. */
  readonly error: QuickdrawError | null;
}

/** `useSearch` on the member of a search method: a page of `Item`s, `Scoped` or not. */
export interface SearchMember<Item, Scoped extends boolean> {
  /**
   * Searches as the user types: `q` is sent once typing pauses
   * (`debounceMs`), a search still on its way when the next is sent is
   * cancelled (`qd:cancel`), and the last results stay shown until the next
   * answer. Results that are items of the scope a `useCollection` holds stay
   * current with that scope's deltas.
   */
  useSearch(q: string, options?: UseSearchOptions<Scoped>): UseSearchResult<Item>;
}

type SearchItemOf<C extends AnyContract, M extends MethodName<C>> =
  OutputOf<C, M> extends SearchPage<infer Item> ? Item : never;

type ScopedSearch<C extends AnyContract, M extends MethodName<C>> = "scope" extends keyof InputOf<
  C,
  M
>
  ? true
  : false;

/** The `useSearch` member of method `M`, when the search kit made it; nothing otherwise. */
export type SearchMemberOf<
  C extends AnyContract,
  M extends MethodName<C>,
> = "~search" extends keyof MethodOf<C, M>
  ? SearchMember<SearchItemOf<C, M>, ScopedSearch<C, M>>
  : unknown;
