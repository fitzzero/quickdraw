// The types of the client `createQuickdrawClient` builds (RFC 0003 section 11),
// all derived from the contracts: `qd.<key>.<method>` is a query member or a
// mutation member by the method's kind, its input is `InputOf` and its data
// `OutputOf`. A misspelled method, or a hook the method's kind does not have
// (`useQuery` on a mutation), is a compile error. 4.1 apps wrote a typed
// wrapper file per app for this (`legacy-src/client/useService.ts:22-34`).

import type { QueryClient, UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import type { AnyContract } from "../contract/defineContract";
import type {
  CollectionName,
  ContractMap,
  InputOf,
  KindOf,
  MethodName,
  OutputOf,
} from "../contract/infer";
import type { QuickdrawError } from "../protocol/errors";
import type { MethodMutationOptions, MethodQueryOptions } from "./hooks";
import type { MethodQueryKey } from "./keys";

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

/** `qd.<key>.<mutation>`. */
export interface MutationMember<C extends AnyContract, M extends MethodName<C>> {
  /** TanStack's `useMutation` for this mutation, with `QuickdrawError` as its error. */
  useMutation<Context = unknown>(
    options?: MethodMutationOptions<OutputOf<C, M>, MutationVariables<C, M>, Context>,
  ): UseMutationResult<OutputOf<C, M>, QuickdrawError, MutationVariables<C, M>, Context>;
  /** Calls the mutation over the provider's connection, outside React. */
  call(...args: InputArgs<C, M, [options?: MutationCallOptions]>): Promise<OutputOf<C, M>>;
}

/** One method's member, by the method's kind. */
export type MethodMember<C extends AnyContract, M extends MethodName<C>> =
  KindOf<C, M> extends "query" ? QueryMember<C, M> : MutationMember<C, M>;

/**
 * The live members of `qd.<key>` (RFC 0003 sections 11 and 11.5):
 * `useEntity`, `useEntities` and one member per collection, beside the
 * methods (methods and collections share one namespace). The live-data card
 * adds them here; until then every collection maps to nothing.
 */
export type LiveMembers<C extends AnyContract> = {
  readonly [K in CollectionName<C> as never]: never;
};

/** `qd.<key>`: one member per method, plus the live members. */
export type ServiceClient<C extends AnyContract> = {
  readonly [M in MethodName<C>]: MethodMember<C, M>;
} & LiveMembers<C>;

/** The client of a map of contracts: `qd.task.get.useQuery({ id })`. */
export type QuickdrawClient<Contracts extends ContractMap> = {
  readonly [Key in keyof Contracts]: ServiceClient<Contracts[Key]>;
};
