// How a query hook (and a prefetch) fetches: send the version of the cached
// result, keep the cached result when the server answers "not modified", and
// remember the version of a new result (`versions.ts`).
//
// "Not modified" says the copy the caller holds is current. If that copy is
// no longer in the cache when the answer arrives (it was removed, reset or
// replaced meanwhile), there is nothing to keep, so the call is made once
// more without a version; a query never resolves to `undefined` that way.
//
// A result that holds rows of its service remembers when its read was sent,
// on the overlay store's clock (`optimistic.ts`): it holds every mutation
// that had finished by then, so their overlays are not shown over it.
//
// Nothing is read before the server's hello on the connection's current
// credentials has arrived: the hello says which user the cache may hold data
// for, and empties it when that is another user than it was loaded for
// (`session.ts`). A version read from the cache before then could belong to
// the last user's data, which the server would answer "not modified" for.
//
// A read refused with `FORBIDDEN`, `UNAUTHENTICATED` or `NOT_FOUND` takes the
// cached result out of the query, so `data` never holds what the user may no
// longer read beside the error (TanStack keeps the last data on an error).
//
// React-free: it reads the cache through the `QueryClient` it is given.

import type { QueryClient } from "@tanstack/react-query";
import type { MethodOutput } from "../contract/methods";
import { QuickdrawError } from "../protocol/errors";
import { call, isNotModified, type CallRequest } from "./call";
import type { QuickdrawConnection } from "./connection";
import type { MethodQueryKey } from "./keys";
import { overlaysOf } from "./optimistic";
import { rowShapeOf } from "./overlayRows";
import { rememberReadAt, rememberVersion, versionOf } from "./versions";

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
 * Resolves once the connection holds the server's hello on its current
 * credentials, once its socket stops trying to connect (the call then fails
 * as it would), or as soon as `signal` aborts. Resolving takes a microtask,
 * so whatever the hello does to the cache (`session.ts`) is done before the
 * read looks at the cache.
 */
async function helloKnown(
  connection: QuickdrawConnection,
  signal: AbortSignal | undefined,
): Promise<void> {
  const ready = (): boolean =>
    connection.getState().hello !== null || !connection.socket.active || signal?.aborted === true;
  if (ready()) {
    return;
  }
  await new Promise<void>((resolve) => {
    let stop = (): void => undefined;
    const check = (): void => {
      if (ready()) {
        stop();
        signal?.removeEventListener("abort", check);
        resolve();
      }
    };
    stop = connection.subscribe(check);
    signal?.addEventListener("abort", check, { once: true });
  });
}

/** The codes that say the caller may not have the result, or there is none: its cached data goes. */
const REFUSALS: ReadonlySet<string> = new Set(["FORBIDDEN", "UNAUTHENTICATED", "NOT_FOUND"]);

/** Takes the cached result out of the query of `key`: its read was refused. */
function forgetResult(queryClient: QueryClient, key: MethodQueryKey): void {
  const cached = queryClient.getQueryCache().find({ queryKey: key, exact: true });
  if (cached !== undefined && cached.state.data !== undefined) {
    cached.setState({ ...cached.state, data: undefined });
  }
}

async function fetchShown<Output>(
  connection: QuickdrawConnection,
  queryClient: QueryClient,
  query: MethodQuery,
  signal: AbortSignal | undefined,
): Promise<Output> {
  if (rowShapeOf(query.output) === undefined) {
    return await fetchVersioned(connection, queryClient, query, signal);
  }
  const sentAt = overlaysOf(queryClient).now();
  const data = await fetchVersioned<Output>(connection, queryClient, query, signal);
  rememberReadAt(data, sentAt);
  return data;
}

/**
 * Fetches a query's result for `queryClient`'s cache, once the server's
 * hello has named the user: sends the version of the cached result as `v`,
 * resolves with the cached result itself when the server answers "not
 * modified", and calls once more without a version when that result left
 * the cache meanwhile. A refusal (`FORBIDDEN`, `UNAUTHENTICATED`,
 * `NOT_FOUND`) also takes the cached result out of the query.
 */
export async function fetchMethodQuery<Output>(
  connection: QuickdrawConnection,
  queryClient: QueryClient,
  query: MethodQuery,
  signal?: AbortSignal,
): Promise<Output> {
  await helloKnown(connection, signal);
  try {
    return await fetchShown<Output>(connection, queryClient, query, signal);
  } catch (error) {
    if (error instanceof QuickdrawError && REFUSALS.has(error.code)) {
      forgetResult(queryClient, query.key);
    }
    throw error;
  }
}
