"use client";

import * as React from "react";
import { useMutation } from "@tanstack/react-query";
import type { ServiceResponse } from "../shared/types";
import { useQuickdrawSocket } from "./QuickdrawProvider";
import type { UseServiceOptions, UseServiceResult } from "./types";

/**
 * Hook for invoking service methods via Socket.io with TanStack Query integration.
 *
 * This hook supports two usage patterns:
 *
 * 1. **Simple usage** - Just pass service/method names with explicit payload/response types:
 * ```tsx
 * const createChat = useService<{ title: string }, { id: string }>(
 *   'chatService',
 *   'createChat'
 * );
 * ```
 *
 * 2. **Type-safe usage** - Pass a service methods map for full type inference:
 * ```tsx
 * // In your app, create a typed wrapper:
 * function useTypedService<
 *   TService extends keyof ServiceMethodsMap,
 *   TMethod extends keyof ServiceMethodsMap[TService] & string,
 * >(serviceName: TService, methodName: TMethod, options?: ...) {
 *   type Methods = ServiceMethodsMap[TService];
 *   type Payload = Methods[TMethod] extends { payload: infer P } ? P : never;
 *   type Response = Methods[TMethod] extends { response: infer R } ? R : never;
 *   return useService<Payload, Response>(serviceName, methodName, options);
 * }
 * ```
 *
 * @typeParam TPayload - The payload type for the method
 * @typeParam TResponse - The response type for the method
 */
export function useService<TPayload = unknown, TResponse = unknown>(
  serviceName: string,
  methodName: string,
  options?: UseServiceOptions<TResponse>
): UseServiceResult<TPayload, TResponse> {
  const { socket, isConnected } = useQuickdrawSocket();
  const [error, setError] = React.useState<string | null>(null);

  // Store options in ref to avoid unnecessary rerenders
  const optionsRef = React.useRef(options);
  React.useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const mutation = useMutation<TResponse, Error, TPayload>({
    mutationKey: [serviceName, methodName],
    mutationFn: async (payload: TPayload): Promise<TResponse> => {
      if (!socket || !isConnected) {
        throw new Error("Socket not connected");
      }

      return new Promise<TResponse>((resolve, reject) => {
        const eventName = `${serviceName}:${methodName}`;
        const timeout = setTimeout(() => {
          reject(new Error("Request timeout"));
        }, options?.timeout ?? 10000);

        socket.emit(
          eventName,
          payload,
          (response: ServiceResponse<TResponse>) => {
            clearTimeout(timeout);

            if (response.success) {
              resolve(response.data);
            } else {
              reject(new Error(response.error));
            }
          }
        );
      });
    },
    onSuccess: (data) => {
      setError(null);
      optionsRef.current?.onSuccess?.(data);
    },
    onError: (err) => {
      const errorMessage = err.message;
      setError(errorMessage);
      optionsRef.current?.onError?.(errorMessage);
    },
    retry: options?.retry ?? false,
    retryDelay: options?.retryDelay,
  });

  return {
    mutate: mutation.mutate,
    mutateAsync: mutation.mutateAsync,
    isPending: mutation.isPending,
    isError: mutation.isError,
    error,
    data: mutation.data,
    reset: mutation.reset,
  };
}

/**
 * Simplified hook for basic service method calls.
 * Use this when you don't need the full TanStack Query mutation features.
 *
 * @example
 * ```tsx
 * const { execute, loading, error, data } = useServiceMethod<
 *   { title: string },
 *   { id: string }
 * >('chatService', 'createChat');
 *
 * const handleCreate = async () => {
 *   const result = await execute({ title: 'New Chat' });
 *   if (result) {
 *     router.push(`/chat/${result.id}`);
 *   }
 * };
 * ```
 */
export function useServiceMethod<TPayload = unknown, TResponse = unknown>(
  serviceName: string,
  methodName: string,
  options?: UseServiceOptions<TResponse>
): {
  execute: (payload: TPayload) => Promise<TResponse | null>;
  loading: boolean;
  error: string | null;
  data: TResponse | null;
  isReady: boolean;
} {
  const { socket, isConnected } = useQuickdrawSocket();
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [data, setData] = React.useState<TResponse | null>(null);

  const optionsRef = React.useRef(options);
  React.useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  const execute = React.useCallback(
    async (payload: TPayload): Promise<TResponse | null> => {
      if (!socket || !isConnected) {
        const errorMsg = "Socket not connected";
        setError(errorMsg);
        optionsRef.current?.onError?.(errorMsg);
        return null;
      }

      setLoading(true);
      setError(null);

      return new Promise<TResponse | null>((resolve) => {
        const eventName = `${serviceName}:${methodName}`;
        const timeout = setTimeout(() => {
          const errorMsg = "Request timeout";
          setError(errorMsg);
          setLoading(false);
          optionsRef.current?.onError?.(errorMsg);
          resolve(null);
        }, options?.timeout ?? 10000);

        socket.emit(
          eventName,
          payload,
          (response: ServiceResponse<TResponse>) => {
            clearTimeout(timeout);
            setLoading(false);

            if (response.success) {
              setError(null);
              setData(response.data);
              optionsRef.current?.onSuccess?.(response.data);
              resolve(response.data);
            } else {
              setError(response.error);
              optionsRef.current?.onError?.(response.error);
              resolve(null);
            }
          }
        );
      });
    },
    [socket, isConnected, serviceName, methodName, options?.timeout]
  );

  return {
    execute,
    loading,
    error,
    data,
    isReady: !!socket && isConnected,
  };
}
