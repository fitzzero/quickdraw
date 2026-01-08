import { io as ioClient, Socket } from "socket.io-client";
import type { ServiceResponse } from "../shared/types";
import type { BaseServiceInstance, QuickdrawServerResult } from "./types";
import { createQuickdrawServer } from "./createServer";

/**
 * Options for creating a test server.
 */
export interface CreateTestServerOptions {
  services: Record<string, BaseServiceInstance>;
  seedDb?: () => Promise<void>;
}

/**
 * Test server instance with helper methods.
 */
export interface TestServer {
  port: number;
  result: QuickdrawServerResult;
  stop: () => Promise<void>;
  connectAs: (userId: string) => Promise<TestClient>;
}

/**
 * Test client instance with helper methods.
 */
export interface TestClient {
  socket: Socket;
  emit: <TPayload, TResponse>(
    event: string,
    payload: TPayload
  ) => Promise<TResponse>;
  close: () => void;
}

let nextPort = 10000;

/**
 * Get an available port for testing.
 */
export function getAvailablePort(): number {
  return nextPort++;
}

/**
 * Create a test server with dev authentication.
 *
 * @example
 * ```typescript
 * const server = await createTestServer({
 *   services: {
 *     chatService: new ChatService(testPrisma),
 *   },
 *   seedDb: async () => {
 *     await testPrisma.user.create({ ... });
 *   },
 * });
 *
 * const client = await server.connectAs('user-id-123');
 * const result = await client.emit('chatService:createChat', { title: 'Test' });
 *
 * await server.stop();
 * ```
 */
export async function createTestServer(
  options: CreateTestServerOptions
): Promise<TestServer> {
  const port = getAvailablePort();

  const result = createQuickdrawServer({
    port,
    services: options.services,
    auth: {
      // Dev mode: accept userId directly from auth
      authenticate: async (_socket, auth) => {
        return auth.userId as string | undefined;
      },
    },
  });

  // Wait for server to start
  await new Promise<void>((resolve) => {
    result.httpServer.once("listening", resolve);
  });

  // Seed database if provided
  if (options.seedDb) {
    await options.seedDb();
  }

  return {
    port,
    result,
    stop: () =>
      new Promise<void>((resolve) => {
        result.io.close();
        result.httpServer.close(() => resolve());
      }),
    connectAs: (userId: string) => connectAsUser(port, userId),
  };
}

/**
 * Connect to a test server as a specific user.
 */
export async function connectAsUser(
  port: number,
  userId: string
): Promise<TestClient> {
  const socket = ioClient(`http://localhost:${port}`, {
    auth: { userId },
    transports: ["websocket"],
    autoConnect: true,
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Connection timeout"));
    }, 5000);

    socket.on("connect", () => {
      clearTimeout(timeout);
      resolve();
    });

    socket.on("connect_error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
  });

  return {
    socket,
    emit: <TPayload, TResponse>(event: string, payload: TPayload) =>
      emitWithAck<TPayload, TResponse>(socket, event, payload),
    close: () => socket.close(),
  };
}

/**
 * Emit an event and wait for acknowledgment.
 */
export function emitWithAck<TPayload, TResponse>(
  socket: Socket,
  event: string,
  payload: TPayload,
  timeoutMs: number = 5000
): Promise<TResponse> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`Timeout waiting for ${event}`));
    }, timeoutMs);

    socket.emit(event, payload, (response: ServiceResponse<TResponse>) => {
      clearTimeout(timeout);

      if (response.success) {
        resolve(response.data);
      } else {
        reject(new Error(response.error));
      }
    });
  });
}

/**
 * Wait for a specific socket event.
 */
export function waitForEvent<T>(
  socket: Socket,
  event: string,
  timeoutMs: number = 5000
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`Timeout waiting for event ${event}`));
    }, timeoutMs);

    const handler = (data: T) => {
      clearTimeout(timeout);
      socket.off(event, handler);
      resolve(data);
    };

    socket.on(event, handler);
  });
}
