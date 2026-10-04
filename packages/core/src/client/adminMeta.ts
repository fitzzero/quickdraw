"use client";

// How the typed client runs its services' `adminMeta` for `useAdminServices`
// (`admin.ts`): one TanStack query per service, made as
// `qd.<service>.admin.adminMeta.useQuery()` makes it (`hooks.ts`), under the
// same key, so the two share one cached result. It runs once the server's
// hello on the current credentials has arrived, and retries as every query
// does. A service whose `adminMeta` refused the user (`FORBIDDEN`,
// `UNAUTHENTICATED`) is not asked again (not on a remount, not after a
// reconnect) until the user's grant on that service changes: its access is
// the service grant, which the hello and `qd:access` carry.

import { useQueries, type UseQueryResult } from "@tanstack/react-query";
import type { AnyContract } from "../contract/defineContract";
import type { AdminServiceMeta } from "../contract/kits/admin";
import { adminNamespace, type AdminMetaQuery, type AdminMetaState } from "./admin";
import { grantOn, isRefusal, refusalsOf, useClientAdminGrants } from "./adminGrants";
import { shouldRetry } from "./call";
import { useAwaitingHello, useQueriesHello, useQuickdrawContext } from "./context";
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
  const awaiting = useAwaitingHello(connection, queryClient);
  const refused = refusalsOf(queryClient);
  const states = useQueries(
    {
      queries: queries.map((query) => {
        const queryKey = methodKey(query.serviceName, query.method, undefined);
        const standing = refused.get(query.serviceName);
        return {
          queryKey,
          queryFn: async ({ signal }: { readonly signal: AbortSignal }) => {
            const grant = grantOn(connection, query.serviceName);
            try {
              const meta = await fetchMethodQuery<AdminServiceMeta>(
                connection,
                queryClient,
                {
                  service: query.serviceName,
                  method: query.method,
                  input: undefined,
                  key: queryKey,
                },
                signal,
              );
              refused.delete(query.serviceName);
              return meta;
            } catch (error) {
              if (isRefusal(error)) {
                refused.set(query.serviceName, grant);
              }
              throw error;
            }
          },
          // Refused under the grant the user still holds: not asked again.
          enabled:
            live &&
            enabled &&
            (standing === undefined || standing !== grantOn(connection, query.serviceName)),
          retry: shouldRetry,
          structuralSharing: shareKeepingVersion(undefined),
        };
      }),
      combine: statesOf,
    },
    queryClient,
  );
  // While new credentials await their hello, what is cached may be the last user's.
  return awaiting ? states.map(() => NOTHING_YET) : states;
}

const NOTHING_YET: AdminMetaState = Object.freeze({ data: undefined, error: null });

/** The typed client's `admin` member of a contract's service (`adminNamespace`). */
export function clientAdminNamespace(
  contract: AnyContract,
  methods: Readonly<Record<string, object>>,
): Readonly<Record<string, object>> {
  return adminNamespace(contract, methods, {
    useMeta: useClientAdminMeta,
    useGrants: useClientAdminGrants,
  });
}
