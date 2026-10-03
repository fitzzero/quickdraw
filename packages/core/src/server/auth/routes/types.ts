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
   * Its name. Default: `"__Host-session"` when no domain is configured and
   * the cookie is Secure (a browser then keeps it host-only on `/`, so no
   * other site under the same parent domain can plant or replace it), else
   * `"session"`. `socketAuth` and the HTTP transport read both by default;
   * name the same cookie there (`cookieName`, `http.cookieName`) when
   * changing it.
   */
  readonly name?: string;
  /** How long a session lasts: the cookie, the JWT and the stored session end together. Default 7 days. */
  readonly maxAgeMs?: number;
  /**
   * Its domain, to share it with subdomains. Default `process.env.COOKIE_DOMAIN`
   * (read when the routes are made), else the API's host only.
   */
  readonly domain?: string;
  /** Default: true when `NODE_ENV` is `"production"` or the request came over HTTPS (`req.secure`). */
  readonly secure?: boolean;
  /**
   * Default `"lax"`. `"none"` (always Secure) lets the cookie ride
   * cross-site requests, for a web app on another site than the API.
   */
  readonly sameSite?: "lax" | "none";
}

/** Options of `createAuthRoutes`. */
export interface AuthRoutesOptions {
  /** The ways to sign in. Provider ids are unique. */
  readonly providers: readonly AuthProvider[];
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
  /** Default: the console. */
  readonly logger?: Logger;
}

/**
 * The routes, as one Express middleware: mount it with `app.use(routes)`. A
 * request for a path it does not serve goes on to `next()`.
 */
export type AuthRoutes = (
  req: AuthRouteRequest,
  res: AuthRouteResponse,
  next: (error?: unknown) => void,
) => void;
