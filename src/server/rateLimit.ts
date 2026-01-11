/**
 * Rate limiting middleware for Socket.io events.
 * 
 * Provides per-socket rate limiting to prevent abuse and ensure
 * fair resource usage across clients.
 * 
 * @example
 * ```typescript
 * import { createRateLimiter, applyRateLimitMiddleware } from '@fitzzero/quickdraw-core/server';
 * 
 * // Create a rate limiter
 * const rateLimiter = createRateLimiter({
 *   windowMs: 60000, // 1 minute window
 *   maxRequests: 100, // 100 requests per window
 * });
 * 
 * // Apply to Socket.io server
 * applyRateLimitMiddleware(io, rateLimiter);
 * ```
 */

import type { Server as SocketIOServer, Socket } from "socket.io";
import type { Logger } from "../shared/types";
import { consoleLogger } from "../shared/types";

/**
 * Rate limiter configuration options.
 */
export interface RateLimitOptions {
  /**
   * Time window in milliseconds (default: 60000 = 1 minute)
   */
  windowMs?: number;
  
  /**
   * Maximum number of requests per window (default: 100)
   */
  maxRequests?: number;
  
  /**
   * Events to exclude from rate limiting (e.g., ['ping', 'pong'])
   */
  excludeEvents?: string[];
  
  /**
   * Custom key generator for grouping requests.
   * Default uses socket.id.
   */
  keyGenerator?: (socket: Socket, eventName: string) => string;
  
  /**
   * Callback when rate limit is exceeded.
   */
  onRateLimitExceeded?: (socket: Socket, eventName: string) => void;
  
  /**
   * Logger instance
   */
  logger?: Logger;
}

/**
 * Rate limit entry tracking requests in a window.
 */
interface RateLimitEntry {
  count: number;
  resetAt: number;
}

/**
 * Rate limiter instance.
 */
export interface RateLimiter {
  /**
   * Check if a request should be allowed.
   * Returns true if allowed, false if rate limited.
   */
  check: (key: string) => boolean;
  
  /**
   * Get remaining requests for a key.
   */
  getRemaining: (key: string) => number;
  
  /**
   * Get time until rate limit resets for a key.
   */
  getResetTime: (key: string) => number;
  
  /**
   * Clear all rate limit entries (useful for testing).
   */
  clear: () => void;
  
  /**
   * Configuration options.
   */
  options: Required<Pick<RateLimitOptions, "windowMs" | "maxRequests" | "excludeEvents">>;
}

/**
 * Create a rate limiter instance.
 * 
 * @param options - Rate limiter configuration
 * @returns Rate limiter instance
 * 
 * @example
 * ```typescript
 * const limiter = createRateLimiter({
 *   windowMs: 60000,
 *   maxRequests: 100,
 * });
 * 
 * if (limiter.check('user-123')) {
 *   // Request allowed
 * } else {
 *   // Rate limited
 * }
 * ```
 */
export function createRateLimiter(options: RateLimitOptions = {}): RateLimiter {
  const {
    windowMs = 60000,
    maxRequests = 100,
    excludeEvents = [],
  } = options;

  const entries = new Map<string, RateLimitEntry>();

  // Cleanup old entries periodically
  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.resetAt <= now) {
        entries.delete(key);
      }
    }
  }, windowMs);

  // Prevent the interval from keeping the process alive
  if (cleanupInterval.unref) {
    cleanupInterval.unref();
  }

  return {
    check(key: string): boolean {
      const now = Date.now();
      const entry = entries.get(key);

      if (!entry || entry.resetAt <= now) {
        // New window
        entries.set(key, {
          count: 1,
          resetAt: now + windowMs,
        });
        return true;
      }

      if (entry.count >= maxRequests) {
        return false;
      }

      entry.count++;
      return true;
    },

    getRemaining(key: string): number {
      const now = Date.now();
      const entry = entries.get(key);

      if (!entry || entry.resetAt <= now) {
        return maxRequests;
      }

      return Math.max(0, maxRequests - entry.count);
    },

    getResetTime(key: string): number {
      const now = Date.now();
      const entry = entries.get(key);

      if (!entry || entry.resetAt <= now) {
        return 0;
      }

      return entry.resetAt - now;
    },

    clear(): void {
      entries.clear();
    },

    options: {
      windowMs,
      maxRequests,
      excludeEvents,
    },
  };
}

/**
 * Apply rate limiting middleware to a Socket.io server.
 * 
 * This intercepts all incoming events and checks them against
 * the rate limiter before allowing them to proceed.
 * 
 * @param io - Socket.io server instance
 * @param rateLimiter - Rate limiter instance
 * @param options - Additional options
 * 
 * @example
 * ```typescript
 * const rateLimiter = createRateLimiter({ maxRequests: 100 });
 * 
 * applyRateLimitMiddleware(io, rateLimiter, {
 *   keyGenerator: (socket) => socket.userId ?? socket.id,
 *   onRateLimitExceeded: (socket, event) => {
 *     socket.emit('error', { code: 'RATE_LIMITED', event });
 *   },
 * });
 * ```
 */
export function applyRateLimitMiddleware(
  io: SocketIOServer,
  rateLimiter: RateLimiter,
  options: Pick<RateLimitOptions, "keyGenerator" | "onRateLimitExceeded" | "logger"> = {}
): void {
  const logger = options.logger?.child({ service: "RateLimiter" }) ??
    consoleLogger.child({ service: "RateLimiter" });

  const keyGenerator = options.keyGenerator ?? ((socket) => socket.id);
  const onRateLimitExceeded = options.onRateLimitExceeded ?? ((socket, eventName) => {
    socket.emit("error", {
      code: "RATE_LIMITED",
      message: `Rate limit exceeded for event: ${eventName}`,
      retryAfter: rateLimiter.getResetTime(keyGenerator(socket, eventName)),
    });
  });

  const { excludeEvents } = rateLimiter.options;

  io.on("connection", (socket) => {
    // Use Socket.io's built-in middleware for incoming packets
    socket.use(([eventName, ...args], next) => {
      // Skip excluded events
      if (excludeEvents.includes(eventName)) {
        next();
        return;
      }

      // Skip internal Socket.io events
      if (eventName.startsWith("$")) {
        next();
        return;
      }

      const key = keyGenerator(socket, eventName);

      if (rateLimiter.check(key)) {
        next();
      } else {
        logger.warn(`Rate limit exceeded for socket ${socket.id} on event ${eventName}`);
        onRateLimitExceeded(socket, eventName);
        
        // Don't call next() - this drops the event
        // If there's a callback, call it with an error
        const lastArg = args[args.length - 1];
        if (typeof lastArg === "function") {
          lastArg({
            success: false,
            error: "Rate limit exceeded",
            code: 429,
          });
        }
      }
    });
  });

  logger.info(
    `Rate limiting enabled: ${rateLimiter.options.maxRequests} requests per ${rateLimiter.options.windowMs}ms`
  );
}

/**
 * Create a tiered rate limiter with different limits for different event types.
 * 
 * @param tiers - Map of event patterns to rate limit options
 * @param defaultOptions - Default options for events not matching any tier
 * @returns Rate limiter that applies different limits based on event name
 * 
 * @example
 * ```typescript
 * const tieredLimiter = createTieredRateLimiter(
 *   {
 *     // Strict limits for write operations
 *     'create*': { maxRequests: 10, windowMs: 60000 },
 *     'update*': { maxRequests: 20, windowMs: 60000 },
 *     'delete*': { maxRequests: 5, windowMs: 60000 },
 *     // Generous limits for reads
 *     'list*': { maxRequests: 200, windowMs: 60000 },
 *     'get*': { maxRequests: 200, windowMs: 60000 },
 *   },
 *   { maxRequests: 100, windowMs: 60000 } // Default
 * );
 * ```
 */
export function createTieredRateLimiter(
  tiers: Record<string, RateLimitOptions>,
  defaultOptions: RateLimitOptions = {}
): {
  check: (key: string, eventName: string) => boolean;
  getRemaining: (key: string, eventName: string) => number;
  clear: () => void;
} {
  // Create a limiter for each tier
  const tierLimiters = new Map<string, RateLimiter>();
  const tierPatterns: Array<{ pattern: RegExp; limiter: RateLimiter }> = [];

  for (const [pattern, options] of Object.entries(tiers)) {
    const limiter = createRateLimiter({ ...defaultOptions, ...options });
    tierLimiters.set(pattern, limiter);
    
    // Convert glob-like pattern to regex
    const regexPattern = pattern
      .replace(/\*/g, ".*")
      .replace(/\?/g, ".");
    tierPatterns.push({
      pattern: new RegExp(`^${regexPattern}$`),
      limiter,
    });
  }

  const defaultLimiter = createRateLimiter(defaultOptions);

  function getLimiterForEvent(eventName: string): RateLimiter {
    for (const { pattern, limiter } of tierPatterns) {
      if (pattern.test(eventName)) {
        return limiter;
      }
    }
    return defaultLimiter;
  }

  return {
    check(key: string, eventName: string): boolean {
      const limiter = getLimiterForEvent(eventName);
      // Include event name in key to separate limits per event type
      return limiter.check(`${key}:${eventName}`);
    },

    getRemaining(key: string, eventName: string): number {
      const limiter = getLimiterForEvent(eventName);
      return limiter.getRemaining(`${key}:${eventName}`);
    },

    clear(): void {
      for (const limiter of tierLimiters.values()) {
        limiter.clear();
      }
      defaultLimiter.clear();
    },
  };
}
