import type { Socket } from "socket.io-client";
import type { QueryClient } from "@tanstack/react-query";
import type { AccessLevel, ServiceResponse } from "../shared/types";

// ============================================================================
// Socket Context Types
// ============================================================================

export interface QuickdrawSocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  userId: string | null;
  serviceAccess: Record<string, AccessLevel>;
  connect: (token?: string) => void;
  disconnect: () => void;
}

// ============================================================================
// Provider Types
// ============================================================================

export interface QuickdrawProviderProps {
  children: React.ReactNode;
  /**
   * Socket.io server URL.
   * @example "http://localhost:4000"
   */
  serverUrl: string;
  /**
   * Optional custom QueryClient instance.
   * If not provided, a default one will be created.
   */
  queryClient?: QueryClient;
  /**
   * Optional auth token to send on connection.
   */
  authToken?: string;
  /**
   * Auto-connect on mount (default: true if authToken provided)
   */
  autoConnect?: boolean;
}

// ============================================================================
// Hook Types
// ============================================================================

/**
 * Options for the useService hook.
 */
export interface UseServiceOptions<TResponse> {
  onSuccess?: (data: TResponse) => void;
  onError?: (error: string) => void;
  /**
   * TanStack Query mutation options
   */
  retry?: boolean | number;
  retryDelay?: number;
}

/**
 * Return type for the useService hook.
 */
export interface UseServiceResult<TPayload, TResponse> {
  mutate: (payload: TPayload) => void;
  mutateAsync: (payload: TPayload) => Promise<TResponse>;
  isPending: boolean;
  isError: boolean;
  error: string | null;
  data: TResponse | undefined;
  reset: () => void;
}

/**
 * Options for the useSubscription hook.
 */
export interface UseSubscriptionOptions<TData> {
  /**
   * Whether to automatically subscribe on mount (default: true)
   */
  enabled?: boolean;
  /**
   * Callback when data is received
   */
  onData?: (data: TData) => void;
  /**
   * Callback on error
   */
  onError?: (error: string) => void;
  /**
   * Required access level for subscription (default: "Read")
   */
  requiredLevel?: AccessLevel;
  /**
   * Stale time for TanStack Query cache (default: Infinity for subscriptions)
   */
  staleTime?: number;
}

/**
 * Return type for the useSubscription hook.
 */
export interface UseSubscriptionResult<TData> {
  data: TData | null;
  isLoading: boolean;
  isError: boolean;
  error: string | null;
  isSubscribed: boolean;
  subscribe: () => void;
  unsubscribe: () => void;
}

// ============================================================================
// Service Method Map Types
// ============================================================================

/**
 * Type helper for defining service methods map on the client.
 * This mirrors the server-side ServiceMethodMap.
 */
export type ClientServiceMethodMap<
  T extends Record<string, { payload: unknown; response: unknown }>,
> = T;

/**
 * Type helper for defining subscription data map.
 * Maps service names to their entity types.
 */
export type SubscriptionDataMap<T extends Record<string, unknown>> = T;

// ============================================================================
// Internal Types
// ============================================================================

export interface SocketEmitOptions {
  timeout?: number;
}

export type SocketCallback<T> = (response: ServiceResponse<T>) => void;
