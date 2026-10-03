"use client";

// The query and mutation hooks behind `qd.<service>.<method>.useQuery` and
// `.useMutation` (RFC 0003 sections 11 and 11.2). They are TanStack Query's
// own hooks, keyed by `keys.ts` and fetching through `call.ts`. 4.1's
// `useServiceQuery` and `useService` wrapped them by service and method name
// strings and returned a reshaped result
// (`legacy-src/client/useServiceQuery.ts:54-229`, `useService.ts:39-112`).
//
// A query:
// - runs only while the connection is connected and queries are not backing
//   off after `RATE_LIMITED`, besides its own `enabled`;
// - passes TanStack's abort signal to the call, so unmounting the last
//   component that reads it, or `cancelQueries`, sends `qd:cancel`;
// - sends the cached result's version and keeps the cached result when the
//   server answers "not modified" (`query.ts`);
// - retries once after `INTERNAL` (a dropped connection included) and never
//   after any other code (`shouldRetry`), unless `retry` says otherwise.
// There are no effect-based `onSuccess`/`onError` callbacks (4.1 had them at
// `legacy-src/client/useServiceQuery.ts:185-198`).
//
// A mutation returns TanStack's mutation result as it is, typed with
// `QuickdrawError`. Optimistic updates are a later card's.

import {
  replaceEqualDeep,
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { QuickdrawError } from "../protocol/errors";
import { callData, shouldRetry } from "./call";
import { useQueriesLive, useQuickdrawContext } from "./context";
import { methodKey, methodKeyPrefix, type MethodQueryKey } from "./keys";
import type { MethodTarget } from "./members";
import { fetchMethodQuery } from "./query";
import { carryVersion } from "./versions";

/** Options of a query hook: TanStack's `useQuery` options, without the key and the query function. */
export type MethodQueryOptions<Output, Data = Output, Input = unknown> = Omit<
  UseQueryOptions<Output, QuickdrawError, Data, MethodQueryKey<Input>>,
  "queryKey" | "queryFn"
>;

/** Options of a mutation hook: TanStack's `useMutation` options, without the mutation function. */
export type MethodMutationOptions<Output, Variables, Context = unknown> = Omit<
  UseMutationOptions<Output, QuickdrawError, Variables, Context>,
  "mutationFn"
>;

type StructuralSharing = boolean | ((oldData: unknown, newData: unknown) => unknown);

/**
 * TanStack's structural sharing, which keeps the cached object when a new
 * result is deeply equal to it, moving the new result's version onto the
 * object the cache keeps. `false` turns sharing off as it does in TanStack.
 */
export function shareKeepingVersion(option: StructuralSharing | undefined): StructuralSharing {
  if (option === false) {
    return false;
  }
  return (oldData, newData) => {
    const kept =
      typeof option === "function" ? option(oldData, newData) : replaceEqualDeep(oldData, newData);
    carryVersion(newData, kept);
    return kept;
  };
}

/** `qd.<service>.<method>.useQuery(input, options)`. */
export function useMethodQuery<Output, Data = Output, Input = unknown>(
  target: MethodTarget,
  input: Input,
  options: MethodQueryOptions<Output, Data, Input> = {},
): UseQueryResult<Data, QuickdrawError> {
  const { connection } = useQuickdrawContext(`${target.service}.${target.method}.useQuery`);
  const queryClient = useQueryClient();
  const live = useQueriesLive(connection);
  const { enabled, retry, structuralSharing, ...rest } = options;
  const queryKey = methodKey(target.service, target.method, input);
  return useQuery<Output, QuickdrawError, Data, MethodQueryKey<Input>>({
    ...rest,
    queryKey,
    queryFn: ({ signal }) =>
      fetchMethodQuery<Output>(
        connection,
        queryClient,
        { service: target.service, method: target.method, input, key: queryKey },
        signal,
      ),
    enabled: live ? (enabled ?? true) : false,
    retry: retry ?? shouldRetry,
    structuralSharing: shareKeepingVersion(structuralSharing),
  });
}

/** `qd.<service>.<method>.useMutation(options)`. */
export function useMethodMutation<Output, Variables, Context = unknown>(
  target: MethodTarget,
  options: MethodMutationOptions<Output, Variables, Context> = {},
): UseMutationResult<Output, QuickdrawError, Variables, Context> {
  const { connection } = useQuickdrawContext(`${target.service}.${target.method}.useMutation`);
  return useMutation<Output, QuickdrawError, Variables, Context>({
    mutationKey: methodKeyPrefix(target.service, target.method),
    ...options,
    mutationFn: (input: Variables) =>
      callData<Output>(connection, {
        service: target.service,
        method: target.method,
        input,
        kind: "mutation",
      }),
  });
}
