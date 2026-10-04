/**
 * Redis adapter utilities for horizontal scaling.
 *
 * This module provides optional Redis (or Valkey) integration for Socket.io
 * to enable running multiple server instances. Behind the adapter, the
 * server also takes its flush revisions from a shared counter on the same
 * client and keeps users' last-seen times there (`createServer`'s `cluster`
 * option; docs/deploying.md).
 *
 * @example
 * ```typescript
 * import { setupRedisAdapter } from '@fitzzero/quickdraw-core/server';
 *
 * const server = qd.createServer({ app, services, db });
 *
 * // Enable Redis for horizontal scaling
 * const redis = await setupRedisAdapter(server.io, {
 *   host: process.env.REDIS_HOST ?? 'localhost',
 *   port: parseInt(process.env.REDIS_PORT ?? '6379'),
 * });
 *
 * // On shutdown, once the server closed:
 * await server.close();
 * await redis.cleanup();
 * ```
 */

import type { Server as SocketIOServer } from "socket.io";
import type { Logger } from "../contract/logger";
import { consoleLogger } from "../contract/logger";
import { isModuleNotFound, loadRedisPeers } from "./redisPeers";

/**
 * Redis adapter configuration options.
 */
export interface RedisAdapterOptions {
  /**
   * Redis host (default: 'localhost')
   */
  host?: string;

  /**
   * Redis port (default: 6379)
   */
  port?: number;

  /**
   * Redis password (optional)
   */
  password?: string;

  /**
   * Redis database number (default: 0)
   */
  db?: number;

  /**
   * Key prefix for Socket.io adapter (default: 'socket.io')
   */
  keyPrefix?: string;

  /**
   * Logger instance
   */
  logger?: Logger;
}

/**
 * Result of Redis adapter setup.
 */
export interface RedisAdapterResult {
  /**
   * Whether the adapter was successfully set up.
   */
  success: boolean;

  /**
   * Cleanup function to disconnect from Redis.
   */
  cleanup: () => Promise<void>;
}

// Type for dynamically loaded redis client
interface RedisClient {
  connect: () => Promise<void>;
  quit: () => Promise<void>;
  duplicate: () => RedisClient;
  on(event: "error" | "ready", listener: (error?: unknown) => void): unknown;
}

/**
 * Logs a client's errors at warn, once until it is ready again: a client
 * that lost its server reports every reconnect attempt, and one without an
 * `error` listener would make the adapter print a warning each time.
 */
function reportErrors(client: RedisClient, logger: Logger, role: string): void {
  let reported = false;
  client.on("error", (error) => {
    if (!reported) {
      reported = true;
      logger.warn("Redis adapter connection lost; it reconnects by itself", {
        client: role,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  client.on("ready", () => {
    reported = false;
  });
}

/**
 * Set up Redis adapter for Socket.io horizontal scaling.
 *
 * This function dynamically imports the @socket.io/redis-adapter package
 * to avoid requiring it as a hard dependency.
 *
 * @param io - Socket.io server instance
 * @param options - Redis configuration options
 * @returns Promise resolving to setup result
 *
 * @example
 * ```typescript
 * const { io } = createQuickdrawServer({ ... });
 *
 * const { success, cleanup } = await setupRedisAdapter(io, {
 *   host: 'redis.example.com',
 *   port: 6379,
 *   password: process.env.REDIS_PASSWORD,
 * });
 *
 * if (success) {
 *   console.log('Redis adapter enabled - horizontal scaling ready');
 * }
 *
 * // On shutdown:
 * await cleanup();
 * ```
 */
export async function setupRedisAdapter(
  io: SocketIOServer,
  options: RedisAdapterOptions = {},
): Promise<RedisAdapterResult> {
  const logger =
    options.logger?.child({ service: "RedisAdapter" }) ??
    consoleLogger.child({ service: "RedisAdapter" });

  const { host = "localhost", port = 6379, password, db = 0, keyPrefix = "socket.io" } = options;

  try {
    // Dynamically import Redis packages - these are optional peer dependencies.
    const peers = await loadRedisPeers();

    const createAdapter = peers.createAdapter as (
      pubClient: RedisClient,
      subClient: RedisClient,
      opts?: { key?: string },
    ) => unknown;

    const createClient = peers.createClient as (opts: {
      socket: { host: string; port: number };
      password?: string;
      database?: number;
    }) => RedisClient;

    // Create Redis clients for pub/sub
    const pubClient = createClient({
      socket: { host, port },
      password,
      database: db,
    });

    const subClient = pubClient.duplicate();
    reportErrors(pubClient, logger, "publish");
    reportErrors(subClient, logger, "subscribe");

    // Connect both clients
    await Promise.all([pubClient.connect(), subClient.connect()]);

    // Set up the adapter
    io.adapter(
      createAdapter(pubClient, subClient, { key: keyPrefix }) as Parameters<typeof io.adapter>[0],
    );

    logger.info(`Redis adapter connected to ${host}:${port}`);

    // Return cleanup function
    const cleanup = async () => {
      try {
        await Promise.all([pubClient.quit(), subClient.quit()]);
        logger.info("Redis adapter disconnected");
      } catch (error) {
        logger.error("Error disconnecting Redis adapter", {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    };

    return { success: true, cleanup };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);

    // Check if it's a missing dependency error
    if (isModuleNotFound(error)) {
      logger.warn(
        "Redis adapter packages not installed. Install @socket.io/redis-adapter and redis for horizontal scaling support.",
      );
    } else {
      logger.error("Failed to set up Redis adapter", { error: errorMessage });
    }

    return {
      success: false,
      cleanup: async () => {
        // No-op cleanup when setup failed
      },
    };
  }
}

/**
 * Check if Redis adapter packages are available.
 *
 * @returns Promise resolving to true if packages are installed
 */
export async function isRedisAdapterAvailable(): Promise<boolean> {
  try {
    await loadRedisPeers();
    return true;
  } catch {
    return false;
  }
}
