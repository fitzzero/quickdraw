"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ServiceResponse } from "../shared/types";
import { useQuickdrawSocket } from "./QuickdrawProvider";
import type { UseSubscriptionOptions, UseSubscriptionResult } from "./types";

// Global subscription state for deduplication
const activeSubscriptions = new Map<
  string,
  {
    refCount: number;
    cleanup?: () => void;
  }
>();

/**
 * Hook for subscribing to real-time entity updates with TanStack Query integration.
 *
 * Features:
 * - Automatic subscription management
 * - TanStack Query cache integration for optimistic updates
 * - Subscription deduplication across components
 * - Automatic reconnection handling
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
  const { socket, isConnected } = useQuickdrawSocket();
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
  const queryKey = [serviceName, "subscription", entryId];

  // Store callbacks in refs to avoid unnecessary effect reruns
  const onDataRef = React.useRef(onData);
  const onErrorRef = React.useRef(onError);
  React.useEffect(() => {
    onDataRef.current = onData;
    onErrorRef.current = onError;
  }, [onData, onError]);

  // Query for initial data and cache management
  const query = useQuery<TData | null>({
    queryKey,
    queryFn: async () => {
      // Data is populated via subscription, not direct fetch
      return null;
    },
    enabled: false, // We manage data via socket
    staleTime,
  });

  // Handle subscription lifecycle
  React.useEffect(() => {
    if (!socket || !isConnected || !subscriptionKey || !enabled || !entryId) {
      return;
    }

    // Check if already subscribed (deduplication)
    const existing = activeSubscriptions.get(subscriptionKey);
    if (existing) {
      existing.refCount++;
      setIsSubscribed(true);
      return () => {
        existing.refCount--;
        if (existing.refCount === 0) {
          existing.cleanup?.();
          activeSubscriptions.delete(subscriptionKey);
        }
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

    // Cleanup function
    const cleanup = () => {
      socket.off(updateEvent, handleUpdate);
      socket.emit(`${serviceName}:unsubscribe`, { entryId });
      setIsSubscribed(false);
    };

    // Track subscription
    activeSubscriptions.set(subscriptionKey, {
      refCount: 1,
      cleanup,
    });

    return () => {
      const sub = activeSubscriptions.get(subscriptionKey);
      if (sub) {
        sub.refCount--;
        if (sub.refCount === 0) {
          sub.cleanup?.();
          activeSubscriptions.delete(subscriptionKey);
        }
      }
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

  // Get current data from query cache
  const data = queryClient.getQueryData<TData | null>(queryKey) ?? null;

  return {
    data,
    isLoading: query.isLoading || (!data && isSubscribed),
    isError: !!error,
    error,
    isSubscribed,
    subscribe,
    unsubscribe,
  };
}
