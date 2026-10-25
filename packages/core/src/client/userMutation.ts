"use client";

// TanStack Query's `useMutation` with quickdraw's rules for whom a call is
// made as (RFC 0003 sections 11.2 and 11.4): what a member's mutation hook
// (`mutation.ts`) and a mock client's (`../testing/mockCalls.ts`) share, over
// a connection and a `QueryClient` each brings, and the call each makes.
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
//
// Each call's mutation carries `meta.qd`, beside the options' own `meta` and
// whatever `mutationKey` they give, so the cache session finds it in
// TanStack's mutation cache to take it out for another user (`session.ts`).

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
import type { QuickdrawConnection } from "./connection";
import { useCredentialsEpoch, useHello } from "./context";
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
import { KEY_ROOT } from "./keys";

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

/** Options of a mutation under quickdraw's rules: TanStack's `useMutation` options, without the mutation function. */
export type UserMutationOptions<Output, Variables, Context> = Omit<
  UseMutationOptions<Output, QuickdrawError, Variables, Context>,
  "mutationFn"
>;

/** A mutation under quickdraw's rules, and the function that sends an input again with an earlier call's ticket. */
export interface UserMutation<Output, Variables, Context> {
  readonly result: UseMutationResult<Output, QuickdrawError, Variables, Context>;
  /** Makes the call with `ticket`, the one an earlier call was issued with (a refused item's `retry()`). */
  readonly sendAs: (variables: Variables, ticket: Ticket) => Promise<Output>;
}

/**
 * TanStack's `useMutation` over `attempt` under quickdraw's rules for whom a
 * call is made as (see the top of this file), on `connection`. `attempt`
 * runs once its ticket passed the check, with that ticket. `queryClient`
 * gives the defaults and the mutation cache the calls are watched in;
 * `client` is the one `useMutation` takes (TanStack's provider's when left
 * out, as under a nested `QueryClientProvider`).
 */
export function useUserMutation<Output, Variables, Context>(
  connection: QuickdrawConnection,
  queryClient: QueryClient,
  options: UserMutationOptions<Output, Variables, Context>,
  attempt: (input: Variables, ticket: Ticket) => Promise<Output>,
  client?: QueryClient,
): UserMutation<Output, Variables, Context> {
  const hello = useHello(connection);
  const epoch = useCredentialsEpoch(connection);
  // The tickets of the calls on their way, and of the call whose state the hook holds.
  const [tickets] = useState(createTickets);
  const issued = useRef<Ticket | undefined>(undefined);
  const shown = (): boolean => shownOn(issued.current, connection);
  const mutation = useMutation<Output, QuickdrawError, Variables, Context>(
    {
      ...options,
      // Quickdraw's, whatever key its options give: the cache session finds its calls by it.
      meta: { ...options.meta, [KEY_ROOT]: true },
      throwOnError: throwShownOnly(queryClient, options, shown),
      retry: retryUnlessUserChanged(queryClient, options),
      // Every attempt, first: refused (`CANCELLED`) once its user changed, never sent as another.
      mutationFn: (input: Variables) => attempt(input, checkedTicket(tickets, input, connection)),
    },
    client,
  );
  const issue = useCallback(() => ticketOf(connection), [connection]);
  const { sendAs, ...calls } = useIssuedCalls(
    queryClient,
    mutation.mutateAsync,
    issue,
    tickets,
    issued,
  );
  // To its user while a hello names them; a call nobody's yet, under its epoch while none is held.
  const result = shownTo(issued.current, hello, epoch) ? mutation : nothingOf(mutation);
  return { result: { ...result, ...calls }, sendAs };
}
