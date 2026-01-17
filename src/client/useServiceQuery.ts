"use client";

import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { ServiceResponse } from "../shared/types";
import { useQuickdrawSocket } from "./QuickdrawProvider";
import type { UseServiceQueryOptions, UseServiceQueryResult } from "./types";

/**
 * Hook for querying service methods via Socket.io with TanStack Query integration.
 *
 * Use this hook for **read operations** that benefit from caching and deduplication.
 * For mutations (create/update/delete), use `useService` instead.
 *
 * Features:
 * - Automatic caching with configurable stale time
 * - Request deduplication (multiple components calling same query share one request)
 * - Background refetching when data becomes stale
 * - Automatic refetch on reconnect
 *
 * @typeParam TPayload - The payload type for the method
 * @typeParam TResponse - The response type for the method
 *
 * @example
 * ```tsx
 * // Simple usage - auto-fetches on mount
 * const { data: expenses, isLoading } = useServiceQuery(
 *   'expenseService',
 *   'listExpenses',
 *   { pageSize: 100 }
 * );
 *
 * // With options - conditional fetching
 * const { data, refetch } = useServiceQuery(
 *   'expenseService',
 *   'listExpenses',
 *   { accountId: selectedAccount },
 *   {
 *     enabled: !!userId,
 *     staleTime: 5 * 60 * 1000, // 5 minutes
 *   }
 * );
 *
 * // Force fresh data (bypass cache)
 * const { data } = useServiceQuery(
 *   'expenseService',
 *   'listExpenses',
 *   payload,
 *   { skipCache: true }
 * );
 * ```
 */
export function useServiceQuery<TPayload = unknown, TResponse = unknown>(
  serviceName: string,
  methodName: string,
  payload: TPayload,
  options?: UseServiceQueryOptions<TResponse>
): UseServiceQueryResult<TResponse> {
  const { socket, isConnected } = useQuickdrawSocket();
  const queryClient = useQueryClient();
  const [error, setError] = React.useState<string | null>(null);

  // Store options in ref to avoid unnecessary effect reruns
  const optionsRef = React.useRef(options);
  React.useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  // Destructure options with defaults
  const {
    enabled = true,
    staleTime = 5 * 60 * 1000, // 5 minutes default
    gcTime = 10 * 60 * 1000, // 10 minutes default
    refetchOnMount = true,
    refetchOnWindowFocus = false,
    skipCache = false,
    timeout = 10000,
    retry = 1,
    retryDelay,
  } = options ?? {};

  // Create stable query key based on service, method, and payload
  // Using JSON.stringify ensures same payload = same cache entry
  const queryKey = React.useMemo(
    () => [serviceName, methodName, JSON.stringify(payload)],
    [serviceName, methodName, payload]
  );

  // Query function that calls the service via socket
  const queryFn = React.useCallback(async (): Promise<TResponse> => {
    if (!socket || !isConnected) {
      throw new Error("Socket not connected");
    }

    return new Promise<TResponse>((resolve, reject) => {
      const eventName = `${serviceName}:${methodName}`;
      const timeoutId = setTimeout(() => {
        reject(new Error("Request timeout"));
      }, timeout);

      socket.emit(
        eventName,
        payload,
        (response: ServiceResponse<TResponse>) => {
          clearTimeout(timeoutId);

          if (response.success) {
            resolve(response.data);
          } else {
            reject(new Error(response.error));
          }
        }
      );
    });
  }, [socket, isConnected, serviceName, methodName, payload, timeout]);

  // Handle skipCache by invalidating before query runs
  React.useEffect(() => {
    if (skipCache && enabled) {
      queryClient.invalidateQueries({ queryKey });
    }
  }, [skipCache, enabled, queryClient, queryKey]);

  const query = useQuery<TResponse, Error>({
    queryKey,
    queryFn,
    enabled: enabled && !!socket && isConnected,
    staleTime,
    gcTime,
    refetchOnMount,
    refetchOnWindowFocus,
    retry,
    retryDelay,
  });

  // Handle success/error callbacks
  React.useEffect(() => {
    if (query.isSuccess && query.data !== undefined) {
      setError(null);
      optionsRef.current?.onSuccess?.(query.data);
    }
  }, [query.isSuccess, query.data]);

  React.useEffect(() => {
    if (query.isError && query.error) {
      const errorMessage = query.error.message;
      setError(errorMessage);
      optionsRef.current?.onError?.(errorMessage);
    }
  }, [query.isError, query.error]);

  // Create stable refetch function
  const refetch = React.useCallback(async (): Promise<TResponse | undefined> => {
    const result = await query.refetch();
    return result.data;
  }, [query]);

  // Memoize return object to prevent new references on every render
  return React.useMemo(
    () => ({
      data: query.data,
      isLoading: query.isLoading,
      isFetching: query.isFetching,
      isError: query.isError,
      error,
      isStale: query.isStale,
      isSuccess: query.isSuccess,
      refetch,
    }),
    [
      query.data,
      query.isLoading,
      query.isFetching,
      query.isError,
      query.isStale,
      query.isSuccess,
      error,
      refetch,
    ]
  );
}
