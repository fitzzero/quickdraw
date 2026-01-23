"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ServiceResponse } from "../shared/types";
import { useQuickdrawSocket } from "./QuickdrawProvider";
import type { UseSubscriptionOptions, UseSubscriptionResult } from "./types";

/**
 * Hook for subscribing to real-time entity updates with TanStack Query integration.
 *
 * Features:
 * - Automatic subscription management
 * - TanStack Query cache integration for optimistic updates
 * - Subscription deduplication across components (via context-based registry)
 * - Automatic reconnection handling
 * - HMR/Fast Refresh safe (no module-level state)
 *
 * @typeParam TData - The entity type
 *
 * @example
 * ```tsx
 * function ChatView({ chatId }: { chatId: string }) {
 *   const { data: chat, isLoading, error } = useSubscription<Chat>(
 *     'chatService',
 *     chatId,
 *     {
 *       onData: (chat) => {
 *         console.log('Chat updated:', chat.title);
 *       },
 *     }
 *   );
 *
 *   if (isLoading) return <div>Loading...</div>;
 *   if (error) return <div>Error: {error}</div>;
 *   if (!chat) return <div>Chat not found</div>;
 *
 *   return <div>{chat.title}</div>;
 * }
 * ```
 */
export function useSubscription<TData extends { id: string }>(
  serviceName: string,
  entryId: string | null,
  options: UseSubscriptionOptions<TData> = {}
): UseSubscriptionResult<TData> {
  const { socket, isConnected, subscriptionRegistry } = useQuickdrawSocket();
  const queryClient = useQueryClient();
  const [isSubscribed, setIsSubscribed] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const {
    enabled = true,
    onData,
    onError,
    requiredLevel = "Read",
    staleTime = Infinity, // Subscriptions should stay fresh via socket updates
  } = options;

  // Subscription key for deduplication
  const subscriptionKey = entryId ? `${serviceName}:${entryId}` : null;
  const queryKey = React.useMemo(
    () => [serviceName, "subscription", entryId],
    [serviceName, entryId]
  );

  // Store callbacks in refs to avoid unnecessary effect reruns
  const onDataRef = React.useRef(onData);
  const onErrorRef = React.useRef(onError);
  React.useEffect(() => {
    onDataRef.current = onData;
    onErrorRef.current = onError;
  }, [onData, onError]);

  // Query for cache management - enabled for reactivity to setQueryData calls
  // Data comes from socket subscriptions, not from queryFn
  const query = useQuery<TData | null>({
    queryKey,
    queryFn: () => queryClient.getQueryData<TData | null>(queryKey) ?? null,
    staleTime,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    // Query is enabled so components react to setQueryData updates from other subscribers
  });

  // Handle subscription lifecycle
  React.useEffect(() => {
    if (!socket || !isConnected || !subscriptionKey || !enabled || !entryId) {
      return;
    }

    // Try to acquire subscription (with deduplication)
    const { isNew } = subscriptionRegistry.acquire(subscriptionKey);

    if (!isNew) {
      // Already subscribed by another component, just track ref count
      setIsSubscribed(true);
      return () => {
        subscriptionRegistry.release(subscriptionKey);
      };
    }

    // Create new subscription
    const subscribeEvent = `${serviceName}:subscribe`;
    const updateEvent = `${serviceName}:update:${entryId}`;

    // Handle incoming updates
    const handleUpdate = (updateData: Partial<TData>) => {
      // Check for deletion
      const asAny = updateData as { deleted?: boolean };
      if (asAny.deleted) {
        queryClient.setQueryData<TData | null>(queryKey, null);
        return;
      }

      // Merge update with existing data
      queryClient.setQueryData<TData | null>(queryKey, (oldData) => {
        if (!oldData) {
          return updateData as TData;
        }
        const merged = { ...oldData, ...updateData } as TData;
        onDataRef.current?.(merged);
        return merged;
      });
    };

    // Subscribe to updates
    socket.on(updateEvent, handleUpdate);

    // Send subscription request
    socket.emit(
      subscribeEvent,
      { entryId, requiredLevel },
      (response: ServiceResponse<TData>) => {
        if (response.success && response.data) {
          queryClient.setQueryData<TData | null>(queryKey, response.data);
          setIsSubscribed(true);
          setError(null);
          onDataRef.current?.(response.data);
        } else if (!response.success) {
          setError(response.error);
          setIsSubscribed(false);
          onErrorRef.current?.(response.error);
        }
      }
    );

    // Set cleanup function in registry
    const cleanup = () => {
      socket.off(updateEvent, handleUpdate);
      socket.emit(`${serviceName}:unsubscribe`, { entryId });
      setIsSubscribed(false);
    };

    subscriptionRegistry.setCleanup(subscriptionKey, cleanup);

    return () => {
      subscriptionRegistry.release(subscriptionKey);
    };
  }, [
    socket,
    isConnected,
    subscriptionKey,
    enabled,
    entryId,
    serviceName,
    requiredLevel,
    queryClient,
    queryKey,
    subscriptionRegistry,
  ]);

  // Manual subscribe/unsubscribe functions
  const subscribe = React.useCallback(() => {
    if (!socket || !isConnected || !entryId) return;

    socket.emit(
      `${serviceName}:subscribe`,
      { entryId, requiredLevel },
      (response: ServiceResponse<TData>) => {
        if (response.success && response.data) {
          queryClient.setQueryData<TData | null>(queryKey, response.data);
          setIsSubscribed(true);
          setError(null);
        } else if (!response.success) {
          setError(response.error);
        }
      }
    );
  }, [socket, isConnected, entryId, serviceName, requiredLevel, queryClient, queryKey]);

  const unsubscribe = React.useCallback(() => {
    if (!socket || !entryId) return;

    socket.emit(`${serviceName}:unsubscribe`, { entryId });
    setIsSubscribed(false);
  }, [socket, entryId, serviceName]);

  // Get data from query (reactive - re-renders when setQueryData is called)
  const data = query.data ?? null;

  // Check if we're waiting for the socket to connect before we can subscribe
  const isWaitingForConnection = enabled && !!entryId && (!socket || !isConnected);

  return {
    data,
    isLoading: query.isLoading || (!data && isSubscribed) || (!data && isWaitingForConnection),
    isError: !!error,
    error,
    isSubscribed,
    subscribe,
    unsubscribe,
  };
}
