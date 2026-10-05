// The options of `createAuthRoutes` (RFC 0003 section 12.6).

import type { Logger } from "../../../contract/logger";
import type { MaybePromise } from "../../types";
import type { GuestProvider } from "./guest";
import type { AuthRateLimits } from "./limits";
import type { AllowedOrigin } from "./origins";
import type { AuthProfile, MockSignInProvider, OAuthSignInProvider } from "./providers";
import type { AuthRouteRequest, AuthRouteResponse } from "./respond";
import type { SessionStore } from "./sessions";

/** A sign-in provider: `google()`, `discord()`, `mock()`, `guest()`, or the app's own OAuth provider. */
export type AuthProvider = OAuthSignInProvider | MockSignInProvider | GuestProvider;

/** The session cookie. */
export interface AuthCookieOptions {
  /**
   * Its name. Default, by the rule `socketAuth`, the HTTP transport and
   * `setSessionCookie` share: `"session"` when the cookie has a domain
   * (which a `__Host-` cookie cannot have); else `"__Host-session"` on a
   * request over HTTPS (`req.secure`, `X-Forwarded-Proto: https`, an
   * `https:` `Origin`, or for an OAuth callback an `https:` return origin),
   * which a browser keeps host-only on `/`, so no other site under the same
   * parent domain can plant or replace it; and `"session"` over plain HTTP.
   * A name given here must be given to `socketAuth` and the HTTP transport
   * too (`cookieName`, `http.cookieName`).
   */
  readonly name?: string;
  /** How long a session lasts: the cookie, the JWT and the stored session end together. Default 7 days. */
  readonly maxAgeMs?: number;
  /**
   * Its domain, to share it with subdomains; the cookie is then `session`
   * on every request. Default `process.env.COOKIE_DOMAIN` (read when the
   * routes are made), else the API's host only. `socketAuth` and the HTTP
   * transport see the domain only through `COOKIE_DOMAIN`: a domain given
   * only here needs `cookieName: "session"` there, and the routes warn at
   * startup until the cookie is named.
   */
  readonly domain?: string;
  /**
   * Default: true when `NODE_ENV` is `"production"` or the request came
   * over HTTPS (as for the name). A `__Host-` cookie is always Secure, so
   * `false` applies to a cookie set over plain HTTP.
   */
  readonly secure?: boolean;
  /**
   * Default `"lax"`. `"none"` (always Secure) lets the cookie ride
   * cross-site requests, for a web app on another site than the API.
   */
  readonly sameSite?: "lax" | "none";
}

/** Options of `createAuthRoutes`. */
export interface AuthRoutesOptions {
  /**
   * The ways to sign in. Provider ids are unique. `undefined`, `null` and
   * `false` entries are skipped, so a provider whose credentials an
   * environment lacks can be left out in place (`google.optional(...)`, or
   * `env.GOOGLE_CLIENT_ID !== undefined && google(...)`); at least one must
   * remain.
   */
  readonly providers: readonly (AuthProvider | null | undefined | false)[];
  /** Where sessions are stored; `createMemorySessionStore()` in development and tests. */
  readonly sessions: SessionStore;
  /** Signs the session JWTs; at least 32 characters. `socketAuth` needs the same secret. */
  readonly jwtSecret: string;
  /**
   * Finds or creates the app's user for a provider's profile (and its
   * account row) and returns the user's id. Returning `null` refuses the
   * sign-in (`?error=denied`); throwing fails it (`?error=failed`).
   */
  readonly onLogin: (
    profile: AuthProfile,
    provider: string,
  ) => MaybePromise<string | null | undefined>;
  /**
   * The web app's origins: where a sign-in may return to, and (passed to
   * `socketAuth` too) which pages may open a socket with the session cookie.
   */
  readonly allowedOrigins: readonly AllowedOrigin[];
  /**
   * The API's public URL, such as `"https://api.example.com"`. Each
   * provider's redirect URI is `{publicUrl}{basePath}/{provider}/callback`.
   */
  readonly publicUrl: string;
  /** The path the routes are served under, whatever the app mounts them at. Default `"/auth"`. */
  readonly basePath?: string;
  /** Where a sign-in lands on its return origin. Default `"/"`. */
  readonly successPath?: string;
  /** Where a failed sign-in lands, with `?error=state`, `denied` or `failed`. Default `successPath`. */
  readonly errorPath?: string;
  readonly cookie?: AuthCookieOptions;
  /** The routes' rate limiters, or `false` for none. Default: the Express presets (see `AuthRateLimits`). */
  readonly rateLimit?: AuthRateLimits | false;
  /**
   * Called once `logout` revoked a session (`sessionId`) or `logout-all`
   * every session of the user (`null`), so the app can end the sockets still
   * open with them, which keep their principal until they reconnect:
   * `(userId, sessionId) => server.access.disconnectUser(userId, sessionId
   * === null ? {} : { sessionId })`. A failure is logged; the sign-out stands.
   */
  readonly onRevoke?: (userId: string, sessionId: string | null) => MaybePromise<unknown>;
  /** Default: the console. */
  readonly logger?: Logger;
}

/**
 * The routes, as one Express middleware: mount it with `app.use(routes)`. A
 * request for a path it does not serve goes on to `next()`.
 */
export type AuthRoutes = ((
  req: AuthRouteRequest,
  res: AuthRouteResponse,
  next: (error?: unknown) => void,
) => void) & {
  /**
   * The sign-ins the routes serve now, in the order `providers` lists them:
   * what `GET {basePath}/providers` answers. The mock is in it only while it
   * is mounted and `isMockOAuthEnabled()`.
   */
  providers(): readonly AuthProviderInfo[];
};

/** A sign-in the auth routes serve, as `GET {basePath}/providers` lists it. */
export interface AuthProviderInfo {
  /** Its id: `GET {basePath}/{id}/start` starts it; a guest's is `POST {basePath}/guest`. */
  readonly id: string;
  /** A name to show on its button: `"Google"`, `"Discord"`, `"Mock"`, `"Guest"`, or an OAuth provider's own. */
  readonly name: string;
  /** `"oauth"` (a redirecting provider), `"mock"` (the development picker) or `"guest"`. */
  readonly kind: AuthProvider["kind"];
}
