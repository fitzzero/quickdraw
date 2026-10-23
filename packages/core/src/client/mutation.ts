"use client";

// The mutation hook behind `qd.<service>.<method>.useMutation` (RFC 0003
// sections 11.2 and 11.4), TanStack Query's own `useMutation` keyed by
// `keys.ts` and calling through `call.ts`; `hooks.ts` exports it with the
// query hook. It returns TanStack's mutation result, typed with
// `QuickdrawError`, and is optimistic by default when its input has `id` and
// its output is `"entity"` (`optimistic.ts`). A failed call's refused items
// show in the render that shows the mutation's error, and their `retry()`
// sends the call again through this hook's mutation, so its `isPending` and
// callbacks follow it (finding F8.3). In development, one hook instance
// issuing its mutation more than 5 times within a second is named as a
// loop, with its component (`loopGuard.ts`).
//
// The result shows a call's `data`, `error`, `variables` and status only
// while the connection's hello names the user the call ran as (`issuer.ts`),
// so a hook that stays mounted across a switch of users shows the next user
// none of the last user's calls, finished or in flight, and nothing while
// new credentials await their hello; `throwOnError` throws only an error it
// shows. Nothing else changes: the call still settles, and its callbacks
// still run, for the user who made it. The observer is not reset, which
// would drop the callbacks `mutate(variables, { onSuccess })` gave a call
// still in flight.

import {
  useMutation,
  type QueryClient,
  type UseMutateAsyncFunction,
  type UseMutateFunction,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useCallback, useRef } from "react";
import type { QuickdrawError } from "../protocol/errors";
import { callData, isNotModified } from "./call";
import { useHello, useQuickdrawContext } from "./context";
import { issuerOf, shownTo, type Issuer } from "./issuer";
import { methodKeyPrefix } from "./keys";
import { createMutationTrace, loopGuardOf, type MutationTrace } from "./loopGuard";
import type { MethodTarget } from "./members";
import {
  applyWhenMutationFails,
  mutateOptimistically,
  type OptimisticCache,
  type OptimisticUpdate,
} from "./optimisticCall";

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

/** What a mutation hook shows of a call it may not show: no call at all. */
function nothingOf<Output, Variables, Context>(
  result: UseMutationResult<Output, QuickdrawError, Variables, Context>,
): UseMutationResult<Output, QuickdrawError, Variables, Context> {
  return {
    ...result,
    data: undefined,
    error: null,
    variables: undefined,
    context: undefined,
    failureCount: 0,
    failureReason: null,
    isPaused: false,
    status: "idle",
    submittedAt: 0,
    isIdle: true,
    isPending: false,
    isSuccess: false,
    isError: false,
  };
}

/**
 * `throwOnError` as TanStack would read it for these options (their own,
 * else the `QueryClient`'s defaults), asked only about an error the hook
 * shows: TanStack throws the error of the state it holds, another user's too.
 */
function throwShownOnly<Output, Variables, Context>(
  queryClient: QueryClient,
  options: UseMutationOptions<Output, QuickdrawError, Variables, Context>,
  shown: () => boolean,
): (error: QuickdrawError) => boolean {
  const { throwOnError } = queryClient.defaultMutationOptions(options);
  return (error) =>
    shown() && (typeof throwOnError === "function" ? throwOnError(error) : throwOnError === true);
}

/**
 * TanStack's `mutate` and `mutateAsync`, recording who each call runs as
 * (`issue`) in `issued` as it is made: the state the hook then holds is that
 * call's.
 */
function useIssuedCalls<Output, Variables, Context>(
  run: UseMutateAsyncFunction<Output, QuickdrawError, Variables, Context>,
  issue: () => Issuer,
  issued: { current: Issuer | undefined },
): {
  readonly mutate: UseMutateFunction<Output, QuickdrawError, Variables, Context>;
  readonly mutateAsync: UseMutateAsyncFunction<Output, QuickdrawError, Variables, Context>;
} {
  const mutateAsync = useCallback<
    UseMutateAsyncFunction<Output, QuickdrawError, Variables, Context>
  >(
    async (variables, mutateOptions) => {
      const issuer = issue();
      issued.current = issuer;
      try {
        return await run(variables, mutateOptions);
      } finally {
        issuer.settled();
      }
    },
    [run, issue, issued],
  );
  const mutate = useCallback<UseMutateFunction<Output, QuickdrawError, Variables, Context>>(
    (variables, mutateOptions) => {
      // As TanStack's own `mutate`: a failure shows in the result's `error`.
      mutateAsync(variables, mutateOptions).catch(() => undefined);
    },
    [mutateAsync],
  );
  return { mutate, mutateAsync };
}

/**
 * `qd.<service>.<method>.useMutation(options)`. `mutate` returns nothing (a
 * failure lands in the result's `error`); `mutateAsync` returns the promise
 * of the output, which rejects with the `QuickdrawError`. The result shows a
 * call only to the user it ran as (see the top of this file).
 */
export function useMethodMutation<Output, Variables, Context = unknown, Cache = OptimisticCache>(
  target: MethodTarget,
  options: MethodMutationOptions<Output, Variables, Context, Cache> = {},
): UseMutationResult<Output, QuickdrawError, Variables, Context> {
  const { connection, queryClient } = useQuickdrawContext(
    `${target.service}.${target.method}.useMutation`,
  );
  const hello = useHello(connection);
  // where this hook instance was first rendered, for a loop warning (development only)
  const traced = useRef<MutationTrace>(undefined);
  traced.current ??= createMutationTrace();
  const trace = traced.current;
  const { optimistic, ...rest } = options;
  const optimisticTarget = {
    service: target.service,
    entityOutput: target.output === "entity",
    collections: target.collections,
  };
  // The hook's own mutate, so a refused item's retry() goes through it (finding F8.3).
  const resend = useRef<((input: Variables) => Promise<Output>) | undefined>(undefined);
  // Who the call whose state the hook holds runs as (`issuer.ts`).
  const issued = useRef<Issuer | undefined>(undefined);
  const shown = (): boolean => shownTo(issued.current, connection.getState().hello);
  const own = { mutationKey: methodKeyPrefix(target.service, target.method), ...rest };
  const mutation = useMutation<Output, QuickdrawError, Variables, Context>({
    ...own,
    throwOnError: throwShownOnly(queryClient, own, shown),
    mutationFn: (input: Variables) => {
      loopGuardOf(queryClient).mutated(trace, target.service, target.method);
      return mutateOptimistically<Output>(
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
        {
          resend: async () => await resend.current?.(input),
          onFailed: (apply) => {
            applyWhenMutationFails(queryClient, input, apply);
          },
        },
      );
    },
  });
  const issue = useCallback(() => issuerOf(connection), [connection]);
  const calls = useIssuedCalls(mutation.mutateAsync, issue, issued);
  resend.current = calls.mutateAsync;
  // Only to the user its call ran as, while a hello names them.
  const result = shownTo(issued.current, hello) ? mutation : nothingOf(mutation);
  return { ...result, ...calls };
}
