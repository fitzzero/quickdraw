import type { Socket } from "socket.io-client";
import type { QueryClient } from "@tanstack/react-query";
import type { AccessLevel, ServiceResponse } from "../shared/types";

// ============================================================================
// Socket Context Types
// ============================================================================

// QuickdrawSocketContextValue is defined at the bottom of this file
// after SubscriptionRegistry is defined

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
   * Request timeout in milliseconds (default: 10000)
   */
  timeout?: number;
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
// Service Query Hook Types
// ============================================================================

/**
 * Options for the useServiceQuery hook.
 */
export interface UseServiceQueryOptions<TResponse> {
  /**
   * Whether to automatically fetch on mount (default: true)
   */
  enabled?: boolean;
  /**
   * How long data stays fresh in milliseconds (default: 5 minutes)
   * During this time, cached data is returned without refetching.
   */
  staleTime?: number;
  /**
   * How long unused data stays in cache in milliseconds (default: 10 minutes)
   * After this time, inactive queries are garbage collected.
   * Note: TanStack Query v5 renamed this to `gcTime`.
   */
  gcTime?: number;
  /**
   * Whether to refetch when component mounts (default: true if data is stale)
   */
  refetchOnMount?: boolean | "always";
  /**
   * Whether to refetch when window regains focus (default: false)
   */
  refetchOnWindowFocus?: boolean | "always";
  /**
   * Force a fresh fetch, bypassing cache (default: false)
   * Useful when you know the cache is invalidated.
   */
  skipCache?: boolean;
  /**
   * Request timeout in milliseconds (default: 10000)
   */
  timeout?: number;
  /**
   * Callback when data is successfully fetched
   */
  onSuccess?: (data: TResponse) => void;
  /**
   * Callback on error
   */
  onError?: (error: string) => void;
  /**
   * Number of retry attempts on failure (default: 1)
   */
  retry?: boolean | number;
  /**
   * Delay between retries in milliseconds
   */
  retryDelay?: number;
}

/**
 * Return type for the useServiceQuery hook.
 */
export interface UseServiceQueryResult<TResponse> {
  /**
   * The fetched/cached data, or undefined if not yet loaded.
   */
  data: TResponse | undefined;
  /**
   * True during initial load (no cached data available).
   */
  isLoading: boolean;
  /**
   * True when any fetch is in progress (including background refetch).
   */
  isFetching: boolean;
  /**
   * True if the query has errored.
   */
  isError: boolean;
  /**
   * Error message if the query failed.
   */
  error: string | null;
  /**
   * True if the data is considered stale (past staleTime).
   */
  isStale: boolean;
  /**
   * True if the query has successfully fetched data at least once.
   */
  isSuccess: boolean;
  /**
   * Manually trigger a refetch.
   */
  refetch: () => Promise<TResponse | undefined>;
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

// ============================================================================
// Subscription Registry Types
// ============================================================================

/**
 * Tracks an active subscription with reference counting for deduplication.
 */
export interface SubscriptionEntry {
  refCount: number;
  cleanup?: () => void;
}

/**
 * Registry for tracking active subscriptions per socket instance.
 * This prevents memory leaks and race conditions with HMR/reconnects.
 */
export interface SubscriptionRegistry {
  /**
   * Get or create a subscription entry, incrementing ref count.
   * Returns true if this is a new subscription, false if joining existing.
   */
  acquire: (key: string) => { isNew: boolean; entry: SubscriptionEntry };
  
  /**
   * Release a subscription, decrementing ref count.
   * Returns true if subscription was fully released (ref count reached 0).
   */
  release: (key: string) => boolean;
  
  /**
   * Set the cleanup function for a subscription.
   */
  setCleanup: (key: string, cleanup: () => void) => void;
  
  /**
   * Clear all subscriptions (called on disconnect/socket change).
   */
  clear: () => void;
}

/**
 * Extended socket context value with subscription registry.
 */
export interface QuickdrawSocketContextValue {
  socket: Socket | null;
  isConnected: boolean;
  userId: string | null;
  serviceAccess: Record<string, AccessLevel>;
  connect: (token?: string) => void;
  disconnect: () => void;
  subscriptionRegistry: SubscriptionRegistry;
}
