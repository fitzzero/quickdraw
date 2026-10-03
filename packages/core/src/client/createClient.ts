"use client";

// `createQuickdrawClient(contracts)` (RFC 0003 section 11): the client object
// built at runtime from the app's contracts (`members.ts`), with no code
// generation and no per-app wrapper file. Each member is made once, so its
// hooks keep their identity across renders.
//
// The hooks read the connection of the provider they render under. `call`,
// `prefetch` and `qd.invalidate` run outside React, so they use the
// connection and the invalidation coordinator of the `QuickdrawProvider` this
// client was given to (`binding.ts`), and fail with `INTERNAL` while none is
// mounted.

import type { QueryClient } from "@tanstack/react-query";
import type { ContractMap } from "../contract/infer";
import {
  attachBinding,
  connectionOf,
  createBinding,
  invalidateWith,
  registerQuery,
  type Binding,
} from "./binding";
import { callData } from "./call";
import type { MutationCallOptions, QueryCallOptions, QuickdrawClient } from "./clientTypes";
import {
  shareKeepingVersion,
  useMethodMutation,
  useMethodQuery,
  type MethodMutationOptions,
  type MethodQueryOptions,
} from "./hooks";
import { methodKey, type MethodQueryKey } from "./keys";
import { buildCaller, type MethodTarget } from "./members";
import { fetchMethodQuery } from "./query";

export { bindConnection, isWatchedQuery } from "./binding";

/** The members of the client object besides its services. */
const RESERVED_KEYS = ["invalidate"] as const;

function queryMember(binding: Binding, target: MethodTarget): object {
  const key = (input?: unknown): MethodQueryKey => methodKey(target.service, target.method, input);
  const member = Object.freeze({
    useQuery: (input?: unknown, options?: MethodQueryOptions<unknown>) =>
      useMethodQuery(target, input, options),
    call: async (input?: unknown, options?: QueryCallOptions): Promise<unknown> =>
      await callData(connectionOf(binding, target, "call"), {
        ...target,
        input,
        signal: options?.signal,
        timeoutMs: options?.timeoutMs,
      }),
    key,
    async prefetch(queryClient: QueryClient, input?: unknown): Promise<void> {
      const connection = connectionOf(binding, target, "prefetch");
      const queryKey = key(input);
      await queryClient.prefetchQuery({
        queryKey,
        queryFn: ({ signal }) =>
          fetchMethodQuery(
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
          ),
        structuralSharing: shareKeepingVersion(undefined),
      });
    },
  });
  registerQuery(binding, member, target);
  return member;
}

function mutationMember(binding: Binding, target: MethodTarget): object {
  return Object.freeze({
    useMutation: (options?: MethodMutationOptions<unknown, unknown>) =>
      useMethodMutation(target, options),
    call: async (input?: unknown, options?: MutationCallOptions): Promise<unknown> =>
      await callData(connectionOf(binding, target, "call"), {
        ...target,
        input,
        timeoutMs: options?.timeoutMs,
      }),
  });
}

/**
 * Creates the typed client of `contracts`: `qd.<key>.<method>` for every
 * contract in the map, with `useQuery`, `call`, `key` and `prefetch` on a
 * query and `useMutation` and `call` on a mutation, plus `qd.invalidate`.
 * Render a `QuickdrawProvider` with `client={qd}` above the components that
 * use it. No contract may be keyed `invalidate`.
 *
 * @example
 * export const qd = createQuickdrawClient({ task, project });
 * const { data } = qd.task.get.useQuery({ id });
 * const rename = qd.task.rename.useMutation();
 * qd.invalidate(qd.task.list);
 */
export function createQuickdrawClient<const Contracts extends ContractMap>(
  contracts: Contracts & { readonly invalidate?: never },
): QuickdrawClient<Contracts> {
  const binding = createBinding();
  const client = buildCaller(
    "createQuickdrawClient",
    contracts,
    (target) =>
      target.kind === "query" ? queryMember(binding, target) : mutationMember(binding, target),
    RESERVED_KEYS,
  );
  // Not enumerable: the client's own keys stay its services.
  Object.defineProperty(client, "invalidate", { value: invalidateWith(binding) });
  Object.freeze(client);
  attachBinding(client, binding);
  return client as QuickdrawClient<Contracts>;
}
