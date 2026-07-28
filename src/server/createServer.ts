import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { consoleLogger, userRoom } from "../shared/types";
import type {
  QuickdrawIdentity,
  QuickdrawSocket,
  QuickdrawServerOptions,
  QuickdrawServerResult,
} from "./types";
import { ServiceRegistry } from "./ServiceRegistry";

/**
 * Create a fully configured quickdraw server with one function call.
 *
 * Authentication: `authenticate` may return a plain userId string or a
 * structured {@link QuickdrawIdentity} (`{ userId?, principalType?, claims?,
 * serviceAccess? }`) for non-trivial principal models (task tokens, runner
 * tokens…). Service-level access comes from the identity's `serviceAccess`,
 * or from `loadServiceAccess(userId)` when the identity omits it.
 *
 * On connection, authenticated sockets join `user:{userId}` (so
 * `emitToUserRoom` and user-targeted kicks work out of the box) and every
 * socket receives an `auth:info` event with
 * `{ userId, serviceAccess, principalType }`.
 *
 * @example
 * ```typescript
 * import { createQuickdrawServer } from '@fitzzero/quickdraw-core/server';
 * import { ChatService, UserService } from './services';
 *
 * const { io, httpServer, registry } = createQuickdrawServer({
 *   port: 4000,
 *   cors: { origin: 'http://localhost:3000' },
 *   services: {
 *     chatService: new ChatService(prisma),
 *     userService: new UserService(prisma),
 *   },
 *   auth: {
 *     authenticate: async (socket, auth) => {
 *       const payload = await verifyJWT(auth.token);
 *       if (!payload) return undefined;
 *       return { userId: payload.userId, principalType: "user" };
 *     },
 *     loadServiceAccess: async (userId) => {
 *       const user = await prisma.user.findUnique({ where: { id: userId } });
 *       return user?.serviceAccess as Record<string, AccessLevel> | null;
 *     },
 *   },
 * });
 * ```
 */
export function createQuickdrawServer(options: QuickdrawServerOptions): QuickdrawServerResult {
  const logger = options.logger ?? consoleLogger;
  const serverLogger = logger.child({ service: "QuickdrawServer" });

  // Create Express app with basic middleware
  const app = express();
  app.use(express.json());

  // Health check endpoint
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Create HTTP server
  const httpServer = createServer(app);

  // Create Socket.io server
  const io = new SocketIOServer(httpServer, {
    cors: {
      origin: options.cors?.origin ?? "*",
      methods: options.cors?.methods ?? ["GET", "POST"],
      credentials: options.cors?.credentials ?? true,
    },
  });

  // Create service registry with method logging configuration
  const registry = new ServiceRegistry(io, {
    logger,
    methodLogging: options.methodLogging,
  });

  // Apply authentication middleware
  io.use(async (socket, next) => {
    const quickdrawSocket = socket as QuickdrawSocket;

    try {
      if (options.auth?.authenticate) {
        const auth = socket.handshake.auth as Record<string, unknown>;
        const result = await options.auth.authenticate(quickdrawSocket, auth);
        const identity: QuickdrawIdentity | undefined =
          typeof result === "string" ? { userId: result } : result;

        quickdrawSocket.userId = identity?.userId;
        quickdrawSocket.principalType = identity?.principalType;
        quickdrawSocket.claims = identity?.claims;

        let serviceAccess = identity?.serviceAccess;
        if (!serviceAccess && identity?.userId && options.auth.loadServiceAccess) {
          serviceAccess =
            (await options.auth.loadServiceAccess(identity.userId)) ?? undefined;
        }
        quickdrawSocket.serviceAccess = serviceAccess ?? {};
      }
      next();
    } catch (error) {
      serverLogger.error("Authentication failed", {
        error: error instanceof Error ? error.message : "Unknown error",
        socketId: socket.id,
      });
      next(new Error("Authentication failed"));
    }
  });

  // Register services
  for (const [serviceName, service] of Object.entries(options.services)) {
    registry.registerService(serviceName, service);
  }

  // Handle connection lifecycle
  io.on("connection", (socket) => {
    const quickdrawSocket = socket as QuickdrawSocket;
    serverLogger.info("Socket connected", {
      socketId: quickdrawSocket.id,
      userId: quickdrawSocket.userId,
    });

    // Authenticated sockets join their user room (targeted notifications,
    // adapter-safe revocation via kickFromCollection).
    if (quickdrawSocket.userId) {
      void quickdrawSocket.join(userRoom(quickdrawSocket.userId));
    }

    // Tell the client who it is — QuickdrawProvider listens for this to
    // populate its userId/serviceAccess context.
    quickdrawSocket.emit("auth:info", {
      userId: quickdrawSocket.userId ?? null,
      serviceAccess: quickdrawSocket.serviceAccess ?? {},
      principalType: quickdrawSocket.principalType,
    });

    quickdrawSocket.on("disconnect", () => {
      serverLogger.info("Socket disconnected", {
        socketId: quickdrawSocket.id,
        userId: quickdrawSocket.userId,
      });

      // Cleanup subscriptions across all services
      for (const service of registry.getServiceInstances()) {
        try {
          service.unsubscribeSocket(quickdrawSocket);
        } catch {
          // Ignore cleanup errors
        }
      }
    });
  });

  // Start listening
  httpServer.listen(options.port, "0.0.0.0", () => {
    serverLogger.info(`Server listening on port ${options.port}`);
    serverLogger.info(`Registered services: ${registry.getServices().join(", ")}`);
  });

  // Graceful shutdown handler
  const shutdown = async (signal: string) => {
    serverLogger.info(`Received ${signal}, starting graceful shutdown...`);

    // Stop accepting new connections
    httpServer.close(() => {
      serverLogger.info("HTTP server closed");
    });

    // Close all Socket.io connections gracefully
    const sockets = await io.fetchSockets();
    serverLogger.info(`Closing ${sockets.length} active socket connections...`);

    for (const socket of sockets) {
      const quickdrawSocket = socket as unknown as QuickdrawSocket;

      // Unsubscribe from all services
      for (const service of registry.getServiceInstances()) {
        try {
          service.unsubscribeSocket(quickdrawSocket);
        } catch {
          // Ignore cleanup errors
        }
      }

      // Disconnect socket
      socket.disconnect(true);
    }

    // Close Socket.io server
    io.close(() => {
      serverLogger.info("Socket.io server closed");
      process.exit(0);
    });

    // Force exit after timeout
    setTimeout(() => {
      serverLogger.error("Graceful shutdown timeout, forcing exit");
      process.exit(1);
    }, 10000); // 10 second timeout
  };

  // Register shutdown handlers
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return { io, httpServer, registry };
}
