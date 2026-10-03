"use client";

// The React context `QuickdrawProvider` fills: its connection and the
// `QueryClient` the hooks cache in. Hooks read the connection from here, so
// they follow the provider they are rendered under.

import type { QueryClient } from "@tanstack/react-query";
import { createContext, useContext, useSyncExternalStore } from "react";
import type { ConnectionState, QuickdrawConnection } from "./connection";

/** What `QuickdrawProvider` provides. */
export interface QuickdrawContextValue {
  readonly connection: QuickdrawConnection;
  readonly queryClient: QueryClient;
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

/** The connection's state, re-rendering when it changes. */
export function useConnectionState(connection: QuickdrawConnection): ConnectionState {
  return useSyncExternalStore(connection.subscribe, connection.getState, connection.getState);
}

/**
 * Whether queries may run: the connection is connected and queries are not
 * backing off after `RATE_LIMITED`. Re-renders only when that changes, not on
 * every change of the connection's state.
 */
export function useQueriesLive(connection: QuickdrawConnection): boolean {
  const live = (): boolean => {
    const state = connection.getState();
    return state.status === "connected" && state.backoff.query === undefined;
  };
  return useSyncExternalStore(connection.subscribe, live, live);
}
