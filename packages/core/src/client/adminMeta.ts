"use client";

// How the typed client runs its services' `adminMeta` for `useAdminServices`
// (`admin.ts`): one TanStack query per service, made as
// `qd.<service>.admin.adminMeta.useQuery()` makes it (`hooks.ts`), under the
// same key, so the two share one cached result. It runs once the server's
// hello on the current credentials has arrived, and retries as every query
// does.

import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import type { AnyContract } from "../contract/defineContract";
import type { AdminServiceMeta } from "../contract/kits/admin";
import { adminNamespace, type AdminMetaQuery, type AdminMetaState } from "./admin";
import { shouldRetry } from "./call";
import { useQueriesHello, useQuickdrawContext } from "./context";
import { shareKeepingVersion } from "./hooks";
import { methodKey } from "./keys";
import { fetchMethodQuery } from "./query";

/** The states of the queries: a stable function, so TanStack keeps the result while they do not change. */
function statesOf(results: UseQueryResult<AdminServiceMeta>[]): AdminMetaState[] {
  return results.map((result) => ({ data: result.data, error: result.error }));
}

/** The typed client's `adminMeta` queries, under the provider it renders in. */
function useClientAdminMeta(
  queries: readonly AdminMetaQuery[],
  enabled: boolean,
): readonly AdminMetaState[] {
  const { connection, queryClient } = useQuickdrawContext("useAdminServices");
  const live = useQueriesHello(connection) !== null;
  return useQueries(
    {
      queries: queries.map((query) => {
        const queryKey = methodKey(query.serviceName, query.method, undefined);
        return {
          queryKey,
          queryFn: ({ signal }: { readonly signal: AbortSignal }) =>
            fetchMethodQuery<AdminServiceMeta>(
              connection,
              queryClient,
              { service: query.serviceName, method: query.method, input: undefined, key: queryKey },
              signal,
            ),
          enabled: live && enabled,
          retry: shouldRetry,
          structuralSharing: shareKeepingVersion(undefined),
        };
      }),
      combine: statesOf,
    },
    queryClient,
  );
}

/** The typed client's `admin` member of a contract's service (`adminNamespace`). */
export function clientAdminNamespace(
  contract: AnyContract,
  methods: Readonly<Record<string, object>>,
): Readonly<Record<string, object>> {
  return adminNamespace(contract, methods, useClientAdminMeta);
}
