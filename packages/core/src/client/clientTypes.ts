// The types of the client `createQuickdrawClient` builds (RFC 0003 section 11),
// all derived from the contracts: `qd.<key>.<method>` is a query member or a
// mutation member by the method's kind, its input is `InputOf` and its data
// `OutputOf`. A misspelled method, or a hook the method's kind does not have
// (`useQuery` on a mutation), is a compile error. 4.1 apps wrote a typed
// wrapper file per app for this (`legacy-src/client/useService.ts:22-34`).

import type {
  QueryClient,
  QueryKey,
  UseMutationResult,
  UseQueryResult,
} from "@tanstack/react-query";
import type { AnyContract } from "../contract/defineContract";
import type {
  CollectionName,
  ContractMap,
  EntityOf,
  IndexRowOf,
  InputOf,
  ItemOf,
  KindOf,
  MethodName,
  MethodOf,
  OutputOf,
  ScopeOf,
  ViewName,
} from "../contract/infer";
import type { QuickdrawError } from "../protocol/errors";
import type { MethodMutationOptions, MethodQueryOptions } from "./hooks";
import type { MethodQueryKey } from "./keys";
import type { SearchMemberOf } from "./live/searchTypes";
import type { UseCollectionOptions, UseCollectionResult } from "./live/useCollection";
import type { UseEntitiesResult, UseEntityOptions, UseEntityResult } from "./live/useEntity";
import type { OptimisticCache } from "./optimistic";

/** Options of a query member's `call`. */
export interface QueryCallOptions {
  /** Aborting it sends `qd:cancel`; the call rejects with `CANCELLED`. */
  readonly signal?: AbortSignal;
  /** How long to wait for the answer. Default: the connection's `timeoutMs`. */
  readonly timeoutMs?: number;
}

/**
 * Options of a mutation member's `call`. There is no signal: the server
 * finishes a mutation it started whatever the caller does (RFC 0003 section 9).
 */
export interface MutationCallOptions {
  /** How long to wait for the answer. Default: the connection's `timeoutMs`. */
  readonly timeoutMs?: number;
}

/** A member's arguments: the input, which may be left out when the method accepts `undefined`, then `Rest`. */
type InputArgs<C extends AnyContract, M extends MethodName<C>, Rest extends unknown[]> =
  undefined extends InputOf<C, M>
    ? [input?: InputOf<C, M>, ...rest: Rest]
    : [input: InputOf<C, M>, ...rest: Rest];

/** What a mutation's `mutate` takes: its input, which may be left out when the method accepts `undefined`. */
export type MutationVariables<C extends AnyContract, M extends MethodName<C>> =
  undefined extends InputOf<C, M> ? InputOf<C, M> | void : InputOf<C, M>;

/** `qd.<key>.<query>`. */
export interface QueryMember<C extends AnyContract, M extends MethodName<C>> {
  /** TanStack's `useQuery` for this query and input. `select` picks `Data`. */
  useQuery<Data = OutputOf<C, M>>(
    ...args: InputArgs<C, M, [options?: MethodQueryOptions<OutputOf<C, M>, Data, InputOf<C, M>>]>
  ): UseQueryResult<Data, QuickdrawError>;
  /** Calls the query over the provider's connection, outside React. */
  call(...args: InputArgs<C, M, [options?: QueryCallOptions]>): Promise<OutputOf<C, M>>;
  /** The key the query's result is cached under: `["qd", service, "m", method, input]`. */
  key(...args: InputArgs<C, M, []>): MethodQueryKey<InputOf<C, M>>;
  /** Fetches the query into `queryClient` over the provider's connection, as `prefetchQuery` does. */
  prefetch(queryClient: QueryClient, ...args: InputArgs<C, M, []>): Promise<void>;
}

/**
 * What a custom optimistic update of a mutation of contract `C` writes
 * through: layers over its entity's rows and its collections' items.
 */
export type OptimisticCacheOf<C extends AnyContract> = OptimisticCache<
  EntityOf<C>,
  { readonly [K in CollectionName<C>]: ItemOf<C, K> }
>;

/** `qd.<key>.<mutation>`. */
export interface MutationMember<C extends AnyContract, M extends MethodName<C>> {
  /**
   * TanStack's `useMutation` for this mutation, with `QuickdrawError` as its
   * error. `mutate` returns nothing (a failure lands in the result's
   * `error`), so do not `await` it; `mutateAsync` returns the output's
   * promise, which rejects with the `QuickdrawError`. A mutation whose input
   * has `id` and whose output is `"entity"` is optimistic by default; see
   * the `optimistic` option.
   */
  useMutation<Context = unknown>(
    options?: MethodMutationOptions<
      OutputOf<C, M>,
      MutationVariables<C, M>,
      Context,
      OptimisticCacheOf<C>
    >,
  ): UseMutationResult<OutputOf<C, M>, QuickdrawError, MutationVariables<C, M>, Context>;
  /** Calls the mutation over the provider's connection, outside React. */
  call(...args: InputArgs<C, M, [options?: MutationCallOptions]>): Promise<OutputOf<C, M>>;
}

/** One method's member, by the method's kind; a search kit method's query member also has `useSearch`. */
export type MethodMember<C extends AnyContract, M extends MethodName<C>> =
  KindOf<C, M> extends "query" ? QueryMember<C, M> & SearchMemberOf<C, M> : MutationMember<C, M>;

/** The entity members of `qd.<key>`, for a contract with an entity. */
export interface EntityMembers<C extends AnyContract> {
  /**
   * Row `id` of the service, live: loaded with `qd:sub`, kept current by
   * the server's frames, resumed by revision after a reconnect. A `null` or
   * empty id holds nothing.
   */
  useEntity(
    id: string | null | undefined,
    options?: UseEntityOptions,
  ): UseEntityResult<EntityOf<C>>;
  /** Rows `ids` of the service, live, subscribed together. */
  useEntities(ids: readonly string[], options?: UseEntityOptions): UseEntitiesResult<EntityOf<C>>;
}

/** `qd.<key>.<collection>`: one collection of the service. */
export interface CollectionMember<C extends AnyContract, K extends CollectionName<C>> {
  /**
   * One scope of the collection, live: its members (the index, filtered by
   * `view`) and the items loaded, kept current by deltas and resumed by
   * revision after a reconnect. A `null` or empty scope holds nothing.
   */
  useCollection(
    scope: ScopeOf<C, K> | null | undefined,
    options?: UseCollectionOptions<ViewName<C, K>>,
  ): UseCollectionResult<ItemOf<C, K>, IndexRowOf<C, K>>;
}

/**
 * The live members of `qd.<key>` (RFC 0003 sections 11 and 11.5):
 * `useEntity` and `useEntities` when the contract has an entity, and one
 * member per collection, beside the methods (methods and collections share
 * one namespace).
 */
export type LiveMembers<C extends AnyContract> = ([EntityOf<C>] extends [never]
  ? unknown
  : EntityMembers<C>) & {
  readonly [K in CollectionName<C>]: CollectionMember<C, K>;
};

/** The names of a contract's methods the admin kit made (the root export's `AdminMethodsOf`). */
type AdminMethodNames<C extends AnyContract> = {
  [M in MethodName<C>]: "~admin" extends keyof MethodOf<C, M> ? M : never;
}[MethodName<C>];

/**
 * `qd.<key>.admin` (RFC 0003 section 12.4): the members of the admin kit's
 * methods together, for a contract with the kit; no member otherwise.
 */
export type AdminMembers<C extends AnyContract> = [AdminMethodNames<C>] extends [never]
  ? unknown
  : { readonly admin: { readonly [M in AdminMethodNames<C>]: MethodMember<C, M> } };

/** `qd.<key>`: one member per method, plus the live members, plus `admin` with the admin kit. */
export type ServiceClient<C extends AnyContract> = {
  readonly [M in MethodName<C>]: MethodMember<C, M>;
} & LiveMembers<C> &
  AdminMembers<C>;

/**
 * `qd.invalidate`: invalidates cached query results through the provider's
 * invalidation coordinator (RFC 0003 section 11.3), so a read in flight is
 * never cancelled and at most one more is queued behind it. Fails with
 * `INTERNAL` while no `QuickdrawProvider` is mounted for the client.
 */
export interface QuickdrawInvalidate {
  /**
   * With `input`, the one result of that input; without, every cached
   * result of the query, whatever its input.
   *
   * @example
   * qd.invalidate(qd.task.get, { id });
   * qd.invalidate(qd.task.list);
   */
  <Input>(member: { readonly key: (...args: never) => MethodQueryKey<Input> }, input?: Input): void;
  /**
   * Every cached result whose key `queryKey` prefixes, as TanStack's
   * `invalidateQueries` matches it: `qd.invalidate(["qd", "taskService"])`.
   */
  (queryKey: QueryKey): void;
}

/** The client of a map of contracts: `qd.task.get.useQuery({ id })`. */
export type QuickdrawClient<Contracts extends ContractMap> = {
  readonly [Key in keyof Contracts]: ServiceClient<Contracts[Key]>;
} & {
  readonly invalidate: QuickdrawInvalidate;
};
