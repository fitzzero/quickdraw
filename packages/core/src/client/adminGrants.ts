"use client";

// The user's grants as the admin kit's client half reads them
// (`adminMeta.ts`): the service-wide grants the server's hello and
// `qd:access` give, and the grant each service's `adminMeta` was refused
// under, so a refusal stands until that grant changes (finding F3.6).

import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { AccessLevel } from "../contract/access";
import { QuickdrawError } from "../protocol/errors";
import type { QuickdrawConnection } from "./connection";
import { serverStateOf, useQuickdrawContext } from "./context";

/** No grant at all: what a service the user holds no grant on is refused under. */
const NO_GRANT = "none";

/**
 * The grant each service's `adminMeta` was refused under, per cache: asked
 * again only once the user's grant on the service differs.
 */
const refusals = new WeakMap<QueryClient, Map<string, AccessLevel | typeof NO_GRANT>>();

export function refusalsOf(queryClient: QueryClient): Map<string, AccessLevel | typeof NO_GRANT> {
  let held = refusals.get(queryClient);
  if (held === undefined) {
    held = new Map();
    refusals.set(queryClient, held);
  }
  return held;
}

/** The user's grant on `service` now, as the connection's state holds it. */
export function grantOn(
  connection: QuickdrawConnection,
  service: string,
): AccessLevel | typeof NO_GRANT {
  const grants = connection.getState().serviceAccess;
  return grants !== null && Object.hasOwn(grants, service)
    ? (grants[service] ?? NO_GRANT)
    : NO_GRANT;
}

/** True for a refusal that stands until the user's grant changes. */
export function isRefusal(error: unknown): boolean {
  return (
    error instanceof QuickdrawError &&
    (error.code === "FORBIDDEN" || error.code === "UNAUTHENTICATED")
  );
}

/** The user's service-wide grants under the provider, `null` before the hello; none on a server. */
export function useClientAdminGrants(): Readonly<Record<string, AccessLevel>> | null {
  const { connection } = useQuickdrawContext("useAdminServices");
  return useSyncExternalStore(
    connection.subscribe,
    () => connection.getState().serviceAccess,
    () => serverStateOf(connection).serviceAccess,
  );
}
