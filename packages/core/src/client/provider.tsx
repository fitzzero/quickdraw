"use client";

// `QuickdrawProvider` and `useQuickdraw` (RFC 0003 sections 11.1 and 11.3).
// The provider owns one connection (`connection.ts`), the TanStack
// `QueryClient` the hooks cache in and that client's invalidation
// coordinator (`coordinator.ts`), and binds the connection and the
// coordinator to the client it is given, so the client's `call`, `prefetch`
// and `invalidate` use them too. Ported from 4.1's provider
// (`legacy-src/client/QuickdrawProvider.tsx:223-437`), which held the socket
// in React state and recreated it on every token change.
//
// React's strict mode mounts effects twice. 4.1 guarded the socket with a ref
// (`legacy-src/client/QuickdrawProvider.tsx:297-298`); here the connection is
// retained by the mounted provider and closed a tick after its last release,
// so a strict-mode remount keeps the same socket instead of reconnecting.
// Nothing is cleared on a disconnect: cached data stays. After a reconnect
// with the same credentials, the coordinator refetches only the queries that
// watch a topic (they missed its changes) or are stale, each after a random
// delay of up to 2 s by default (`reconnectJitterMs`), where 4.1 invalidated
// every query at once (`legacy-src/client/QuickdrawProvider.tsx:320-321`).
// The cache follows the user the server's hello names (`session.ts`):
// another user's hello empties it, and new credentials for the same user
// refetch it. New grants (`qd:access`) refetch every query, and a revoked row
// or scope (`qd:revoked`) the method queries of its service.

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import type { AccessLevel } from "../contract/access";
import type { ContractMap } from "../contract/infer";
import type { HelloFrame, ProtocolMismatch } from "../protocol/version";
import type { QuickdrawClient } from "./clientTypes";
import {
  createQuickdrawConnection,
  type ConnectionAuth,
  type ConnectionRefusal,
  type ConnectionStatus,
  type QuickdrawConnection,
  type QuickdrawConnectionOptions,
} from "./connection";
import { QuickdrawContext, useConnectionState, useQuickdrawContext } from "./context";
import { createInvalidationCoordinator, reconnectJitter } from "./coordinator";
import { bindConnection, isWatchedQuery } from "./createClient";
import { liveDataOf } from "./live/liveData";
import { reloadOncePerSession } from "./reload";
import { refetchOnAccessChanges, sessionOf } from "./session";

/** Props of {@link QuickdrawProvider}. */
export interface QuickdrawProviderProps<Contracts extends ContractMap> extends Omit<
  QuickdrawConnectionOptions,
  "auth"
> {
  /** The client from `createQuickdrawClient`; its `call` and `prefetch` use this provider's connection. */
  readonly client: QuickdrawClient<Contracts>;
  /**
   * The credentials to connect with: a token (sent as `auth.token`), handshake
   * fields, or nothing for an anonymous or cookie-authenticated connection.
   * When they change (by value), the connection reconnects with them. When
   * the server's hello then names another user, everything quickdraw cached
   * is removed, since it was read as the last user; when it names the same
   * user, it is refetched as the new credentials.
   */
  readonly auth?: ConnectionAuth;
  /** The cache the hooks use. Default: a `QueryClient` the provider creates (5-minute stale time). */
  readonly queryClient?: QueryClient;
  /**
   * After a reconnect, the longest random delay before each watched or stale
   * query is refetched, so a fleet of clients that reconnect together (a
   * server restart) does not refetch in one burst; `0` refetches them at
   * once. Default 2,000 ms. Entity rows and collections resume by revision
   * at once either way.
   */
  readonly reconnectJitterMs?: number;
  readonly children?: React.ReactNode;
}

/** What {@link useQuickdraw} returns. */
export interface QuickdrawStatus {
  /** The provider's connection, for non-hook code such as `call`. */
  readonly connection: QuickdrawConnection;
  readonly status: ConnectionStatus;
  /** True while the connection is connected. */
  readonly isConnected: boolean;
  /** The server's `qd:hello` on the current credentials: its version, limits and who the socket acts for. */
  readonly hello: HelloFrame | null;
  /**
   * The user the connection acts for, from the server's hello: `null` while
   * anonymous, and before the hello on the current credentials arrives.
   */
  readonly userId: string | null;
  /**
   * The user's service grants: from the server's hello, then from each
   * `qd:access` push; `null` before the hello on the current credentials.
   */
  readonly serviceAccess: Readonly<Record<string, AccessLevel>> | null;
  /** Why the server refused the connection, while `status` is `refused`. */
  readonly refusal: ConnectionRefusal | null;
  /** True while any kind of work backs off after a `RATE_LIMITED` answer. */
  readonly isRateLimited: boolean;
}

function createDefaultQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false } },
  });
}

/** The connection for one mounted provider: made on first render, with the props it had then. */
function useProviderConnection(
  props: Omit<QuickdrawConnectionOptions, "onProtocolMismatch">,
  onProtocolMismatch: ((mismatch: ProtocolMismatch) => void) | undefined,
): QuickdrawConnection {
  const mismatch = React.useRef(onProtocolMismatch);
  React.useEffect(() => {
    mismatch.current = onProtocolMismatch;
  }, [onProtocolMismatch]);
  const [connection] = React.useState(() =>
    createQuickdrawConnection({
      ...props,
      onProtocolMismatch: (refused) => {
        (mismatch.current ?? reloadOncePerSession)(refused);
      },
    }),
  );
  return connection;
}

function ConnectedProvider<Contracts extends ContractMap>(
  props: QuickdrawProviderProps<Contracts>,
): React.ReactElement {
  const {
    client,
    auth,
    queryClient: given,
    reconnectJitterMs,
    children,
    onProtocolMismatch,
    ...options
  } = props;
  const jitterMs = reconnectJitter("QuickdrawProvider: reconnectJitterMs", reconnectJitterMs);
  const [ownQueryClient] = React.useState(createDefaultQueryClient);
  const queryClient = given ?? ownQueryClient;
  const coordinator = React.useMemo(
    () => createInvalidationCoordinator(queryClient),
    [queryClient],
  );
  const connection = useProviderConnection({ ...options, auth }, onProtocolMismatch);
  React.useEffect(() => {
    // From now on each hello settles the cache for the user it names.
    sessionOf(connection, queryClient);
    // Before the socket connects: `qd:presence` frames can arrive before any hook asks.
    liveDataOf(connection, queryClient);
  }, [connection, queryClient]);
  React.useEffect(() => connection.retain(), [connection]);
  // Disposed a tick after the provider unmounts or takes another `QueryClient`.
  React.useEffect(() => coordinator.retain(), [coordinator]);
  React.useEffect(() => {
    // New credentials reconnect; the hello that follows decides what the cache keeps.
    connection.setAuth(auth);
  }, [connection, auth]);
  React.useEffect(
    () =>
      connection.onReconnect(() => {
        coordinator.refetchAfterReconnect({
          watched: (query) => isWatchedQuery(client, query.queryKey),
          jitterMs,
        });
      }),
    [connection, coordinator, client, jitterMs],
  );
  React.useEffect(() => refetchOnAccessChanges(connection, coordinator), [connection, coordinator]);
  React.useEffect(
    () => bindConnection(client, connection, coordinator),
    [client, connection, coordinator],
  );
  const value = React.useMemo(
    () => ({ connection, queryClient, coordinator }),
    [connection, queryClient, coordinator],
  );
  return (
    <QueryClientProvider client={queryClient}>
      <QuickdrawContext.Provider value={value}>{children}</QuickdrawContext.Provider>
    </QueryClientProvider>
  );
}

/**
 * Connects to the quickdraw server at `url` and provides the connection and
 * the `QueryClient` to the hooks of `client` below it. It renders TanStack's
 * `QueryClientProvider` itself.
 *
 * The socket options (`socketOptions`, `transports`, `binary`, `timeoutMs`)
 * are read when the provider mounts; a new `url` makes a new connection.
 * Changing `auth` reconnects with the new credentials.
 *
 * @example
 * <QuickdrawProvider client={qd} url="http://localhost:4000" auth={token}>
 *   <App />
 * </QuickdrawProvider>
 */
export function QuickdrawProvider<Contracts extends ContractMap>(
  props: QuickdrawProviderProps<Contracts>,
): React.ReactElement {
  return <ConnectedProvider key={props.url} {...props} />;
}

/**
 * The provider's connection state: whether it is connected, the server's
 * hello, who the connection acts for and their grants, why the server
 * refused the connection, and whether calls are backing off after
 * `RATE_LIMITED`.
 */
export function useQuickdraw(): QuickdrawStatus {
  const { connection } = useQuickdrawContext("useQuickdraw");
  const state = useConnectionState(connection);
  return React.useMemo(
    () => ({
      connection,
      status: state.status,
      isConnected: state.status === "connected",
      hello: state.hello,
      userId: state.hello?.userId ?? null,
      serviceAccess: state.serviceAccess,
      refusal: state.refusal,
      isRateLimited: Object.keys(state.backoff).length > 0,
    }),
    [connection, state],
  );
}
