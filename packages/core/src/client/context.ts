"use client";

// The React context `QuickdrawProvider` fills: its connection, the
// `QueryClient` the hooks cache in, and that client's invalidation
// coordinator. Hooks read them from here, so they follow the provider they
// are rendered under.
//
// What the hooks read of the connection, they read through React's
// `useSyncExternalStore`, whose third argument is the snapshot a server
// renders and the browser hydrates. It is the connection's state on a
// server, never its live state: the state every connection starts in (no
// socket opens on a server), or for a mock client's connection its session
// (`serverStateOf`). A boundary that hydrates after the provider connected
// (a Suspense boundary, a lazy route) then hydrates what the server
// rendered, and shows the live state in the render that follows; with the
// live state as the server snapshot, a signed-in page failed to hydrate
// (finding F3.5).

import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useSyncExternalStore } from "react";
import type { HelloFrame } from "../protocol/version";
import {
  INITIAL_CONNECTION_STATE,
  type ConnectionState,
  type QuickdrawConnection,
} from "./connection";
import type { InvalidationCoordinator } from "./coordinator";
import { awaitingHello } from "./session";

/** What `QuickdrawProvider` provides. */
export interface QuickdrawContextValue {
  readonly connection: QuickdrawConnection;
  readonly queryClient: QueryClient;
  /** The coordinator of `queryClient`, which every invalidation goes through. */
  readonly coordinator: InvalidationCoordinator;
}

export const QuickdrawContext = createContext<QuickdrawContextValue | null>(null);

/** The provider's context; throws when `user` (a hook) is rendered outside a provider. */
export function useQuickdrawContext(user: string): QuickdrawContextValue {
  const value = useContext(QuickdrawContext);
  if (value === null) {
    throw new Error(`${user} must be rendered inside a <QuickdrawProvider>`);
  }
  return value;
}

/** The state each connection is rendered with on a server, when it is not the starting state. */
const serverStates = new WeakMap<QuickdrawConnection, () => ConnectionState>();

/**
 * Makes `state` what `connection` is rendered with on a server and hydrated
 * with: a mock client's connection (`../testing/mockSession.tsx`), whose
 * session is the same on both sides.
 */
export function renderOnServerAs(
  connection: QuickdrawConnection,
  state: () => ConnectionState,
): void {
  serverStates.set(connection, state);
}

/**
 * The connection's state as a server renders it and the browser hydrates
 * it: the state every connection starts in, unless `renderOnServerAs` gave
 * another.
 */
export function serverStateOf(connection: QuickdrawConnection): ConnectionState {
  return serverStates.get(connection)?.() ?? INITIAL_CONNECTION_STATE;
}

/** The connection's state, re-rendering when it changes; on a server and while hydrating, `serverStateOf`. */
export function useConnectionState(connection: QuickdrawConnection): ConnectionState {
  const onServer = (): ConnectionState => serverStateOf(connection);
  return useSyncExternalStore(connection.subscribe, connection.getState, onServer);
}

/**
 * The hello queries run under, or `null` while they may not run. They run
 * while the connection is connected, or reconnecting with the same
 * credentials (their calls then wait in the send buffer, and nothing
 * refetches the moment it is back: the coordinator spreads the refetches
 * after a reconnect), queries are not backing off after `RATE_LIMITED`, and
 * the server's `qd:hello` on the current credentials has arrived: until it
 * names the user, a version a query sent could be answered "not modified"
 * for data the last user read (`session.ts`). Re-renders when that changes
 * and on each new hello, not on every change of the connection's state, so
 * a query hook shows the emptied cache after another user's hello.
 */
export function useQueriesHello(connection: QuickdrawConnection): HelloFrame | null {
  const readyIn = (state: ConnectionState): HelloFrame | null => {
    const open = state.status === "connected" || state.reconnecting;
    return open && state.backoff.query === undefined ? state.hello : null;
  };
  return useSyncExternalStore(
    connection.subscribe,
    () => readyIn(connection.getState()),
    () => readyIn(serverStateOf(connection)),
  );
}

/**
 * The connection's `qd:hello` on its current credentials, or `null` before
 * it arrives; re-renders on each new one. A hook that shows cached data
 * reads it so that it renders again after another user's hello emptied the
 * cache (`session.ts`): a query removed from the cache tells none of its
 * observers.
 */
export function useHello(connection: QuickdrawConnection): HelloFrame | null {
  return useSyncExternalStore(
    connection.subscribe,
    () => connection.getState().hello,
    () => serverStateOf(connection).hello,
  );
}

/**
 * True while new credentials await their hello on a cache loaded under the
 * last ones (`session.ts`): a hook then shows nothing of what is cached.
 * Re-renders when that changes.
 */
export function useAwaitingHello(
  connection: QuickdrawConnection,
  queryClient: QueryClient,
): boolean {
  const awaiting = (): boolean => awaitingHello(connection, queryClient);
  // A server renders before any hello settled a cache: nothing awaits there.
  return useSyncExternalStore(connection.subscribe, awaiting, () => false);
}
