import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import { consoleLogger } from "../shared/types";
import type {
  QuickdrawSocket,
  QuickdrawServerOptions,
  QuickdrawServerResult,
} from "./types";
import { ServiceRegistry } from "./ServiceRegistry";

/**
 * Create a fully configured quickdraw server with one function call.
 *
 * @example
 * ```typescript
 * import { createQuickdrawServer } from '@quickdraw/core/server';
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
 *       // Verify JWT and return userId
 *       const payload = await verifyJWT(auth.token);
 *       return payload.userId;
 *     },
 *   },
 * });
 * ```
 */
export function createQuickdrawServer(
  options: QuickdrawServerOptions
): QuickdrawServerResult {
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

  // Create service registry
  const registry = new ServiceRegistry(io, { logger });

  // Apply authentication middleware
  io.use(async (socket, next) => {
    const quickdrawSocket = socket as QuickdrawSocket;

    try {
      if (options.auth?.authenticate) {
        const auth = socket.handshake.auth as Record<string, unknown>;
        const userId = await options.auth.authenticate(quickdrawSocket, auth);
        quickdrawSocket.userId = userId;

        // TODO: Load service access from user record
        // For now, default to empty service access
        quickdrawSocket.serviceAccess = {};
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
    serverLogger.info(
      `Registered services: ${registry.getServices().join(", ")}`
    );
  });

  return { io, httpServer, registry };
}
