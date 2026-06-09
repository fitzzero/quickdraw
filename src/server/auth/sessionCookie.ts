/**
 * Secure session cookie helpers.
 *
 * Uses a structural response type so the module works with Express (or any
 * compatible framework) without a runtime/type dependency on it.
 */

export const SESSION_COOKIE = "session";

const DEFAULT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface CookieSettings {
  httpOnly: boolean;
  secure: boolean;
  sameSite: "lax" | "none";
  path: string;
  domain?: string;
  maxAge?: number;
}

export interface CookieResponse {
  cookie(name: string, value: string, options: CookieSettings): unknown;
  clearCookie(name: string, options: CookieSettings): unknown;
}

export interface SessionCookieOptions {
  /** Cookie name. Default: "session". */
  cookieName?: string;
  /** Lifetime in ms. Default: 30 days. */
  maxAgeMs?: number;
  /** Cookie domain. Defaults to process.env.COOKIE_DOMAIN. */
  domain?: string;
}

function cookieOptions(options: SessionCookieOptions): CookieSettings {
  const isProd = process.env.NODE_ENV === "production";
  const domain = options.domain ?? process.env.COOKIE_DOMAIN;
  return {
    httpOnly: true,
    secure: isProd,
    // SameSite=None (with Secure) lets the session cookie ride cross-site
    // fetches, so a secondary web origin can hit the primary API host. The
    // CORS allowlist (validateRedirectOrigin) is the actual origin gate. Dev
    // keeps Lax — localhost is http-only and SameSite=None requires Secure.
    sameSite: isProd ? "none" : "lax",
    path: "/",
    ...(domain && { domain }),
  };
}

export function setSessionCookie(
  res: CookieResponse,
  jwt: string,
  options: SessionCookieOptions = {},
): void {
  res.cookie(options.cookieName ?? SESSION_COOKIE, jwt, {
    ...cookieOptions(options),
    maxAge: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS,
  });
}

export function clearSessionCookie(res: CookieResponse, options: SessionCookieOptions = {}): void {
  res.clearCookie(options.cookieName ?? SESSION_COOKIE, cookieOptions(options));
}
