"use client";

// The query and mutation hooks behind `qd.<service>.<method>.useQuery` and
// `.useMutation` (RFC 0003 sections 11, 11.2, 11.3 and 11.4). They are
// TanStack Query's own hooks, keyed by `keys.ts` and fetching through
// `call.ts`. 4.1's `useServiceQuery` and `useService` wrapped them by service
// and method name strings and returned a reshaped result
// (`legacy-src/client/useServiceQuery.ts:54-229`, `useService.ts:39-112`).
//
// A query:
// - runs only while the connection is connected (or reconnecting with the
//   same credentials), the server's hello has named the user, and queries
//   are not backing off after `RATE_LIMITED`, besides its own `enabled`;
//   after another user's hello it renders again over the emptied cache
//   (`session.ts`);
// - passes TanStack's abort signal to the call, so unmounting the last
//   component that reads it, or `cancelQueries`, sends `qd:cancel`;
// - sends the cached result's version and keeps the cached result when the
//   server answers "not modified" (`query.ts`);
// - retries once after `INTERNAL` (a dropped connection included) and never
//   after any other code (`shouldRetry`), unless `retry` says otherwise;
// - joins the change topic its contract method `watch`es while it is
//   mounted and enabled, and is invalidated through the coordinator when the
//   topic changes: never a read cancelled, at most one queued behind it. A
//   read that starts while the join is in flight on a connected socket
//   waits for the server's answer, so the first mount reads once;
// - shows the overlays of optimistic mutations over the rows it returns.
// There are no effect-based `onSuccess`/`onError` callbacks (4.1 had them at
// `legacy-src/client/useServiceQuery.ts:185-198`).
//
// A mutation returns TanStack's mutation result as it is, typed with
// `QuickdrawError`, and is optimistic by default when its input has `id` and
// its output is `"entity"` (`optimistic.ts`).

import {
  replaceEqualDeep,
  useMutation,
  useQuery,
  type UseMutationOptions,
  type UseMutationResult,
  type UseQueryOptions,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { QuickdrawError } from "../protocol/errors";
import { callData, isNotModified, shouldRetry } from "./call";
import { useQueriesHello, useQuickdrawContext } from "./context";
import { methodKey, methodKeyPrefix, type MethodQueryKey } from "./keys";
import type { MethodTarget } from "./members";
import { mutateOptimistically, type OptimisticCache, type OptimisticUpdate } from "./optimistic";
import { fetchMethodQuery } from "./query";
import { readAfterJoin, topicOf, useOverlaySelect, useTopicWatch } from "./queryHooks";
import { carryVersion } from "./versions";

/** Options of a query hook: TanStack's `useQuery` options, without the key and the query function. */
export type MethodQueryOptions<Output, Data = Output, Input = unknown> = Omit<
  UseQueryOptions<Output, QuickdrawError, Data, MethodQueryKey<Input>>,
  "queryKey" | "queryFn"
>;

/**
 * Options of a mutation hook: TanStack's `useMutation` options, without the
 * mutation function, and `optimistic`.
 */
export type MethodMutationOptions<
  Output,
  Variables,
  Context = unknown,
  Cache = OptimisticCache,
> = Omit<UseMutationOptions<Output, QuickdrawError, Variables, Context>, "mutationFn"> & {
  /**
   * The mutation's optimistic update (RFC 0003 section 11.4): `false` for
   * none, or a function that writes its own layers through `cache`. Left
   * out, a mutation whose input has `id` and whose output is `"entity"`
   * shows its input's other fields over that row from the moment it is sent:
   * dropped if the call fails, kept after it succeeds until the server's
   * data for the row catches up.
   */
  readonly optimistic?: false | OptimisticUpdate<Variables, Cache>;
};

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
  const { connection, queryClient, coordinator } = useQuickdrawContext(
    `${target.service}.${target.method}.useQuery`,
  );
  const live = useQueriesHello(connection) !== null;
  const { enabled, retry, structuralSharing, select, ...rest } = options;
  const queryKey = methodKey(target.service, target.method, input);
  const topic = enabled === false ? undefined : topicOf(target, input);
  useTopicWatch({ connection, coordinator, service: target.service, queryKey, topic });
  const shown = useOverlaySelect<Output, Data>(queryClient, target, select);
  return useQuery<Output, QuickdrawError, Data, MethodQueryKey<Input>>({
    ...rest,
    queryKey,
    queryFn: async ({ signal }) => {
      await readAfterJoin(connection, target.service, topic, queryKey, signal);
      return await fetchMethodQuery<Output>(
        connection,
        queryClient,
        {
          service: target.service,
          method: target.method,
          input,
          key: queryKey,
          output: target.output,
        },
        signal,
      );
    },
    enabled: live ? (enabled ?? true) : false,
    retry: retry ?? shouldRetry,
    structuralSharing: shareKeepingVersion(structuralSharing),
    ...(shown === undefined ? {} : { select: shown }),
  });
}

/**
 * `qd.<service>.<method>.useMutation(options)`. `mutate` returns nothing (a
 * failure lands in the result's `error`); `mutateAsync` returns the promise
 * of the output, which rejects with the `QuickdrawError`.
 */
export function useMethodMutation<Output, Variables, Context = unknown, Cache = OptimisticCache>(
  target: MethodTarget,
  options: MethodMutationOptions<Output, Variables, Context, Cache> = {},
): UseMutationResult<Output, QuickdrawError, Variables, Context> {
  const { connection, queryClient } = useQuickdrawContext(
    `${target.service}.${target.method}.useMutation`,
  );
  const { optimistic, ...rest } = options;
  const optimisticTarget = { service: target.service, entityOutput: target.output === "entity" };
  return useMutation<Output, QuickdrawError, Variables, Context>({
    mutationKey: methodKeyPrefix(target.service, target.method),
    ...rest,
    mutationFn: (input: Variables) =>
      mutateOptimistically<Output>(
        queryClient,
        optimisticTarget,
        optimistic as false | OptimisticUpdate<unknown> | undefined,
        input,
        (replied) =>
          callData<Output>(connection, {
            service: target.service,
            method: target.method,
            input,
            kind: "mutation",
            onReply: (result) => {
              if (!isNotModified(result)) {
                replied(result.d as Output);
              }
            },
          }),
      ),
  });
}
