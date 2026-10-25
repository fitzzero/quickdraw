// The query and mutation hooks of a mock client's members (`mockClient.ts`,
// RFC 0003 section 13), under the real client's rules for a user's session,
// over the mock's connection, whose state is the mock's session
// (`mockSession.tsx`), and the mock's `QueryClient`:
//
// - a query reads once a hello names the session's user (`isKnown`), shows
//   nothing of what is cached while the mock awaits a hello on a cache a
//   hello settled (`$session({ isKnown: false })` after a known session, as
//   new credentials await theirs), and takes a placeholder only from a query
//   the cache still holds, as `useMethodQuery` does (`../client/hooks.ts`);
// - a mutation is made under the rules of the real mutation hook, from the
//   same code (`../client/userMutation.ts`): bound to the user it is made
//   as, checked at every attempt, and shown only to that user;
// - the mock's cache follows its session as the real cache does: another
//   user's hello empties it, quickdraw's mutations included, and the same
//   user's, after none was known, reads it again (`mockSession.tsx`).
//
// Under the mock's `$Provider`, a hook reads the session of the provider it
// renders in (one with a `session` prop shows its own); outside any, the
// mock's own.

import { useQuery, type QueryClient } from "@tanstack/react-query";
import { useContext } from "react";
import type { QuickdrawConnection } from "../client/connection";
import { QuickdrawContext, useAwaitingHello, useQueriesHello } from "../client/context";
import type { MethodMutationOptions, MethodQueryOptions } from "../client/hooks";
import { methodKeyPrefix, type MethodQueryKey } from "../client/keys";
import type { MethodTarget } from "../client/members";
import { hiddenResult, placeholderOption } from "../client/queryHooks";
import { useUserMutation } from "../client/userMutation";

export type { MethodMutationOptions, MethodQueryOptions };

/** The connection a mock's hook reads: its provider's, when the provider is this mock's, else `own`. */
function useMockConnection(
  own: QuickdrawConnection,
  queryClient: QueryClient,
): QuickdrawConnection {
  const provided = useContext(QuickdrawContext);
  return provided?.queryClient === queryClient ? provided.connection : own;
}

/** A mock query member's `useQuery`: TanStack's, reading `call`, under the session's rules. */
export function useMockQuery(
  own: QuickdrawConnection,
  queryClient: QueryClient,
  call: (input: unknown) => Promise<unknown>,
  queryKey: MethodQueryKey,
  input: unknown,
  options: MethodQueryOptions<unknown> = {},
) {
  const connection = useMockConnection(own, queryClient);
  const live = useQueriesHello(connection) !== null;
  const awaiting = useAwaitingHello(connection, queryClient);
  const { enabled, ...rest } = options;
  const result = useQuery(
    {
      retry: false,
      ...rest,
      queryKey,
      queryFn: () => call(input),
      enabled: live ? (enabled ?? true) : false,
      placeholderData: placeholderOption(queryClient, queryKey, options),
    },
    queryClient,
  );
  // While the mock awaits a hello, what is cached may be the last user's.
  return awaiting ? hiddenResult(result) : result;
}

/** A mock mutation member's `useMutation`: the real mutation hook's rules, over `call`. */
export function useMockMutation(
  own: QuickdrawConnection,
  queryClient: QueryClient,
  target: MethodTarget,
  call: (input: unknown) => Promise<unknown>,
  options: MethodMutationOptions<unknown, unknown> = {},
) {
  const connection = useMockConnection(own, queryClient);
  // Optimistic layers are not shown on a mock: the test sets the rows a component reads.
  const { optimistic: _shown, ...rest } = options;
  return useUserMutation(
    connection,
    queryClient,
    { mutationKey: methodKeyPrefix(target.service, target.method), ...rest },
    async (input) => await call(input),
    queryClient,
  ).result;
}
