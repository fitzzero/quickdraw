// What every auth route works from, resolved and checked once from
// `createAuthRoutes`' options: the session keys, the origin allowlist, the
// URLs, the cookie, and the process's record of redeemed OAuth states.

import { consoleLogger, type Logger } from "../../../contract/logger";
import {
  cookieDomainFromEnv,
  isSecureSessionRequest,
  sessionCookieNameFor,
  type CookieResponse,
  type CookieSettings,
  type SessionCookieNaming,
  type SessionCookieRequest,
} from "../sessionCookie";
import { originAllowlist, rememberRouteOrigins, type OriginAllowlist } from "./origins";
import type { AuthRouteRequest } from "./respond";
import {
  HOST_OAUTH_STATE_COOKIE,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_TTL_MS,
  redeemedStates,
  type RedeemedStates,
} from "./state";
import {
  checkSessionKeys,
  DEFAULT_SESSION_TTL_MS,
  issueSession,
  type IssuedSession,
  type SessionKeys,
} from "./tokens";
import type { AuthRoutesOptions } from "./types";

/** The session cookie, resolved. */
export interface ResolvedCookie {
  /** The name the app gave; without one, it depends on the domain and the request (`sessionCookieName`). */
  readonly name: string | undefined;
  readonly ttlMs: number;
  /** `cookie.domain`, else `COOKIE_DOMAIN` from the environment, else none: the API's host only. */
  readonly domain: string | undefined;
  readonly sameSite: "lax" | "none";
  readonly secure: boolean | undefined;
}

/** What the routes work from. */
export interface RouteSettings {
  readonly keys: SessionKeys;
  readonly origins: OriginAllowlist;
  /** The API's public URL, without a trailing slash. */
  readonly publicUrl: string;
  /** `""` or a path without a trailing slash, such as `"/auth"`. */
  readonly basePath: string;
  readonly successPath: string;
  readonly errorPath: string;
  readonly cookie: ResolvedCookie;
  readonly onLogin: AuthRoutesOptions["onLogin"];
  readonly onRevoke: AuthRoutesOptions["onRevoke"];
  readonly logger: Logger;
  readonly redeemed: RedeemedStates;
  /**
   * Looks at the host a request to the routes arrived for: the first one
   * that is not a loopback address while `publicUrl` is logs an error, once
   * (finding F9.2 of the owner's QA of the template).
   */
  watchHost(req: AuthRouteRequest): void;
}

const OWNER = "createAuthRoutes";

function publicUrlOf(value: unknown): string {
  let url: URL | undefined;
  try {
    url = typeof value === "string" ? new URL(value) : undefined;
  } catch {
    url = undefined;
  }
  if (
    url === undefined ||
    !/^https?:$/.test(url.protocol) ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError(
      `${OWNER}: publicUrl must be the API's public URL, such as "https://api.example.com"`,
    );
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

/** `"/auth/"` and `"auth"` become `"/auth"`; `"/"` becomes `""`. */
function basePathOf(value: unknown): string {
  if (value === undefined) {
    return "/auth";
  }
  if (typeof value !== "string" || /[?#\\]/.test(value)) {
    throw new TypeError(`${OWNER}: basePath must be a path such as "/auth"`);
  }
  const trimmed = value.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "" : `/${trimmed}`;
}

/** A path on the web app's origin; one that could lead to another origin is refused. */
function landingPathOf(value: unknown, name: string, fallback: string): string {
  if (value === undefined) {
    return fallback;
  }
  const probe = "https://origin.invalid";
  const safe =
    typeof value === "string" &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !value.includes("\\") &&
    new URL(value, probe).origin === probe;
  if (!safe) {
    throw new TypeError(`${OWNER}: ${name} must be a path on the web app, such as "/"`);
  }
  return value;
}

function cookieOf(options: AuthRoutesOptions["cookie"]): ResolvedCookie {
  const { name, maxAgeMs, domain, secure, sameSite } = options ?? {};
  const ttlMs = maxAgeMs ?? DEFAULT_SESSION_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000) {
    throw new TypeError(
      `${OWNER}: cookie.maxAgeMs must be a whole number of milliseconds, 1000 or more`,
    );
  }
  if (name !== undefined && !/^[\w!#$%&'*+.^`|~-]+$/.test(name)) {
    throw new TypeError(`${OWNER}: cookie.name must be a cookie name`);
  }
  if (sameSite !== undefined && sameSite !== "lax" && sameSite !== "none") {
    throw new TypeError(`${OWNER}: cookie.sameSite must be "lax" or "none"`);
  }
  const resolvedDomain = domain ?? process.env.COOKIE_DOMAIN;
  const cookieDomain = resolvedDomain === "" ? undefined : resolvedDomain;
  if (name?.startsWith("__Host-") === true && cookieDomain !== undefined) {
    throw new TypeError(
      `${OWNER}: cookie.name cannot start with "__Host-" when the cookie has a domain, which a browser refuses`,
    );
  }
  return { name, ttlMs, domain: cookieDomain, sameSite: sameSite ?? "lax", secure };
}

/**
 * Warns, once at startup, when the routes and the transports would name the
 * session cookie differently: the transports know the cookie's domain only
 * from `COOKIE_DOMAIN`, so a `cookie.domain` that `COOKIE_DOMAIN` does not
 * match makes the routes set `session` over HTTPS where `socketAuth` and the
 * HTTP transport read only `__Host-session` (or the reverse), unless the app
 * names the cookie in all three places.
 */
function warnOnCookieDomain(cookie: ResolvedCookie, logger: Logger): void {
  const transportsSeeDomain = cookieDomainFromEnv() !== undefined;
  if (cookie.name !== undefined || (cookie.domain !== undefined) === transportsSeeDomain) {
    return;
  }
  const why =
    cookie.domain === undefined
      ? 'cookie.domain is "" while COOKIE_DOMAIN is set, so over HTTPS the routes set __Host-session where socketAuth and the HTTP transport read "session" first'
      : 'cookie.domain is set and COOKIE_DOMAIN is not, so the routes set "session" on every request, which socketAuth and the HTTP transport read over HTTPS only under that name';
  logger.warn(
    `${OWNER}: ${why}. Set COOKIE_DOMAIN to the cookie's domain instead, or name the cookie in all three places: cookie.name, socketAuth's cookieName and createServer's http.cookieName.`,
    { category: "quickdraw.auth" },
  );
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** True for a loopback hostname: what a public deployment's `publicUrl` must not be. */
function isLoopback(hostname: string): boolean {
  return LOOPBACK.has(hostname) || hostname.endsWith(".localhost");
}

/** The host a request arrived for: the first `X-Forwarded-Host`, else `Host`; `undefined` without either. */
function requestHost(req: AuthRouteRequest): string | undefined {
  const forwarded = req.headers["x-forwarded-host"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  const host = first !== undefined && first !== "" ? first : req.headers.host;
  return host === undefined || host === "" ? undefined : host;
}

/** Names reserved for tests and examples (RFC 2606): no deployment's page is there. */
const RESERVED_TLD = /\.(test|example|invalid)$/;

/**
 * Warns, once at startup, when `publicUrl` is a loopback address and every
 * allowed origin is not (finding F10.2): the routes would send a browser on
 * one of those pages to a sign-in URL only the server's own machine reaches.
 * Pages under a name reserved for tests (`.test`, `.example`, `.invalid`)
 * do not count: a test suite serves its routes on loopback.
 */
function warnOnLoopbackPublicUrl(
  publicUrl: string,
  origins: readonly string[],
  logger: Logger,
): void {
  const publicHost = new URL(publicUrl).hostname;
  const pages = origins
    .map((origin) => new URL(origin).hostname)
    .filter((hostname) => !RESERVED_TLD.test(hostname));
  if (isLoopback(publicHost) && pages.length > 0 && !pages.some(isLoopback)) {
    logger.warn(
      `${OWNER}: publicUrl is ${publicUrl}, but allowedOrigins lists only public pages (${origins.join(", ")}): a sign-in started from them redirects to an address only this machine reaches. Set publicUrl to the API's public URL.`,
      { category: "quickdraw.auth" },
    );
  }
}

/**
 * The request-time check of a loopback `publicUrl` (finding F9.2): a
 * deployment that fell back to `http://localhost:<port>` for want of its API
 * URL builds every redirect to localhost. The first request that arrives for
 * another host logs an error, once.
 */
function hostWatcher(publicUrl: string, logger: Logger): (req: AuthRouteRequest) => void {
  if (!isLoopback(new URL(publicUrl).hostname)) {
    return () => undefined;
  }
  let warned = false;
  return (req) => {
    const host = warned ? undefined : requestHost(req);
    if (host === undefined) {
      return;
    }
    let hostname: string;
    try {
      hostname = new URL(`http://${host}`).hostname;
    } catch {
      return;
    }
    if (!isLoopback(hostname)) {
      warned = true;
      logger.error(
        `${OWNER}: publicUrl is ${publicUrl}, but requests arrive for ${host}: set publicUrl to the API's public URL (sign-in redirects are built from it)`,
        { category: "quickdraw.auth", publicUrl, host },
      );
    }
  };
}

/** Resolves and checks the options every route uses; throws a `TypeError` for a bad one. */
export function routeSettings(options: AuthRoutesOptions): RouteSettings {
  if (typeof options.onLogin !== "function") {
    throw new TypeError(`${OWNER}: onLogin is required`);
  }
  if (options.onRevoke !== undefined && typeof options.onRevoke !== "function") {
    throw new TypeError(`${OWNER}: onRevoke must be a function of (userId, sessionId)`);
  }
  const successPath = landingPathOf(options.successPath, "successPath", "/");
  const cookie = cookieOf(options.cookie);
  const logger = options.logger ?? consoleLogger;
  const publicUrl = publicUrlOf(options.publicUrl);
  const settings: RouteSettings = Object.freeze({
    keys: checkSessionKeys(options, OWNER),
    origins: originAllowlist(options.allowedOrigins, OWNER),
    publicUrl,
    basePath: basePathOf(options.basePath),
    successPath,
    errorPath: landingPathOf(options.errorPath, "errorPath", successPath),
    cookie,
    onLogin: options.onLogin,
    onRevoke: options.onRevoke,
    logger,
    redeemed: redeemedStates(),
    watchHost: hostWatcher(publicUrl, logger),
  });
  warnOnCookieDomain(cookie, logger);
  warnOnLoopbackPublicUrl(
    publicUrl,
    options.allowedOrigins.filter((origin): origin is string => typeof origin === "string"),
    logger,
  );
  // `requireSession` over the same store applies this list when given none.
  rememberRouteOrigins(settings.keys.sessions, settings.origins);
  return settings;
}

/** Where a provider sends the browser back: `{publicUrl}{basePath}/{id}/callback`. */
export function redirectUriOf(settings: RouteSettings, providerId: string): string {
  return `${settings.publicUrl}${settings.basePath}/${providerId}/callback`;
}

/** Where a sign-in lands on `origin`: the success path, or the error path with `?error=`. */
export function landingOf(settings: RouteSettings, origin: string, error?: string): string {
  const url = new URL(error === undefined ? settings.successPath : settings.errorPath, origin);
  if (error !== undefined) {
    url.searchParams.set("error", error);
  }
  return url.href;
}

/**
 * Whether a cookie the routes set on `req` is Secure, unless the app said
 * otherwise: in production, and on a request that came over HTTPS by the
 * rule the session cookie's name follows (`isSecureRequest`).
 */
function secureFor(settings: RouteSettings, req: SessionCookieRequest): boolean {
  return (
    settings.cookie.secure ?? (process.env.NODE_ENV === "production" || isSecureSessionRequest(req))
  );
}

/** How the app named the session cookie, for `sessionCookieNameFor` and the reads. */
export function sessionCookieNaming(settings: RouteSettings): SessionCookieNaming {
  return { cookieName: settings.cookie.name, domain: settings.cookie.domain };
}

/**
 * The session cookie's name on `req`, by the rule `socketAuth`, the HTTP
 * transport and `setSessionCookie` share (`sessionCookieNameFor`): the name
 * the app gave; else `session` when the cookie has a domain, which cannot be
 * `__Host-`; else `__Host-session` on a request over HTTPS, which a browser
 * keeps only as a Secure, host-only cookie on `/`, so no other site under
 * the same parent domain can plant or replace it, and `session` over plain
 * HTTP (development).
 */
export function sessionCookieName(settings: RouteSettings, req: SessionCookieRequest): string {
  return sessionCookieNameFor(req, sessionCookieNaming(settings));
}

/**
 * The session cookie's settings on `req`: set (`live`) or cleared. Secure
 * when its name is `__Host-` (which a browser requires) or it is
 * SameSite=None (likewise), else as `secureFor` says.
 */
function sessionCookieSettings(
  settings: RouteSettings,
  req: SessionCookieRequest,
  name: string,
  live: boolean,
): CookieSettings {
  const { ttlMs, domain, sameSite } = settings.cookie;
  const hostOnly = name.startsWith("__Host-");
  return {
    httpOnly: true,
    secure: hostOnly || sameSite === "none" || secureFor(settings, req),
    sameSite,
    path: "/",
    ...(domain !== undefined && !hostOnly && { domain }),
    ...(live && { maxAge: ttlMs }),
  };
}

/**
 * `req` as the page a sign-in returns to sends it: an OAuth callback is a
 * navigation from the provider and carries no `Origin`, so the return
 * origin stands in for it, and a sign-in for an `https:` page gets the
 * cookie that page's own requests read.
 */
function fromPage(req: AuthRouteRequest, pageOrigin: string | undefined): SessionCookieRequest {
  if (pageOrigin === undefined || req.headers.origin !== undefined) {
    return req;
  }
  return {
    headers: { ...req.headers, origin: pageOrigin },
    secure: req.secure,
    socket: req.socket,
  };
}

/**
 * Sets the session cookie carrying `token`, for the cookie, the JWT and the
 * session to end together; `pageOrigin` is the page an OAuth callback
 * returns to.
 */
export function setSession(
  res: CookieResponse,
  settings: RouteSettings,
  req: AuthRouteRequest,
  token: string,
  pageOrigin?: string,
): void {
  const from = fromPage(req, pageOrigin);
  const name = sessionCookieName(settings, from);
  res.cookie(name, token, sessionCookieSettings(settings, from, name, true));
}

/** Clears the session cookie. */
export function clearSession(
  res: CookieResponse,
  settings: RouteSettings,
  req: AuthRouteRequest,
): void {
  const name = sessionCookieName(settings, req);
  res.clearCookie(name, sessionCookieSettings(settings, req, name, false));
}

/** The state cookie's name on `req`: `__Host-qd_oauth` when it is Secure, else `qd_oauth`. */
export function stateCookieName(settings: RouteSettings, req: AuthRouteRequest): string {
  return secureFor(settings, req) ? HOST_OAUTH_STATE_COOKIE : OAUTH_STATE_COOKIE;
}

/**
 * The state cookie's settings: HttpOnly, Lax whatever the session cookie's
 * SameSite (the callback is a cross-site navigation from the provider, which
 * a Strict cookie would not ride), and for this host only; on `/` when it is
 * Secure, as its `__Host-` name requires, else on the routes' path only.
 * Pass `live` to set it, leave it out to clear it.
 */
export function stateCookieOf(
  settings: RouteSettings,
  req: AuthRouteRequest,
  live = false,
): CookieSettings {
  const secure = secureFor(settings, req);
  return {
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: secure || settings.basePath === "" ? "/" : settings.basePath,
    ...(live && { maxAge: OAUTH_STATE_TTL_MS }),
  };
}

/** Starts a session for `userId` signed in through `provider`, recording where from. */
export function issueFor(
  settings: RouteSettings,
  userId: string,
  provider: string,
  req: AuthRouteRequest,
): Promise<IssuedSession> {
  const userAgent = req.headers["user-agent"];
  const meta = {
    provider,
    ...(typeof userAgent === "string" && { userAgent }),
    ...(typeof req.ip === "string" && { ip: req.ip }),
  };
  return issueSession(settings.keys, userId, meta, settings.cookie.ttlMs);
}
