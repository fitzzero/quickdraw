// What every auth route works from, resolved and checked once from
// `createAuthRoutes`' options: the session keys, the origin allowlist, the
// URLs, the cookie, and the process's record of redeemed OAuth states.

import { consoleLogger, type Logger } from "../../../contract/logger";
import {
  HOST_SESSION_COOKIE,
  SESSION_COOKIE,
  type CookieResponse,
  type CookieSettings,
} from "../sessionCookie";
import { originAllowlist, type OriginAllowlist } from "./origins";
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
  /** The name the app gave; without one, it depends on the request (`sessionCookieName`). */
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
  return {
    name,
    ttlMs,
    domain: resolvedDomain === "" ? undefined : resolvedDomain,
    sameSite: sameSite ?? "lax",
    secure,
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
  return Object.freeze({
    keys: checkSessionKeys(options, OWNER),
    origins: originAllowlist(options.allowedOrigins, OWNER),
    publicUrl: publicUrlOf(options.publicUrl),
    basePath: basePathOf(options.basePath),
    successPath,
    errorPath: landingPathOf(options.errorPath, "errorPath", successPath),
    cookie: cookieOf(options.cookie),
    onLogin: options.onLogin,
    onRevoke: options.onRevoke,
    logger: options.logger ?? consoleLogger,
    redeemed: redeemedStates(),
  });
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

/** Secure unless the app said otherwise: in production, and for a request that came over HTTPS. */
function secureFor(settings: RouteSettings, req: AuthRouteRequest): boolean {
  return settings.cookie.secure ?? (process.env.NODE_ENV === "production" || req.secure === true);
}

/** Whether the session cookie is Secure on `req`: always with SameSite=None, which browsers require it of. */
function secureSession(settings: RouteSettings, req: AuthRouteRequest): boolean {
  return settings.cookie.sameSite === "none" || secureFor(settings, req);
}

/**
 * The session cookie's name on `req`: the name the app gave; else, when no
 * domain is configured and the cookie is Secure, `__Host-session`, which a
 * browser keeps only as a Secure, host-only cookie on `/`, so no other site
 * under the same parent domain can plant or replace it; else `session` (a
 * domain cookie cannot be `__Host-`, nor can a cookie set over plain HTTP in
 * development).
 */
export function sessionCookieName(settings: RouteSettings, req: AuthRouteRequest): string {
  const { name, domain } = settings.cookie;
  if (name !== undefined) {
    return name;
  }
  return domain === undefined && secureSession(settings, req)
    ? HOST_SESSION_COOKIE
    : SESSION_COOKIE;
}

/** The session cookie's settings on `req`: set (`live`) or cleared. */
function sessionCookieSettings(
  settings: RouteSettings,
  req: AuthRouteRequest,
  live: boolean,
): CookieSettings {
  const { ttlMs, domain, sameSite } = settings.cookie;
  return {
    httpOnly: true,
    secure: secureSession(settings, req),
    sameSite,
    path: "/",
    ...(domain !== undefined && { domain }),
    ...(live && { maxAge: ttlMs }),
  };
}

/** Sets the session cookie carrying `token`, for the cookie, the JWT and the session to end together. */
export function setSession(
  res: CookieResponse,
  settings: RouteSettings,
  req: AuthRouteRequest,
  token: string,
): void {
  res.cookie(sessionCookieName(settings, req), token, sessionCookieSettings(settings, req, true));
}

/** Clears the session cookie. */
export function clearSession(
  res: CookieResponse,
  settings: RouteSettings,
  req: AuthRouteRequest,
): void {
  res.clearCookie(sessionCookieName(settings, req), sessionCookieSettings(settings, req, false));
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
