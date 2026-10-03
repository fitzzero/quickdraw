/**
 * Express rate-limit presets built on express-rate-limit.
 *
 * Lives in the dedicated `/server/express` subpath so the core `/server`
 * entry point carries no express-rate-limit dependency. All presets are
 * factories (not module-level singletons) so env/config is read at call time.
 *
 * Note: distinct from the Socket.IO `createRateLimiter` exported from
 * `/server` — these protect REST routes (OAuth, webhooks, public APIs).
 */

import type { NextFunction, Request, Response } from "express";
import {
  ipKeyGenerator,
  rateLimit,
  type Options,
  type RateLimitRequestHandler,
} from "express-rate-limit";

type PartialOptions = Partial<Options>;

function handler(_req: Request, res: Response, _next: NextFunction, options: Options): void {
  const retryAfterSec = Math.max(1, Math.ceil((options.windowMs ?? 60_000) / 1000));
  if (!res.getHeader("Retry-After")) {
    res.setHeader("Retry-After", String(retryAfterSec));
  }
  res.status(options.statusCode ?? 429).json({ error: "Rate limit exceeded" });
}

const jsonLimiter: PartialOptions = {
  standardHeaders: true,
  legacyHeaders: false,
  handler,
};

/** Normalize IPv4-mapped IPv6 addresses (::ffff:1.2.3.4 → 1.2.3.4). */
export function stripIp(raw: string | undefined): string {
  const ip = raw ?? "unknown";
  return ip.startsWith("::ffff:") ? ip.slice(7) : ip;
}

/**
 * Key by Bearer token when present, falling back to client IP. Lets
 * token-authenticated clients get their own bucket instead of sharing
 * a NAT'd IP.
 */
export function bearerOrIp(req: Request): string {
  const auth = req.headers.authorization ?? "";
  if (auth.startsWith("Bearer ")) return auth.slice(7);
  return ipKeyGenerator(stripIp(req.ip));
}

/**
 * Base factory: JSON 429 body + Retry-After header + standard headers.
 */
export function createJsonRateLimiter(options: PartialOptions): RateLimitRequestHandler {
  return rateLimit({ ...jsonLimiter, ...options });
}

/** OAuth flows: 20 requests / 15 min per IP (status sub-routes excluded). */
export function createAuthLimiter(overrides: PartialOptions = {}): RateLimitRequestHandler {
  return createJsonRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 20,
    skip: (req) => req.path.endsWith("/status"),
    ...overrides,
  });
}

/** Auth status polling: 120 requests / 15 min per IP. */
export function createAuthStatusLimiter(overrides: PartialOptions = {}): RateLimitRequestHandler {
  return createJsonRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 120,
    ...overrides,
  });
}

/** Inbound webhooks: 300 requests / min per IP. */
export function createWebhookLimiter(overrides: PartialOptions = {}): RateLimitRequestHandler {
  return createJsonRateLimiter({
    windowMs: 60 * 1000,
    max: 300,
    ...overrides,
  });
}

/** Generic public API: 60 requests / min per IP. */
export function createPublicApiLimiter(overrides: PartialOptions = {}): RateLimitRequestHandler {
  return createJsonRateLimiter({
    windowMs: 60 * 1000,
    max: 60,
    ...overrides,
  });
}

/**
 * Answers a refused call in the HTTP transport's own reply shape, so a
 * server caller (`createServerCaller`) reports `RATE_LIMITED` with
 * `retryAfterMs` instead of an unreadable reply.
 */
function callHandler(req: Request, res: Response, _next: NextFunction, options: Options): void {
  const info = (req as Request & Partial<Record<string, { resetTime?: Date }>>)[
    options.requestPropertyName
  ];
  const untilReset =
    info?.resetTime === undefined ? options.windowMs : info.resetTime.getTime() - Date.now();
  const retryAfterMs = Math.max(1000, untilReset);
  if (!res.getHeader("Retry-After")) {
    res.setHeader("Retry-After", String(Math.ceil(retryAfterMs / 1000)));
  }
  res.status(options.statusCode).json({
    ok: false,
    e: { code: "RATE_LIMITED", message: "Rate limit exceeded", data: { retryAfterMs } },
  });
}

/**
 * Calls through the HTTP transport (RFC 0003 section 10), mounted with
 * `createServer({ http: { rateLimit: createCallLimiter() } })`: 300 calls per
 * minute per IP, refused with `429 { ok: false, e: { code: "RATE_LIMITED",
 * message, data: { retryAfterMs } } }`. Server-side prefetch reaches the API
 * from the web server's address, so key it some other way (`keyGenerator`)
 * or raise `max` when the web server prefetches for many users.
 */
export function createCallLimiter(overrides: PartialOptions = {}): RateLimitRequestHandler {
  return createJsonRateLimiter({
    windowMs: 60 * 1000,
    max: 300,
    handler: callHandler,
    ...overrides,
  });
}
