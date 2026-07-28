"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CollectionDelta, CollectionSnapshotResponse, ServiceResponse } from "../shared/types";
import { collectionRoom } from "../shared/types";
import {
  applyDeltas,
  applyDelta,
  applyPage,
  applySnapshot,
  type CollectionCacheEntry,
} from "./collectionCache";
import { useQuickdrawSocket } from "./QuickdrawProvider";
import type { SubscriptionEntry, UseCollectionOptions, UseCollectionResult } from "./types";

const RESET_DEBOUNCE_MS = 100;
const REQUEST_TIMEOUT_MS = 10_000;

/** Cache value under [service, "collection", name, scopeId]. */
interface CollectionQueryState<TItem extends { id: string }> {
  entry: CollectionCacheEntry<TItem> | null;
  error: string | null;
}

const EMPTY_STATE: CollectionQueryState<{ id: string }> = { entry: null, error: null };

/**
 * Shared per-subscription pipeline, stashed on the registry entry by the
 * owning component so every component on the same key drives one snapshot
 * and one loadMore at a time.
 */
interface CollectionController {
  requestSnapshot: () => Promise<void>;
  loadMore: () => Promise<void>;
}

/**
 * Hook for subscribing to a server-declared collection: a scope-keyed,
 * live-updating list (`defineCollection` server-side).
 *
 * The initial snapshot arrives via `{service}:collection:subscribe`;
 * `added`/`updated`/`removed` deltas stream to the scope room and merge
 * id-keyed with per-item last-writer-wins; `reset` deltas trigger a
 * debounced re-snapshot. Reconnects re-snapshot automatically (the same
 * registry cycle entity subscriptions use), pruning rows deleted while
 * offline when the server provides membership `ids`.
 *
 * Subscriptions are deduped across components by scope; pagination reuses
 * the subscribe event with a cursor via `loadMore`.
 *
 * @example
 * ```tsx
 * function ChatWindow({ chatId }: { chatId: string }) {
 *   const { items: messages, loadMore, hasMore } = useCollection<MessageDTO>(
 *     "messageService",
 *     "byChat",
 *     chatId,
 *     { compare: (a, b) => a.createdAt.localeCompare(b.createdAt) },
 *   );
 *   // messages update live; loadMore() pages in older history
 * }
 * ```
 */
export function useCollection<TItem extends { id: string }>(
  serviceName: string,
  collection: string,
  scopeId: string | null,
  options?: UseCollectionOptions<TItem>,
): UseCollectionResult<TItem> {
  const { socket, isConnected, subscriptionRegistry } = useQuickdrawSocket();
  const queryClient = useQueryClient();
  const [isLoadingMore, setIsLoadingMore] = React.useState(false);

  const {
    enabled = true,
    limit,
    compare,
    insertPosition = "end",
    onDelta,
    onError,
  } = options ?? {};

  // Callbacks and merge options read through refs so the owner closure and
  // per-component listeners never need re-subscribing on identity changes.
  const onDeltaRef = React.useRef(onDelta);
  const onErrorRef = React.useRef(onError);
  const insertPositionRef = React.useRef(insertPosition);
  React.useEffect(() => {
    onDeltaRef.current = onDelta;
    onErrorRef.current = onError;
    insertPositionRef.current = insertPosition;
  }, [onDelta, onError, insertPosition]);

  // Registry key doubles as the delta event name (== room name)
  const subscriptionKey = scopeId ? collectionRoom(serviceName, collection, scopeId) : null;
  const queryKey = React.useMemo(
    () => [serviceName, "collection", collection, scopeId],
    [serviceName, collection, scopeId],
  );

  // Reactive cache read — data is written via setQueryData by the owner.
  // initialData seeds the cache without an initial fetch, so a snapshot ack
  // landing between mount and a queryFn resolution can never be clobbered.
  const query = useQuery<CollectionQueryState<TItem>>({
    queryKey,
    queryFn: () =>
      queryClient.getQueryData<CollectionQueryState<TItem>>(queryKey) ??
      (EMPTY_STATE as CollectionQueryState<TItem>),
    initialData: () => EMPTY_STATE as CollectionQueryState<TItem>,
    staleTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

  // The registry entry this component holds (owner or joiner) — the shared
  // controller for refresh/loadMore lives on it.
  const regEntryRef = React.useRef<SubscriptionEntry | null>(null);

  React.useEffect(() => {
    if (!socket || !isConnected || !enabled || !subscriptionKey || !scopeId) {
      return;
    }

    const { isNew, entry: regEntry } = subscriptionRegistry.acquire(subscriptionKey);
    regEntryRef.current = regEntry;

    if (!isNew) {
      return () => {
        regEntryRef.current = null;
        subscriptionRegistry.release(subscriptionKey);
      };
    }

    // ---- Owner path: this closure runs the shared pipeline for the key.
    // It stays alive as long as any component holds the subscription.
    const eventName = subscriptionKey;
    let disposed = false;
    let snapshotInFlight = false;
    let buffered: CollectionDelta<TItem>[] = [];
    let inFlightSnapshot: Promise<void> | null = null;
    let inFlightLoadMore: Promise<void> | null = null;
    let resetTimer: ReturnType<typeof setTimeout> | null = null;

    const readState = (): CollectionQueryState<TItem> =>
      queryClient.getQueryData<CollectionQueryState<TItem>>(queryKey) ??
      (EMPTY_STATE as CollectionQueryState<TItem>);

    const writeState = (state: CollectionQueryState<TItem>): void => {
      queryClient.setQueryData(queryKey, state);
    };

    const emitSubscribe = (
      cursor: string | null,
    ): Promise<ServiceResponse<CollectionSnapshotResponse<TItem>>> =>
      new Promise((resolve) => {
        let settled = false;
        const timeoutId = setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve({ success: false, error: "Request timeout" });
          }
        }, REQUEST_TIMEOUT_MS);

        socket.emit(
          `${serviceName}:collection:subscribe`,
          {
            collection,
            scopeId,
            ...(cursor === null ? {} : { cursor }),
            ...(limit === undefined ? {} : { limit }),
          },
          (response: ServiceResponse<CollectionSnapshotResponse<TItem>>) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeoutId);
            resolve(response);
          },
        );
      });

    const scheduleReset = (): void => {
      if (resetTimer || disposed) return;
      resetTimer = setTimeout(() => {
        resetTimer = null;
        void requestSnapshot();
      }, RESET_DEBOUNCE_MS);
    };

    const requestSnapshot = (): Promise<void> => {
      if (inFlightSnapshot) return inFlightSnapshot;
      snapshotInFlight = true;
      buffered = [];
      inFlightSnapshot = emitSubscribe(null).then((response) => {
        snapshotInFlight = false;
        inFlightSnapshot = null;
        const raced = buffered;
        buffered = [];
        if (disposed) return;

        if (response.success) {
          const prev = readState();
          const fresh = applySnapshot(prev.entry, response.data);
          // Deltas that raced the snapshot apply on top of it (rev LWW)
          const { entry, resetRequested } = applyDeltas(fresh, raced, {
            insertPosition: insertPositionRef.current,
          });
          writeState({ entry, error: null });
          if (resetRequested) scheduleReset();
        } else {
          // Keep stale data; surface the error
          const prev = readState();
          writeState({ entry: prev.entry, error: response.error });
        }
      });
      return inFlightSnapshot;
    };

    const loadMore = (): Promise<void> => {
      if (inFlightLoadMore) return inFlightLoadMore;
      const cursor = readState().entry?.nextCursor ?? null;
      if (cursor === null) return Promise.resolve();

      inFlightLoadMore = emitSubscribe(cursor).then((response) => {
        inFlightLoadMore = null;
        if (disposed) return;

        const prev = readState();
        if (response.success) {
          writeState({ entry: applyPage(prev.entry, response.data), error: prev.error });
        } else {
          writeState({ entry: prev.entry, error: response.error });
        }
      });
      return inFlightLoadMore;
    };

    const handleDelta = (delta: CollectionDelta<TItem>): void => {
      if (delta.type === "reset") {
        scheduleReset();
        return;
      }
      if (snapshotInFlight) {
        buffered.push(delta);
        return;
      }
      const prev = readState();
      const { entry } = applyDelta(prev.entry, delta, {
        insertPosition: insertPositionRef.current,
      });
      if (entry !== prev.entry) {
        writeState({ entry, error: prev.error });
      }
    };

    const controller: CollectionController = { requestSnapshot, loadMore };
    regEntry.controller = controller;

    socket.on(eventName, handleDelta);
    void requestSnapshot();

    subscriptionRegistry.setCleanup(subscriptionKey, () => {
      disposed = true;
      if (resetTimer) clearTimeout(resetTimer);
      socket.off(eventName, handleDelta);
      socket.emit(`${serviceName}:collection:unsubscribe`, { collection, scopeId });
      regEntry.controller = undefined;
    });

    return () => {
      regEntryRef.current = null;
      subscriptionRegistry.release(subscriptionKey);
    };
  }, [
    socket,
    isConnected,
    enabled,
    subscriptionKey,
    scopeId,
    serviceName,
    collection,
    limit,
    queryClient,
    queryKey,
    subscriptionRegistry,
  ]);

  // Per-component onDelta listener (cache application happens once, in the
  // owner). Attached only when the component asked for it.
  const wantsDelta = !!onDelta;
  React.useEffect(() => {
    if (!socket || !isConnected || !enabled || !subscriptionKey || !wantsDelta) {
      return;
    }
    const listener = (delta: CollectionDelta<TItem>): void => {
      onDeltaRef.current?.(delta);
    };
    socket.on(subscriptionKey, listener);
    return () => {
      socket.off(subscriptionKey, listener);
    };
  }, [socket, isConnected, enabled, subscriptionKey, wantsDelta]);

  const state = query.data ?? (EMPTY_STATE as CollectionQueryState<TItem>);
  const entry = state.entry;

  // Per-component error callback, fired on shared error transitions
  React.useEffect(() => {
    if (state.error) {
      onErrorRef.current?.(state.error);
    }
  }, [state.error]);

  const getController = (): CollectionController | null =>
    (regEntryRef.current?.controller as CollectionController | undefined) ?? null;
  const getControllerRef = React.useRef(getController);
  getControllerRef.current = getController;

  const refresh = React.useCallback(async (): Promise<void> => {
    await getControllerRef.current()?.requestSnapshot();
  }, []);

  const loadMore = React.useCallback(async (): Promise<void> => {
    const controller = getControllerRef.current();
    if (!controller) return;
    setIsLoadingMore(true);
    try {
      await controller.loadMore();
    } finally {
      setIsLoadingMore(false);
    }
  }, []);

  const items = React.useMemo(() => {
    if (!entry) return [] as TItem[];
    const list = entry.order
      .map((id) => entry.byId[id])
      .filter((item): item is TItem => item !== undefined);
    if (compare) list.sort(compare);
    return list;
  }, [entry, compare]);

  const byId = React.useMemo(() => {
    const map = new Map<string, TItem>();
    if (entry) {
      for (const id of entry.order) {
        const item = entry.byId[id];
        if (item !== undefined) map.set(id, item);
      }
    }
    return map as ReadonlyMap<string, TItem>;
  }, [entry]);

  const active = enabled && !!scopeId;

  return {
    items,
    byId,
    totalCount: entry?.totalCount ?? null,
    isLoading: active && !entry && !state.error,
    isError: state.error !== null,
    error: state.error,
    hasMore: (entry?.nextCursor ?? null) !== null,
    isLoadingMore,
    loadMore,
    refresh,
  };
}
