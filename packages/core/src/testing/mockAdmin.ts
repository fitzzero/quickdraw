// The mock client's `qd.<service>.admin` (`mockClient.ts`): the same
// namespace as the typed client's (`../client/admin.ts`), holding the mocked
// members of the admin methods, so `qd.task.admin.adminList.mockResolvedValue`
// sets the same stub as `qd.task.adminList`. `useAdminServices` on a mock
// client asks each `adminMeta` stub at once, on the mock's cache, so a
// component test lists services with `adminMeta.mockResolvedValue(meta)`.

import { useQueries, type QueryClient, type UseQueryResult } from "@tanstack/react-query";
import {
  adminNamespace,
  type AdminMetaQuery,
  type AdminMetaState,
  type UseAdminMeta,
} from "../client/admin";
import { methodKey } from "../client/keys";
import type { AnyContract } from "../contract/defineContract";

function statesOf(results: UseQueryResult<unknown>[]): AdminMetaState[] {
  return results.map((result) => ({
    data: result.data as AdminMetaState["data"],
    error: result.error,
  }));
}

/** The mock client's `admin` member of a contract's service, on the mock's cache. */
export function mockAdminNamespace(
  contract: AnyContract,
  methods: Readonly<Record<string, object>>,
  queryClient: QueryClient,
): Readonly<Record<string, object>> {
  const useMockAdminMeta: UseAdminMeta = (queries: readonly AdminMetaQuery[], enabled: boolean) =>
    useQueries(
      {
        queries: queries.map((query) => ({
          queryKey: methodKey(query.serviceName, query.method, undefined),
          queryFn: () => query.member.call(),
          enabled,
          retry: false,
        })),
        combine: statesOf,
      },
      queryClient,
    );
  return adminNamespace(contract, methods, useMockAdminMeta);
}
