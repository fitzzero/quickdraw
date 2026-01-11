/**
 * Redis adapter utilities for horizontal scaling.
 * 
 * This module provides optional Redis integration for Socket.io
 * to enable running multiple server instances.
 * 
 * @example
 * ```typescript
 * import { createQuickdrawServer } from '@fitzzero/quickdraw-core/server';
 * import { setupRedisAdapter } from '@fitzzero/quickdraw-core/server';
 * 
 * const { io } = createQuickdrawServer({ ... });
 * 
 * // Enable Redis for horizontal scaling
 * await setupRedisAdapter(io, {
 *   host: process.env.REDIS_HOST ?? 'localhost',
 *   port: parseInt(process.env.REDIS_PORT ?? '6379'),
 * });
 * ```
 */

import type { Server as SocketIOServer } from "socket.io";
import type { Logger } from "../shared/types";
import { consoleLogger } from "../shared/types";

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
  options: RedisAdapterOptions = {}
): Promise<RedisAdapterResult> {
  const logger = options.logger?.child({ service: "RedisAdapter" }) ??
    consoleLogger.child({ service: "RedisAdapter" });
  
  const {
    host = "localhost",
    port = 6379,
    password,
    db = 0,
    keyPrefix = "socket.io",
  } = options;

  try {
    // Dynamically import Redis packages - these are optional peer dependencies
    // Using Function constructor to avoid static analysis/bundling of the import
    const dynamicImport = new Function("specifier", "return import(specifier)");
    
    const [redisAdapterModule, redisModule] = await Promise.all([
      dynamicImport("@socket.io/redis-adapter") as Promise<{ createAdapter: unknown }>,
      dynamicImport("redis") as Promise<{ createClient: unknown }>,
    ]);
    
    const createAdapter = redisAdapterModule.createAdapter as (
      pubClient: RedisClient,
      subClient: RedisClient,
      opts?: { key?: string }
    ) => unknown;
    
    const createClient = redisModule.createClient as (opts: {
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

    // Connect both clients
    await Promise.all([pubClient.connect(), subClient.connect()]);

    // Set up the adapter
    io.adapter(createAdapter(pubClient, subClient, { key: keyPrefix }) as Parameters<typeof io.adapter>[0]);

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
    if (errorMessage.includes("Cannot find module") || errorMessage.includes("MODULE_NOT_FOUND")) {
      logger.warn(
        "Redis adapter packages not installed. Install @socket.io/redis-adapter and redis for horizontal scaling support."
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
    const dynamicImport = new Function("specifier", "return import(specifier)");
    await Promise.all([
      dynamicImport("@socket.io/redis-adapter"),
      dynamicImport("redis"),
    ]);
    return true;
  } catch {
    return false;
  }
}
