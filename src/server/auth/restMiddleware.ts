/**
 * REST authentication middleware factory.
 *
 * Authenticates requests via session cookie or Bearer token, verifies the JWT,
 * then checks session revocation via an injected lookup (the app owns the
 * database). Uses structural request/response types so there is no runtime or
 * type dependency on Express.
 */

import { verifyJWT } from "./jwt";
import { SESSION_COOKIE } from "./sessionCookie";

export interface AuthRequest {
  cookies?: Record<string, string>;
  headers: { authorization?: string };
  userId?: string;
}

export interface AuthResponse {
  status(code: number): { json(body: unknown): unknown };
}

export interface RequireAuthOptions {
  /**
   * Look up the session for a token. Return null when the session does not
   * exist; sessions past expiresAt are rejected. This mirrors the socket auth
   * path so a revoked/logged-out session can no longer authenticate REST
   * requests until the JWT naturally expires.
   */
  getSession: (token: string) => Promise<{ expiresAt: Date } | null>;
  /** JWT signing secret. Defaults to process.env.JWT_SECRET. */
  jwtSecret?: string;
  /** Cookie to read the JWT from. Default: "session". */
  cookieName?: string;
}

/**
 * Extract a JWT from the session cookie or Authorization header
 * (cookie takes priority).
 */
export function extractBearerOrCookieToken(
  req: AuthRequest,
  cookieName: string = SESSION_COOKIE,
): string | null {
  const cookieToken = req.cookies?.[cookieName];
  if (cookieToken) return cookieToken;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);

  return null;
}

/**
 * Create an Express-compatible middleware that attaches req.userId on success
 * and responds 401 on failure.
 */
export function createRequireAuth(
  options: RequireAuthOptions,
): (req: AuthRequest, res: AuthResponse, next: () => void) => Promise<void> {
  return async (req, res, next) => {
    const token = extractBearerOrCookieToken(req, options.cookieName);
    if (!token) {
      res.status(401).json({ error: "Missing or invalid authorization" });
      return;
    }

    const secret = options.jwtSecret ?? process.env.JWT_SECRET;
    if (!secret) {
      res.status(401).json({ error: "Authentication is not configured" });
      return;
    }

    const payload = await verifyJWT(token, secret);
    if (!payload?.userId) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    const session = await options.getSession(token);
    if (!session || session.expiresAt < new Date()) {
      res.status(401).json({ error: "Session expired or revoked" });
      return;
    }

    req.userId = payload.userId;
    next();
  };
}
