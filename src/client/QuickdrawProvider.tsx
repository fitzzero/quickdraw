"use client";

import * as React from "react";
import { io, Socket } from "socket.io-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AccessLevel } from "../shared/types";
import type { ServiceResponse } from "../shared/types";
import type {
  QuickdrawSocketContextValue,
  QuickdrawProviderProps,
  SubscriptionRegistry,
  SubscriptionEntry,
  SubscriptionBatcher,
  BatchSubscribeCallback,
} from "./types";

// ============================================================================
// Subscription Registry Implementation
// ============================================================================

/**
 * Creates a new subscription registry instance.
 * Each socket connection should have its own registry.
 */
function createSubscriptionRegistry(): SubscriptionRegistry {
  const subscriptions = new Map<string, SubscriptionEntry>();

  return {
    acquire(key: string) {
      const existing = subscriptions.get(key);
      if (existing) {
        existing.refCount++;
        return { isNew: false, entry: existing };
      }

      const entry: SubscriptionEntry = { refCount: 1 };
      subscriptions.set(key, entry);
      return { isNew: true, entry };
    },

    release(key: string) {
      const entry = subscriptions.get(key);
      if (!entry) return false;

      entry.refCount--;
      if (entry.refCount <= 0) {
        entry.cleanup?.();
        subscriptions.delete(key);
        return true;
      }
      return false;
    },

    setCleanup(key: string, cleanup: () => void) {
      const entry = subscriptions.get(key);
      if (entry) {
        entry.cleanup = cleanup;
      }
    },

    clear() {
      for (const entry of subscriptions.values()) {
        entry.cleanup?.();
      }
      subscriptions.clear();
    },
  };
}

// ============================================================================
// Subscription Batcher Implementation
// ============================================================================

interface PendingBatchEntry {
  entryId: string;
  requiredLevel: AccessLevel;
  callback: BatchSubscribeCallback;
}

/**
 * Creates a subscription batcher that collects subscribe requests within
 * the same microtask and sends them as a single batchSubscribe event per service.
 */
function createSubscriptionBatcher(socketRef: { current: Socket | null }): SubscriptionBatcher {
  const pending = new Map<string, PendingBatchEntry[]>();
  let flushScheduled = false;

  function flush(): void {
    flushScheduled = false;
    const socket = socketRef.current;
    if (!socket) {
      for (const entries of pending.values()) {
        for (const entry of entries) {
          entry.callback({ success: false, error: "Socket not connected" });
        }
      }
      pending.clear();
      return;
    }

    for (const [serviceName, entries] of pending) {
      if (entries.length === 0) continue;
      const entryIds = entries.map((e) => e.entryId);
      const requiredLevel = entries[0]!.requiredLevel;

      socket.emit(
        `${serviceName}:batchSubscribe`,
        { entryIds, requiredLevel },
        (response: ServiceResponse<Record<string, unknown>>) => {
          if (response.success && response.data) {
            const dataMap = response.data as Record<string, unknown>;
            for (const entry of entries) {
              const entityData = dataMap[entry.entryId];
              if (entityData) {
                entry.callback({
                  success: true,
                  data: entityData as Record<string, unknown>,
                });
              } else {
                entry.callback({
                  success: false,
                  error: "Access denied or entry not found",
                  code: 403,
                });
              }
            }
          } else {
            const errMsg = !response.success ? response.error : "Batch subscription failed";
            for (const entry of entries) {
              entry.callback({
                success: false,
                error: errMsg,
              });
            }
          }
        },
      );
    }

    pending.clear();
  }

  return {
    enqueue(
      serviceName: string,
      entryId: string,
      requiredLevel: AccessLevel,
      callback: BatchSubscribeCallback,
    ): void {
      let entries = pending.get(serviceName);
      if (!entries) {
        entries = [];
        pending.set(serviceName, entries);
      }
      entries.push({ entryId, requiredLevel, callback });

      if (!flushScheduled) {
        flushScheduled = true;
        queueMicrotask(flush);
      }
    },
  };
}

// ============================================================================
// Socket Context
// ============================================================================

const QuickdrawSocketContext = React.createContext<QuickdrawSocketContextValue | null>(null);

/**
 * Hook to access the quickdraw socket context.
 */
export function useQuickdrawSocket(): QuickdrawSocketContextValue {
  const context = React.useContext(QuickdrawSocketContext);
  if (!context) {
    throw new Error("useQuickdrawSocket must be used within a QuickdrawProvider");
  }
  return context;
}

// ============================================================================
// Provider Component
// ============================================================================

/**
 * Creates a QueryClient instance.
 * Using a factory function instead of module-level instantiation
 * to avoid SSR hydration issues.
 */
function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 1000 * 60 * 5, // 5 minutes
        retry: 1,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

/**
 * Provider component that sets up TanStack Query and Socket.io connection.
 *
 * @example
 * ```tsx
 * // In your app layout
 * export default function RootLayout({ children }) {
 *   return (
 *     <QuickdrawProvider
 *       serverUrl="http://localhost:4000"
 *       authToken={token}
 *     >
 *       {children}
 *     </QuickdrawProvider>
 *   );
 * }
 * ```
 */
export function QuickdrawProvider({
  children,
  serverUrl,
  queryClient,
  authToken,
  autoConnect = !!authToken,
  withCredentials = true,
  socketPath,
  reconnectBehavior = "invalidate-queries",
}: QuickdrawProviderProps): React.ReactElement {
  // Create QueryClient lazily to avoid SSR issues
  const [defaultQueryClient] = React.useState(() => createQueryClient());
  const actualQueryClient = queryClient ?? defaultQueryClient;

  const [socket, setSocket] = React.useState<Socket | null>(null);
  const [isConnected, setIsConnected] = React.useState(false);
  const [userId, setUserId] = React.useState<string | null>(null);
  const [serviceAccess, setServiceAccess] = React.useState<Record<string, AccessLevel>>({});
  const [isRateLimited, setIsRateLimited] = React.useState(false);

  // Create subscription registry - recreated when socket changes
  const subscriptionRegistryRef = React.useRef<SubscriptionRegistry>(createSubscriptionRegistry());

  // Track previous authToken to detect changes
  const prevAuthTokenRef = React.useRef<string | undefined>(authToken);

  // Track socket synchronously to prevent double connections from concurrent effects
  const socketRef = React.useRef<Socket | null>(null);

  // Subscription batcher - uses socketRef so it always has the current socket
  const subscriptionBatcherRef = React.useRef<SubscriptionBatcher>(
    createSubscriptionBatcher(socketRef),
  );

  // Reconnect detection + options read through refs so `connect` stays stable
  const hasEverConnectedRef = React.useRef(false);
  const reconnectBehaviorRef = React.useRef(reconnectBehavior);
  reconnectBehaviorRef.current = reconnectBehavior;
  const queryClientRef = React.useRef(actualQueryClient);
  queryClientRef.current = actualQueryClient;

  // Rate-limit backoff: while the server reports us limited, reads pause.
  // The window extends on repeat reports; a timer flips the flag back.
  const rateLimitUntilRef = React.useRef(0);
  const rateLimitTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const reportRateLimited = React.useCallback((retryAfterMs?: number) => {
    const backoffMs = Math.min(Math.max(retryAfterMs ?? 5000, 250), 5 * 60 * 1000);
    const until = Date.now() + backoffMs;
    if (until <= rateLimitUntilRef.current) return;

    rateLimitUntilRef.current = until;
    setIsRateLimited(true);
    if (rateLimitTimerRef.current) clearTimeout(rateLimitTimerRef.current);
    rateLimitTimerRef.current = setTimeout(() => {
      rateLimitTimerRef.current = null;
      rateLimitUntilRef.current = 0;
      setIsRateLimited(false);
    }, backoffMs);
  }, []);

  React.useEffect(() => {
    return () => {
      if (rateLimitTimerRef.current) clearTimeout(rateLimitTimerRef.current);
    };
  }, []);

  const connect = React.useCallback(
    (token?: string) => {
      // Prevent double connections - check ref synchronously since state updates are async
      if (socketRef.current) return;

      const authToUse = token;

      // Clear old subscriptions when creating new socket
      subscriptionRegistryRef.current.clear();
      subscriptionRegistryRef.current = createSubscriptionRegistry();

      const newSocket = io(serverUrl, {
        auth: authToUse ? { token: authToUse } : undefined,
        withCredentials,
        transports: ["websocket", "polling"],
        autoConnect: true,
        ...(socketPath ? { path: socketPath } : {}),
      });

      newSocket.on("connect", () => {
        setIsConnected(true);
        // Reconnects (of this socket or a replacement) leave plain query
        // reads stale — room events emitted during the outage are gone.
        // Invalidate so active queries refetch; subscriptions and
        // collections re-establish themselves via the registry cycle.
        if (hasEverConnectedRef.current && reconnectBehaviorRef.current === "invalidate-queries") {
          void queryClientRef.current.invalidateQueries();
        }
        hasEverConnectedRef.current = true;
      });

      newSocket.on("disconnect", () => {
        setIsConnected(false);
        // Clear subscriptions on disconnect - they'll be re-established on reconnect
        subscriptionRegistryRef.current.clear();
      });

      // Listen for auth info from server
      newSocket.on(
        "auth:info",
        (info: { userId: string | null; serviceAccess: Record<string, AccessLevel> }) => {
          setUserId(info.userId);
          setServiceAccess(info.serviceAccess ?? {});
        },
      );

      // Server-reported rate limiting (default onRateLimitExceeded shape)
      newSocket.on("error", (payload: { code?: string; retryAfter?: number } | undefined) => {
        if (payload && payload.code === "RATE_LIMITED") {
          reportRateLimited(payload.retryAfter);
        }
      });

      newSocket.on("connect_error", (error) => {
        console.error("Socket connection error:", error.message);
      });

      socketRef.current = newSocket;
      setSocket(newSocket);
    },
    [serverUrl, withCredentials, socketPath, reportRateLimited],
  );

  const disconnect = React.useCallback(() => {
    if (socketRef.current) {
      // Clear subscriptions before disconnecting
      subscriptionRegistryRef.current.clear();
      socketRef.current.disconnect();
      socketRef.current = null;
      setSocket(null);
      setIsConnected(false);
      setUserId(null);
      setServiceAccess({});
    }
  }, []);

  // Auto-connect on mount if enabled
  React.useEffect(() => {
    if (autoConnect && !socketRef.current) {
      connect(authToken);
    }

    return () => {
      if (socketRef.current) {
        subscriptionRegistryRef.current.clear();
        socketRef.current.disconnect();
        socketRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect, authToken]);

  // Reconnect when authToken changes
  React.useEffect(() => {
    const prevToken = prevAuthTokenRef.current;

    // Update ref BEFORE any logic so next render has correct previous value
    prevAuthTokenRef.current = authToken;

    // If token actually changed, reconnect
    if (authToken !== prevToken) {
      if (socketRef.current) {
        disconnect();
      }
      if (authToken) {
        connect(authToken);
      }
    }
  }, [authToken, disconnect, connect]);

  const contextValue = React.useMemo<QuickdrawSocketContextValue>(
    () => ({
      socket,
      isConnected,
      userId,
      serviceAccess,
      connect,
      disconnect,
      subscriptionRegistry: subscriptionRegistryRef.current,
      subscriptionBatcher: subscriptionBatcherRef.current,
      isRateLimited,
      reportRateLimited,
    }),
    [
      socket,
      isConnected,
      userId,
      serviceAccess,
      connect,
      disconnect,
      isRateLimited,
      reportRateLimited,
    ],
  );

  return (
    <QueryClientProvider client={actualQueryClient}>
      <QuickdrawSocketContext.Provider value={contextValue}>
        {children}
      </QuickdrawSocketContext.Provider>
    </QueryClientProvider>
  );
}
