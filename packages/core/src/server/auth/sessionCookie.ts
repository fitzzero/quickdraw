/**
 * The session cookie: the one rule its name follows, written and read, and
 * the 4.x helpers that set and clear it.
 *
 * Uses structural request and response types so the module works with
 * Express (or any compatible framework) without a runtime/type dependency on
 * it.
 */

import type { IncomingHttpHeaders } from "node:http";

export const SESSION_COOKIE = "session";

/**
 * The session cookie's name on a secure request when no cookie domain is
 * configured. The `__Host-` prefix makes a browser keep it only when it is
 * Secure, has `Path=/` and no `Domain`, so no other site under the same
 * parent domain can set or replace it.
 */
export const HOST_SESSION_COOKIE = "__Host-session";

// Matches the default JWT expiry ("7d" in jwt.ts) — a cookie that outlives
// its JWT just keeps sending a token the server will reject. Pass maxAgeMs
// if your JWT lifetime differs.
const DEFAULT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * A request or a socket handshake, as far as the session cookie's name
 * depends on it: its headers, Express's `req.secure` (which follows
 * `X-Forwarded-Proto` behind `trust proxy`) or a Socket.IO handshake's
 * `secure`, and its connection.
 */
export interface SessionCookieRequest {
  readonly headers: IncomingHttpHeaders;
  readonly secure?: unknown;
  /** The connection: TLS ended at this server when it is `encrypted`. */
  readonly socket?: unknown;
}

/** How an app named its session cookie: a name it gave, and the domain it shares the cookie with. */
export interface SessionCookieNaming {
  readonly cookieName?: string | undefined;
  /** `undefined` or `""`: no domain, the API's host only. */
  readonly domain?: string | undefined;
}

/**
 * True when a request or a socket handshake came over HTTPS: `tls` says its
 * connection did (TLS ended at this server, Express's `req.secure`, or a
 * Socket.IO handshake's `secure`), a proxy says so (`X-Forwarded-Proto:
 * https`), or it came from an `https:` page (`Origin`), which a browser lets
 * reach only `https:` URLs and loopback hosts. Each signal only narrows the
 * session cookies read (`sessionCookieNamesFor`), so none of them needs to
 * be trusted.
 */
export function isSecureRequest(headers: IncomingHttpHeaders, tls: boolean): boolean {
  if (tls) {
    return true;
  }
  const forwarded = headers["x-forwarded-proto"];
  const proto = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",", 1)[0];
  if (proto?.trim().toLowerCase() === "https") {
    return true;
  }
  const { origin } = headers;
  return typeof origin === "string" && origin.toLowerCase().startsWith("https:");
}

/** {@link isSecureRequest} for a request: its TLS connection, or its `secure` flag, and its headers. */
export function isSecureSessionRequest(req: SessionCookieRequest): boolean {
  const connection = req.socket;
  const encrypted =
    typeof connection === "object" &&
    connection !== null &&
    (connection as { readonly encrypted?: unknown }).encrypted === true;
  return isSecureRequest(req.headers, req.secure === true || encrypted);
}

function hasDomain(domain: string | undefined): domain is string {
  return domain !== undefined && domain !== "";
}

/** The cookie domain from the environment (`COOKIE_DOMAIN`), or `undefined` for none. */
export function cookieDomainFromEnv(): string | undefined {
  const domain = process.env.COOKIE_DOMAIN;
  return hasDomain(domain) ? domain : undefined;
}

/**
 * The session cookie's name on `req`, the one rule the auth routes,
 * `setSessionCookie`, `socketAuth` and the HTTP transport all follow: the
 * name the app gave; else `session` when the cookie has a domain (a domain
 * cookie cannot be `__Host-`); else `__Host-session` on a request that came
 * over HTTPS ({@link isSecureRequest}), and `session` on a plain HTTP one.
 */
export function sessionCookieNameFor(
  req: SessionCookieRequest,
  naming: SessionCookieNaming = {},
): string {
  if (naming.cookieName !== undefined) {
    return naming.cookieName;
  }
  if (hasDomain(naming.domain)) {
    return SESSION_COOKIE;
  }
  return isSecureSessionRequest(req) ? HOST_SESSION_COOKIE : SESSION_COOKIE;
}

const SECURE_SESSION_COOKIES: readonly string[] = Object.freeze([HOST_SESSION_COOKIE]);

const PLAIN_SESSION_COOKIES: readonly string[] = Object.freeze([
  SESSION_COOKIE,
  HOST_SESSION_COOKIE,
]);

/**
 * The cookie names a session is read from on `req`, the first of them being
 * the name {@link sessionCookieNameFor} writes for the same request. A name
 * the app gave is the only one read. Otherwise a secure request reads only
 * `__Host-session`: a site under the same parent domain can set a `session`
 * cookie for the whole domain, and while the user holds no `__Host-session`
 * that planted cookie would sign them in as whoever planted it. A plain HTTP
 * request, or a cookie with a domain, reads `session` and then
 * `__Host-session`, which only this host can have set.
 */
export function sessionCookieNamesFor(
  req: SessionCookieRequest,
  naming: SessionCookieNaming = {},
): readonly string[] {
  if (naming.cookieName !== undefined) {
    return [naming.cookieName];
  }
  return sessionCookieNameFor(req, naming) === HOST_SESSION_COOKIE
    ? SECURE_SESSION_COOKIES
    : PLAIN_SESSION_COOKIES;
}

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
  /**
   * Cookie name. Default: the name the auth routes use on the same request
   * (`__Host-session` over HTTPS without a domain, else `session`), which
   * `socketAuth` and the HTTP transport read; it is read from the response's
   * request (`res.req`, which Express and Node set), and is `session`
   * without one.
   */
  cookieName?: string;
  /** Lifetime in ms. Default: 7 days (matches the default JWT expiry). */
  maxAgeMs?: number;
  /** Cookie domain. Defaults to process.env.COOKIE_DOMAIN. */
  domain?: string;
  /**
   * SameSite. Default: "none" in production, "lax" otherwise. A "none"
   * cookie is always Secure, because browsers drop one that is not.
   */
  sameSite?: "lax" | "none";
  /** Secure. Default: true in production or over HTTPS; a `__Host-` cookie always is. */
  secure?: boolean;
}

function isSessionCookieRequest(value: unknown): value is SessionCookieRequest {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { headers } = value as { readonly headers?: unknown };
  return typeof headers === "object" && headers !== null;
}

/** The request a response answers (`res.req`), when it has one. */
function requestOf(res: CookieResponse): SessionCookieRequest {
  const req: unknown = Reflect.get(res, "req");
  return isSessionCookieRequest(req) ? req : { headers: {} };
}

function sessionCookie(
  res: CookieResponse,
  options: SessionCookieOptions,
): { readonly name: string; readonly settings: CookieSettings } {
  const isProd = process.env.NODE_ENV === "production";
  const domain = options.domain ?? cookieDomainFromEnv();
  const req = requestOf(res);
  const name = sessionCookieNameFor(req, { cookieName: options.cookieName, domain });
  const hostOnly = name.startsWith("__Host-");
  // SameSite=None (with Secure) lets the session cookie ride cross-site
  // fetches, so a secondary web origin can hit the primary API host. The
  // CORS allowlist (validateRedirectOrigin) is the actual origin gate. Dev
  // keeps Lax — localhost is http-only and SameSite=None requires Secure.
  const sameSite = options.sameSite ?? (isProd ? "none" : "lax");
  return {
    name,
    settings: {
      httpOnly: true,
      secure:
        hostOnly ||
        sameSite === "none" ||
        (options.secure ?? (isProd || isSecureSessionRequest(req))),
      sameSite,
      path: "/",
      ...(hasDomain(domain) && !hostOnly && { domain }),
    },
  };
}

/**
 * Sets the session cookie, under the name {@link sessionCookieNameFor} gives
 * the response's request, so `socketAuth` and the HTTP transport read it.
 */
export function setSessionCookie(
  res: CookieResponse,
  jwt: string,
  options: SessionCookieOptions = {},
): void {
  const { name, settings } = sessionCookie(res, options);
  res.cookie(name, jwt, { ...settings, maxAge: options.maxAgeMs ?? DEFAULT_MAX_AGE_MS });
}

/** Clears the session cookie `setSessionCookie` sets on the same request. */
export function clearSessionCookie(res: CookieResponse, options: SessionCookieOptions = {}): void {
  const { name, settings } = sessionCookie(res, options);
  res.clearCookie(name, settings);
}
