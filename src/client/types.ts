import type { Socket } from "socket.io-client";
import type { QueryClient } from "@tanstack/react-query";
import type {
  AccessLevel,
  CollectionDelta,
  QuickdrawEventMap,
  ServiceResponse,
} from "../shared/types";

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
  /**
   * Send cookies with cross-origin socket.io requests (default: true).
   * Required for httpOnly cookie-based authentication.
   */
  withCredentials?: boolean;
  /**
   * Custom Socket.io path (default: "/socket.io").
   * Needed when the server sits behind a path-rewriting proxy — e.g.
   * Discord Activities route everything through "/.proxy", so the client
   * must connect with path "/.proxy/api/socket.io".
   */
  socketPath?: string;
  /**
   * What to do with TanStack Query caches when the socket reconnects.
   *
   * Subscriptions and collections heal themselves on reconnect
   * (re-subscribe / re-snapshot), but plain `useServiceQuery` reads keep
   * stale data — room events emitted during the outage are gone for good.
   * `"invalidate-queries"` (the default) invalidates all queries on
   * reconnect so active reads refetch. Set `"none"` to opt out.
   *
   * @default "invalidate-queries"
   */
  reconnectBehavior?: "invalidate-queries" | "none";
}

// ============================================================================
// Hook Types
// ============================================================================

/**
 * Return type for the useChannelSend hook.
 */
export interface UseChannelSendResult<TPayload> {
  /**
   * Send a fire-and-forget channel message. No ack, no response; dropped
   * silently if the socket is not connected (channels tolerate loss by design).
   */
  send: (payload: TPayload) => void;
  /** True when the socket is connected and sends will go out. */
  isReady: boolean;
}

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
  /**
   * Re-fetch entity data through the batcher when the tab becomes visible,
   * catching any updates that may have been missed while the tab was hidden.
   *
   * Only one visibility listener is created per unique subscription
   * (deduplicated by the subscription registry), so multiple components
   * subscribing to the same entity won't cause redundant fetches.
   *
   * @default false
   */
  refetchOnWindowFocus?: boolean;
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
// Room Events Hook Types
// ============================================================================

/**
 * Options for the useRoomEvents hook.
 */
export interface UseRoomEventsOptions {
  /**
   * Whether to listen for events (default: true).
   * Set to false to temporarily disable all listeners.
   */
  enabled?: boolean;
}

/**
 * Handler map for useRoomEvents, typed via the augmentable
 * `QuickdrawEventMap`: known event names get their mapped payload type
 * (with autocomplete), unknown names degrade to the untyped handler shape.
 */
export type QuickdrawRoomEventHandlers = {
  [E in keyof QuickdrawEventMap]?: (data: QuickdrawEventMap[E]) => void;
} & {
  [event: string]: ((data: never) => void) | undefined;
};

// ============================================================================
// Collection Hook Types
// ============================================================================

/**
 * Options for the useCollection hook.
 */
export interface UseCollectionOptions<TItem extends { id: string }> {
  /** Whether to subscribe (default: true). */
  enabled?: boolean;
  /** Snapshot page size. Default comes from the server definition. */
  limit?: number;
  /**
   * Client-side ordering. Omit to keep server snapshot order (new `added`
   * items land per `insertPosition`). Should be referentially stable.
   */
  compare?: (a: TItem, b: TItem) => number;
  /** Where `added` items land when no `compare` is set. Default "end". */
  insertPosition?: "start" | "end";
  /** Called for every delta received (informational; cache updates are automatic). */
  onDelta?: (delta: CollectionDelta<TItem>) => void;
  /** Called when a snapshot or page request fails. */
  onError?: (error: string) => void;
}

/**
 * Return type for the useCollection hook.
 */
export interface UseCollectionResult<TItem> {
  /** Ordered, deduped items of the scope. */
  items: TItem[];
  byId: ReadonlyMap<string, TItem>;
  /** Server-reported scope size (null before the first snapshot). */
  totalCount: number | null;
  isLoading: boolean;
  isError: boolean;
  error: string | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  /** Fetch the next page (cursor reuse of the subscribe event). */
  loadMore: () => Promise<void>;
  /** Manual re-snapshot (also what `reset` deltas trigger, debounced 100ms). */
  refresh: () => Promise<void>;
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
  /**
   * Socket event names that should trigger an automatic refetch.
   * When any of these events fire on the socket, the query is refetched.
   * Useful for keeping list queries in sync with real-time changes.
   *
   * Rapid-fire events within the same 100ms window are debounced into a single refetch.
   *
   * @example
   * ```tsx
   * // Refetch the task list when tasks are created, deleted, or change status
   * useServiceQuery("taskService", "listTasks", { projectId }, {
   *   invalidateOn: ["task:created", "task:deleted", "task:statusUpdate"],
   * });
   * ```
   */
  invalidateOn?: string[];
  /**
   * Refetch on a fixed interval (milliseconds), passed through to TanStack
   * Query. `false`/undefined disables interval refetching.
   */
  refetchInterval?: number | false;
  /**
   * Continue interval refetching while the tab is in the background.
   * Only meaningful with `refetchInterval`.
   */
  refetchIntervalInBackground?: boolean;
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
  /**
   * Shared per-subscription state slot. The first acquirer (the owner) may
   * stash a controller object here so later acquirers of the same key can
   * drive the shared pipeline (used by useCollection for snapshot/loadMore
   * dedup across components).
   */
  controller?: unknown;
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
 * Callback for a batched subscription request.
 */
export type BatchSubscribeCallback<TData = Record<string, unknown>> = (
  response: ServiceResponse<TData>,
) => void;

/**
 * Batches multiple subscription requests within the same microtask
 * into a single `batchSubscribe` socket event per service.
 */
export interface SubscriptionBatcher {
  /**
   * Enqueue a subscription request. Requests are grouped by serviceName
   * and flushed on the next microtask as a single batchSubscribe event.
   */
  enqueue: (
    serviceName: string,
    entryId: string,
    requiredLevel: AccessLevel,
    callback: BatchSubscribeCallback,
  ) => void;
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
  subscriptionBatcher: SubscriptionBatcher;
  /**
   * True while the server has reported this client rate-limited.
   * `useServiceQuery` pauses reads while set — rejected events still count
   * against the budget and would re-trip the limiter indefinitely.
   */
  isRateLimited: boolean;
  /**
   * Report a rate-limit rejection (used internally by hooks; callable by
   * app code that talks to the socket directly). Pauses reads for
   * `retryAfterMs` (or a 5s default when the server didn't say).
   */
  reportRateLimited: (retryAfterMs?: number) => void;
}
