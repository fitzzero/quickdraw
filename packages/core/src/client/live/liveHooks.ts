"use client";

// What the live-data hooks share: the provider's live data, the overlays of
// optimistic mutations for one service, and the user the connection acts for.

import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";
import { isRecord } from "../../protocol/guards";
import type { QuickdrawConnection } from "../connection";
import { useQuickdrawContext } from "../context";
import { overlaysOf, type OverlayView } from "../optimistic";
import { liveDataOf, type LiveData } from "./liveData";

/** The provider's connection and `QueryClient`, and their live data; `hook` names the caller in errors. */
export function useLiveData(hook: string): {
  readonly connection: QuickdrawConnection;
  readonly queryClient: QueryClient;
  readonly live: LiveData;
} {
  const { connection, queryClient } = useQuickdrawContext(hook);
  return { connection, queryClient, live: liveDataOf(connection, queryClient) };
}

/** The overlays of `service`, re-rendering when one of them changes. */
export function useOverlayView(queryClient: QueryClient, service: string): OverlayView {
  const overlays = overlaysOf(queryClient);
  const snapshot = (): OverlayView => overlays.view(service);
  return useSyncExternalStore(overlays.subscribe, snapshot, snapshot);
}

/** The user the connection acts for, from its `qd:hello`: `null` while anonymous or before the hello. */
export function useUserId(connection: QuickdrawConnection): string | null {
  const userId = (): string | null => {
    const hello: unknown = connection.getState().hello;
    return isRecord(hello) && typeof hello.userId === "string" ? hello.userId : null;
  };
  return useSyncExternalStore(connection.subscribe, userId, userId);
}
