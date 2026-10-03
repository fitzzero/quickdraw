// What every auth route works from, resolved and checked once from
// `createAuthRoutes`' options: the session keys, the origin allowlist, the
// URLs, the cookie, and the process's record of redeemed OAuth states.

import { consoleLogger, type Logger } from "../../../contract/logger";
import { SESSION_COOKIE, type CookieSettings, type SessionCookieOptions } from "../sessionCookie";
import { originAllowlist, type OriginAllowlist } from "./origins";
import type { AuthRouteRequest } from "./respond";
import { OAUTH_STATE_TTL_MS, redeemedStates, type RedeemedStates } from "./state";
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
  readonly name: string;
  readonly ttlMs: number;
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
  return { name: name ?? SESSION_COOKIE, ttlMs, domain, sameSite: sameSite ?? "lax", secure };
}

/** Resolves and checks the options every route uses; throws a `TypeError` for a bad one. */
export function routeSettings(options: AuthRoutesOptions): RouteSettings {
  if (typeof options.onLogin !== "function") {
    throw new TypeError(`${OWNER}: onLogin is required`);
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

/** The session cookie's options for `setSessionCookie` and `clearSessionCookie`. */
export function sessionCookieOf(
  settings: RouteSettings,
  req: AuthRouteRequest,
): SessionCookieOptions {
  const { name, ttlMs, domain, sameSite } = settings.cookie;
  return {
    cookieName: name,
    maxAgeMs: ttlMs,
    sameSite,
    secure: secureFor(settings, req),
    ...(domain !== undefined && { domain }),
  };
}

/**
 * The state cookie's settings: HttpOnly, on the routes' path only, Lax
 * whatever the session cookie's SameSite (the callback is a cross-site
 * navigation from the provider, which a Strict cookie would not ride), and
 * for this host only. Pass `live` to set it, leave it out to clear it.
 */
export function stateCookieOf(
  settings: RouteSettings,
  req: AuthRouteRequest,
  live = false,
): CookieSettings {
  return {
    httpOnly: true,
    secure: secureFor(settings, req),
    sameSite: "lax",
    path: settings.basePath === "" ? "/" : settings.basePath,
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
