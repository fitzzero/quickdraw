"use client";

// The mutation hook behind `qd.<service>.<method>.useMutation` (RFC 0003
// sections 11.2 and 11.4), TanStack Query's own `useMutation` keyed by
// `keys.ts` and calling through `call.ts`; `hooks.ts` exports it with the
// query hook. It returns TanStack's mutation result as it is, typed with
// `QuickdrawError`, and is optimistic by default when its input has `id` and
// its output is `"entity"` (`optimistic.ts`). In development, one hook
// instance issuing its mutation more than 5 times within a second is named
// as a loop, with its component (`loopGuard.ts`).

import {
  useMutation,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useRef } from "react";
import type { QuickdrawError } from "../protocol/errors";
import { callData, isNotModified } from "./call";
import { useQuickdrawContext } from "./context";
import { methodKeyPrefix } from "./keys";
import { createMutationTrace, loopGuardOf, type MutationTrace } from "./loopGuard";
import type { MethodTarget } from "./members";
import { mutateOptimistically, type OptimisticCache, type OptimisticUpdate } from "./optimistic";

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
  // where this hook instance was first rendered, for a loop warning (development only)
  const traced = useRef<MutationTrace>(undefined);
  traced.current ??= createMutationTrace();
  const trace = traced.current;
  const { optimistic, ...rest } = options;
  const optimisticTarget = { service: target.service, entityOutput: target.output === "entity" };
  return useMutation<Output, QuickdrawError, Variables, Context>({
    mutationKey: methodKeyPrefix(target.service, target.method),
    ...rest,
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
      );
    },
  });
}
