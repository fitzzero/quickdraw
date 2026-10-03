// How a query hook (and a prefetch) fetches: send the version of the cached
// result, keep the cached result when the server answers "not modified", and
// remember the version of a new result (`versions.ts`).
//
// "Not modified" says the copy the caller holds is current. If that copy is
// no longer in the cache when the answer arrives (it was removed, reset or
// replaced meanwhile), there is nothing to keep, so the call is made once
// more without a version; a query never resolves to `undefined` that way.
//
// A result that holds rows of its service tells the overlay store which rows
// it read and when the read was sent (`optimistic.ts`): the server's data for
// those rows now includes every mutation that had finished by then.
//
// React-free: it reads the cache through the `QueryClient` it is given.

import type { QueryClient } from "@tanstack/react-query";
import type { MethodOutput } from "../contract/methods";
import { QuickdrawError } from "../protocol/errors";
import { call, isNotModified, type CallRequest } from "./call";
import type { QuickdrawConnection } from "./connection";
import type { MethodQueryKey } from "./keys";
import { overlaysOf, rowIdsOf, rowShapeOf } from "./optimistic";
import { rememberVersion, versionOf } from "./versions";

/** A query to fetch: the call, the key its result is cached under, and the method's output. */
export interface MethodQuery extends Omit<CallRequest, "v" | "signal" | "kind"> {
  readonly key: MethodQueryKey;
  /** The contract's `output`, which says whether the result holds rows of the service. */
  readonly output?: MethodOutput;
}

async function fetchFresh<Output>(
  connection: QuickdrawConnection,
  query: MethodQuery,
  signal: AbortSignal | undefined,
): Promise<Output> {
  const result = await call<Output>(connection, { ...query, kind: "query", signal });
  if (isNotModified(result)) {
    throw new QuickdrawError(
      "INTERNAL",
      `${query.service}.${query.method} answered not modified to a call that sent no version`,
    );
  }
  rememberVersion(result.d, result.v);
  return result.d;
}

async function fetchVersioned<Output>(
  connection: QuickdrawConnection,
  queryClient: QueryClient,
  query: MethodQuery,
  signal: AbortSignal | undefined,
): Promise<Output> {
  const v = versionOf(queryClient.getQueryData(query.key));
  if (v === undefined) {
    return fetchFresh(connection, query, signal);
  }
  const result = await call<Output>(connection, { ...query, kind: "query", signal, v });
  if (!isNotModified(result)) {
    rememberVersion(result.d, result.v);
    return result.d;
  }
  const cached = queryClient.getQueryData<Output>(query.key);
  if (cached !== undefined && versionOf(cached) === v) {
    return cached;
  }
  return fetchFresh(connection, query, signal);
}

/**
 * Fetches a query's result for `queryClient`'s cache: sends the version of
 * the cached result as `v`, resolves with the cached result itself when the
 * server answers "not modified", and calls once more without a version when
 * that result left the cache meanwhile.
 */
export async function fetchMethodQuery<Output>(
  connection: QuickdrawConnection,
  queryClient: QueryClient,
  query: MethodQuery,
  signal?: AbortSignal,
): Promise<Output> {
  const shape = rowShapeOf(query.output);
  if (shape === undefined) {
    return fetchVersioned(connection, queryClient, query, signal);
  }
  const overlays = overlaysOf(queryClient);
  const sentAt = overlays.now();
  const data = await fetchVersioned<Output>(connection, queryClient, query, signal);
  overlays.read(query.service, rowIdsOf(shape, data), sentAt);
  return data;
}
