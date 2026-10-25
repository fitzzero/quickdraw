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
// Each call carries a ticket from the moment it is issued (`issuer.ts`):
// the user it is made as, and the credentials epoch it is made under. The
// hook keeps it by the call's `variables` until the call settles, or until
// TanStack drops it unsettled for good (a paused call `queryClient.clear()`
// removes), and checks every ticket of that value at the start of every
// attempt, before anything else: TanStack runs the mutation function late
// (after `onMutate`, a pause offline, a `scope` queue) and again for a
// retry, and the call goes out as whoever the socket then speaks for. One
// whose user changed meanwhile fails `CANCELLED`, never sent, before its
// optimistic update runs, and is not retried. A refused item's `retry()`
// keeps the ticket of the call it sends again; refused so, the item shows
// in `refused` again unless the cache was emptied meanwhile
// (`liveHooks.ts`). This check runs against the hello the connection holds,
// which a drop keeps; the socket half is `call()`'s, which holds a call
// made while its socket has no hello of its own and sends it only if that
// hello names the call's user (a cookie may name someone else).
//
// The result shows a call's `data`, `error`, `variables` and status only to
// the user it is made as, while a hello names them, or, for a call no hello
// made anyone's yet, to whoever views it under the credentials it was made
// under while no hello is held: a hook that stays mounted across a switch
// of users shows the next user none of the last user's calls, finished or
// in flight, and nothing while new credentials await their hello;
// `throwOnError` throws only an error it shows. Nothing else changes: the
// call still settles, and its callbacks still run, for the user who made
// it. The observer is not reset, which would drop the callbacks
// `mutate(variables, { onSuccess })` gave a call still in flight.

import {
  useMutation,
  type MutateOptions,
  type MutationCacheNotifyEvent,
  type QueryClient,
  type UseMutateAsyncFunction,
  type UseMutateFunction,
  type UseMutationOptions,
  type UseMutationResult,
} from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import type { QuickdrawError } from "../protocol/errors";
import { callData, isNotModified } from "./call";
import { useCredentialsEpoch, useHello, useQuickdrawContext } from "./context";
import {
  checkedTicket,
  createTickets,
  isUserChange,
  shownOn,
  shownTo,
  ticketOf,
  type Ticket,
  type Tickets,
} from "./issuer";
import { KEY_ROOT, methodKeyPrefix } from "./keys";
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
 * `retry` as TanStack would read it for these options (their own, else the
 * `QueryClient`'s defaults, else none), never for a call refused because
 * its user changed (`isUserChange`): every attempt of it is refused alike.
 */
function retryUnlessUserChanged<Output, Variables, Context>(
  queryClient: QueryClient,
  options: UseMutationOptions<Output, QuickdrawError, Variables, Context>,
): (failureCount: number, error: QuickdrawError) => boolean {
  const retry = queryClient.defaultMutationOptions(options).retry ?? 0;
  return (failureCount, error) =>
    !isUserChange(error) &&
    (retry === true ||
      (typeof retry === "number" && failureCount < retry) ||
      (typeof retry === "function" && retry(failureCount, error)));
}

/** A hook's own calls: TanStack's, each made with a ticket the hook keeps beside it. */
interface IssuedCalls<Output, Variables, Context> {
  readonly mutate: UseMutateFunction<Output, QuickdrawError, Variables, Context>;
  readonly mutateAsync: UseMutateAsyncFunction<Output, QuickdrawError, Variables, Context>;
  /** Makes the call with `ticket`, the one an earlier call was issued with (a refused item's `retry()`). */
  readonly sendAs: (variables: Variables, ticket: Ticket) => Promise<Output>;
}

/**
 * Runs `start`, TanStack's `mutate`, which adds the call's mutation to the
 * cache before it returns, and calls `onDead` if that mutation leaves the
 * cache while its retryer is paused, or its retryer pauses once it is out
 * (`queryClient.clear()` with the call offline or queued in its scope):
 * TanStack resumes only the paused mutations its cache holds, so it never
 * runs again, and never settles. Paused means the retryer's own `pause`,
 * not the state's `isPaused`, which a call made offline or queued already
 * has while its `onMutate` runs: one removed then, or while it runs, still
 * runs, and settles. Under a nested `QueryClientProvider`, whose client
 * `useMutation` takes, the mutation is not found here: the ticket is let go
 * only when the call settles, as before.
 */
async function untilDead<T>(
  queryClient: QueryClient,
  start: () => Promise<T>,
  onDead: () => void,
): Promise<T> {
  let starting = true;
  let made: MutationCacheNotifyEvent["mutation"] | undefined;
  let removed = false;
  let paused = false;
  const stop = queryClient.getMutationCache().subscribe((event) => {
    if (starting && made === undefined && event.type === "added") {
      made = event.mutation;
    } else if (made !== undefined && event.mutation === made) {
      removed ||= event.type === "removed";
      if (event.type === "updated" && event.action.type === "pause") {
        paused = true;
      } else if (event.type === "updated" && event.action.type === "continue") {
        paused = false;
      }
      if (removed && paused) {
        stop();
        onDead();
      }
    }
  });
  const started = start();
  starting = false;
  try {
    return await started;
  } finally {
    stop();
  }
}

/**
 * TanStack's `mutate` and `mutateAsync`, each call issued with a ticket
 * (`issue`) kept in `tickets` by its variables until it settles (or is
 * dropped unsettled for good, `untilDead`), and in `issued`: the state the
 * hook then holds is that call's.
 */
function useIssuedCalls<Output, Variables, Context>(
  queryClient: QueryClient,
  run: UseMutateAsyncFunction<Output, QuickdrawError, Variables, Context>,
  issue: () => Ticket,
  tickets: Tickets,
  issued: { current: Ticket | undefined },
): IssuedCalls<Output, Variables, Context> {
  const send = useCallback(
    async (
      variables: Variables,
      ticket: Ticket,
      mutateOptions?: MutateOptions<Output, QuickdrawError, Variables, Context>,
    ): Promise<Output> => {
      issued.current = ticket;
      const release = tickets.hold(variables, ticket);
      try {
        return await untilDead(
          queryClient,
          async () => await run(variables, mutateOptions),
          release,
        );
      } finally {
        release();
      }
    },
    [queryClient, run, tickets, issued],
  );
  const mutateAsync = useCallback<
    UseMutateAsyncFunction<Output, QuickdrawError, Variables, Context>
  >(
    async (variables, mutateOptions) => await send(variables, issue(), mutateOptions),
    [send, issue],
  );
  const mutate = useCallback<UseMutateFunction<Output, QuickdrawError, Variables, Context>>(
    (variables, mutateOptions) => {
      // As TanStack's own `mutate`: a failure shows in the result's `error`.
      mutateAsync(variables, mutateOptions).catch(() => undefined);
    },
    [mutateAsync],
  );
  const sendAs = useCallback(
    async (variables: Variables, ticket: Ticket) => await send(variables, ticket),
    [send],
  );
  return { mutate, mutateAsync, sendAs };
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
  const epoch = useCredentialsEpoch(connection);
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
  const resend = useRef<IssuedCalls<Output, Variables, Context>["sendAs"]>(undefined);
  // The tickets of the calls on their way, and of the call whose state the hook holds.
  const [tickets] = useState(createTickets);
  const issued = useRef<Ticket | undefined>(undefined);
  const shown = (): boolean => shownOn(issued.current, connection);
  const own = { mutationKey: methodKeyPrefix(target.service, target.method), ...rest };
  const mutation = useMutation<Output, QuickdrawError, Variables, Context>({
    ...own,
    // Quickdraw's, whatever key its options give: the cache session finds its calls by it.
    meta: { ...own.meta, [KEY_ROOT]: true },
    throwOnError: throwShownOnly(queryClient, own, shown),
    retry: retryUnlessUserChanged(queryClient, own),
    mutationFn: (input: Variables) => {
      // Every attempt, first: refused (`CANCELLED`) once its user changed, never sent as another.
      const ticket = checkedTicket(tickets, input, connection);
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
          resend: async () => await resend.current?.(input, ticket),
          onFailed: (apply) => {
            applyWhenMutationFails(queryClient, input, apply);
          },
        },
      );
    },
  });
  const issue = useCallback(() => ticketOf(connection), [connection]);
  const { sendAs, ...calls } = useIssuedCalls(
    queryClient,
    mutation.mutateAsync,
    issue,
    tickets,
    issued,
  );
  resend.current = sendAs;
  // To its user while a hello names them; a call nobody's yet, under its epoch while none is held.
  const result = shownTo(issued.current, hello, epoch) ? mutation : nothingOf(mutation);
  return { ...result, ...calls };
}
