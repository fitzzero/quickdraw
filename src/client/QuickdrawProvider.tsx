"use client";

import * as React from "react";
import { io, Socket } from "socket.io-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AccessLevel } from "../shared/types";
import type {
  QuickdrawSocketContextValue,
  QuickdrawProviderProps,
} from "./types";

// ============================================================================
// Socket Context
// ============================================================================

const QuickdrawSocketContext =
  React.createContext<QuickdrawSocketContextValue | null>(null);

/**
 * Hook to access the quickdraw socket context.
 */
export function useQuickdrawSocket(): QuickdrawSocketContextValue {
  const context = React.useContext(QuickdrawSocketContext);
  if (!context) {
    throw new Error(
      "useQuickdrawSocket must be used within a QuickdrawProvider"
    );
  }
  return context;
}

// ============================================================================
// Provider Component
// ============================================================================

const defaultQueryClient = new QueryClient({
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
  queryClient = defaultQueryClient,
  authToken,
  autoConnect = !!authToken,
}: QuickdrawProviderProps): React.ReactElement {
  const [socket, setSocket] = React.useState<Socket | null>(null);
  const [isConnected, setIsConnected] = React.useState(false);
  const [userId, setUserId] = React.useState<string | null>(null);
  const [serviceAccess, setServiceAccess] = React.useState<
    Record<string, AccessLevel>
  >({});

  // Store authToken in ref to avoid reconnecting on every render
  const authTokenRef = React.useRef(authToken);
  React.useEffect(() => {
    authTokenRef.current = authToken;
  }, [authToken]);

  const connect = React.useCallback(
    (token?: string) => {
      const authToUse = token ?? authTokenRef.current;

      const newSocket = io(serverUrl, {
        auth: authToUse ? { token: authToUse } : undefined,
        transports: ["websocket", "polling"],
        autoConnect: true,
      });

      newSocket.on("connect", () => {
        setIsConnected(true);
      });

      newSocket.on("disconnect", () => {
        setIsConnected(false);
      });

      // Listen for auth info from server
      newSocket.on(
        "auth:info",
        (info: { userId: string; serviceAccess: Record<string, AccessLevel> }) => {
          setUserId(info.userId);
          setServiceAccess(info.serviceAccess);
        }
      );

      newSocket.on("connect_error", (error) => {
        console.error("Socket connection error:", error.message);
      });

      setSocket(newSocket);
    },
    [serverUrl]
  );

  const disconnect = React.useCallback(() => {
    if (socket) {
      socket.disconnect();
      setSocket(null);
      setIsConnected(false);
      setUserId(null);
      setServiceAccess({});
    }
  }, [socket]);

  // Auto-connect on mount if enabled
  React.useEffect(() => {
    if (autoConnect && !socket) {
      connect();
    }

    return () => {
      if (socket) {
        socket.disconnect();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoConnect]);

  // Reconnect when authToken changes
  React.useEffect(() => {
    if (socket && authToken !== authTokenRef.current) {
      disconnect();
      if (authToken) {
        connect(authToken);
      }
    }
  }, [authToken, socket, disconnect, connect]);

  const contextValue = React.useMemo<QuickdrawSocketContextValue>(
    () => ({
      socket,
      isConnected,
      userId,
      serviceAccess,
      connect,
      disconnect,
    }),
    [socket, isConnected, userId, serviceAccess, connect, disconnect]
  );

  return (
    <QueryClientProvider client={queryClient}>
      <QuickdrawSocketContext.Provider value={contextValue}>
        {children}
      </QuickdrawSocketContext.Provider>
    </QueryClientProvider>
  );
}
