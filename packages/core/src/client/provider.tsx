"use client";

// `QuickdrawProvider` and `useQuickdraw` (RFC 0003 section 11.1). The provider
// owns one connection (`connection.ts`) and the TanStack `QueryClient` the
// hooks cache in, and binds the connection to the client it is given, so the
// client's `call` and `prefetch` use it too. Ported from 4.1's provider
// (`legacy-src/client/QuickdrawProvider.tsx:223-437`), which held the socket
// in React state and recreated it on every token change.
//
// React's strict mode mounts effects twice. 4.1 guarded the socket with a ref
// (`legacy-src/client/QuickdrawProvider.tsx:297-298`); here the connection is
// retained by the mounted provider and closed a tick after its last release,
// so a strict-mode remount keeps the same socket instead of reconnecting.
// Nothing is cleared on a disconnect: cached data stays, and later cards
// resume live data by revision.

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
import { bindConnection } from "./createClient";
import { KEY_ROOT } from "./keys";
import { reloadOncePerSession } from "./reload";

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
   * When they change (by value), the connection reconnects with them and the
   * results the hooks cached are invalidated, so they refetch as the new caller.
   */
  readonly auth?: ConnectionAuth;
  /** The cache the hooks use. Default: a `QueryClient` the provider creates (5-minute stale time). */
  readonly queryClient?: QueryClient;
  readonly children?: React.ReactNode;
}

/** What {@link useQuickdraw} returns. */
export interface QuickdrawStatus {
  /** The provider's connection, for non-hook code such as `call`. */
  readonly connection: QuickdrawConnection;
  readonly status: ConnectionStatus;
  /** True while the connection is connected. */
  readonly isConnected: boolean;
  /** The server's `qd:hello`: its version and limits. */
  readonly hello: HelloFrame | null;
  /** The grants the server last pushed with `qd:access`, or `null` when it has pushed none. */
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
  const { client, auth, queryClient: given, children, onProtocolMismatch, ...options } = props;
  const [ownQueryClient] = React.useState(createDefaultQueryClient);
  const queryClient = given ?? ownQueryClient;
  const connection = useProviderConnection({ ...options, auth }, onProtocolMismatch);
  React.useEffect(() => connection.retain(), [connection]);
  React.useEffect(() => {
    // Results cached under other credentials may not be this caller's to see:
    // refetch them, as 4.1 did after a token change, once the connection is back.
    if (connection.setAuth(auth)) {
      void queryClient.invalidateQueries({ queryKey: [KEY_ROOT] });
    }
  }, [connection, auth, queryClient]);
  React.useEffect(() => bindConnection(client, connection), [client, connection]);
  const value = React.useMemo(() => ({ connection, queryClient }), [connection, queryClient]);
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
 * hello, the grants it pushed, why it refused the connection, and whether
 * calls are backing off after `RATE_LIMITED`.
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
      serviceAccess: state.serviceAccess,
      refusal: state.refusal,
      isRateLimited: Object.keys(state.backoff).length > 0,
    }),
    [connection, state],
  );
}
