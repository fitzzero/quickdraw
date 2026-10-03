"use client";

// `createQuickdrawClient(contracts)` (RFC 0003 section 11): the client object
// built at runtime from the app's contracts (`members.ts`), with no code
// generation and no per-app wrapper file. Each member is made once, so its
// hooks keep their identity across renders.
//
// The hooks read the connection of the provider they render under. `call`
// and `prefetch` run outside React, so they use the connection of the
// `QuickdrawProvider` this client was given to (`bindConnection`), and fail
// with `INTERNAL` while none is mounted.

import type { QueryClient } from "@tanstack/react-query";
import type { ContractMap } from "../contract/infer";
import { QuickdrawError } from "../protocol/errors";
import { callData } from "./call";
import type { MutationCallOptions, QueryCallOptions, QuickdrawClient } from "./clientTypes";
import type { QuickdrawConnection } from "./connection";
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

/** The connection a client's `call` and `prefetch` use. */
interface Binding {
  connection: QuickdrawConnection | null;
}

const bindings = new WeakMap<object, Binding>();

function connectionOf(binding: Binding, target: MethodTarget, member: string): QuickdrawConnection {
  if (binding.connection === null) {
    throw new QuickdrawError(
      "INTERNAL",
      `${target.service}.${target.method}.${member} needs a mounted <QuickdrawProvider> for this client`,
    );
  }
  return binding.connection;
}

function queryMember(binding: Binding, target: MethodTarget): object {
  const key = (input?: unknown): MethodQueryKey => methodKey(target.service, target.method, input);
  return Object.freeze({
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
            { service: target.service, method: target.method, input, key: queryKey },
            signal,
          ),
        structuralSharing: shareKeepingVersion(undefined),
      });
    },
  });
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
 * query and `useMutation` and `call` on a mutation. Render a
 * `QuickdrawProvider` with `client={qd}` above the components that use it.
 *
 * @example
 * export const qd = createQuickdrawClient({ task, project });
 * const { data } = qd.task.get.useQuery({ id });
 * const rename = qd.task.rename.useMutation();
 */
export function createQuickdrawClient<const Contracts extends ContractMap>(
  contracts: Contracts,
): QuickdrawClient<Contracts> {
  const binding: Binding = { connection: null };
  const client = buildCaller("createQuickdrawClient", contracts, (target) =>
    target.kind === "query" ? queryMember(binding, target) : mutationMember(binding, target),
  );
  bindings.set(client, binding);
  return client as QuickdrawClient<Contracts>;
}

/**
 * Makes `connection` the one `client`'s `call` and `prefetch` use, until the
 * returned function runs (unless another connection was bound meanwhile).
 * `QuickdrawProvider` binds its connection while it is mounted.
 */
export function bindConnection(client: object, connection: QuickdrawConnection): () => void {
  const binding = bindings.get(client);
  if (binding === undefined) {
    throw new TypeError("QuickdrawProvider: client must be made by createQuickdrawClient");
  }
  binding.connection = connection;
  return () => {
    if (binding.connection === connection) {
      binding.connection = null;
    }
  };
}
