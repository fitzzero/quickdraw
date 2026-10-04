"use client";

// What the live-data hooks share: the provider's live data, the overlays of
// optimistic mutations for one service, and the user the connection acts for.

import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import type { QuickdrawConnection } from "../connection";
import { serverStateOf, useAwaitingHello, useHello, useQuickdrawContext } from "../context";
import { NO_OVERLAYS, overlaysOf, type OverlayView } from "../optimistic";
import { userOf } from "../session";
import { liveDataOf, type LiveData } from "./liveData";

/**
 * The provider's connection and `QueryClient`, and their live data; `hook`
 * names the caller in errors. The hook renders again on each new hello, so
 * after another user's hello emptied the cache it shows the new entries
 * (`../session.ts`).
 */
export function useLiveData(hook: string): {
  readonly connection: QuickdrawConnection;
  readonly queryClient: QueryClient;
  readonly live: LiveData;
  /**
   * True while new credentials await their hello on a cache loaded under the
   * last ones: the hook shows nothing of what is cached (`../session.ts`).
   */
  readonly awaiting: boolean;
} {
  const { connection, queryClient } = useQuickdrawContext(hook);
  useHello(connection);
  const awaiting = useAwaitingHello(connection, queryClient);
  return { connection, queryClient, live: liveDataOf(connection, queryClient), awaiting };
}

const noOverlays = (): OverlayView => NO_OVERLAYS;

/** The overlays of `service`, re-rendering when one of them changes; none on a server and while hydrating. */
export function useOverlayView(queryClient: QueryClient, service: string): OverlayView {
  const overlays = overlaysOf(queryClient);
  const snapshot = (): OverlayView => overlays.view(service);
  return useSyncExternalStore(overlays.subscribe, snapshot, noOverlays);
}

/**
 * The user the connection acts for, from its `qd:hello`: `null` while
 * anonymous or before the hello; on a server and while hydrating, the one
 * its server state names (`../context.ts`).
 */
export function useUserId(connection: QuickdrawConnection): string | null {
  return useSyncExternalStore(
    connection.subscribe,
    () => userOf(connection.getState().hello),
    () => userOf(serverStateOf(connection).hello),
  );
}
