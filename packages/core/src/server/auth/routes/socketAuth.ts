// `socketAuth` (RFC 0003 section 12.6): the `authenticate` function that
// `createServer({ auth: { authenticate } })` uses for the sessions the auth
// routes issue, on sockets and HTTP calls alike.
//
// A socket's credential is its handshake's `auth.token` (a bearer token, for
// native and other cookie-less clients), else the session cookie from the
// handshake's headers. An HTTP call's is the one the HTTP transport found,
// the session cookie else the bearer token. No credential: anonymous. A
// credential that does not stand for a live session is refused with
// `UNAUTHENTICATED`, checked against the session store on every handshake and
// call, so a revoked session fails even while its JWT has not expired.
//
// The session cookie is ambient: a browser sends it with a WebSocket
// handshake that any page opens, and WebSockets are not subject to CORS. So a
// socket that authenticates with the cookie must come from an allowed page:
// its `Origin` header must be in `allowedOrigins`. A handshake with no
// `Origin` is refused too, except a same-origin one (`Sec-Fetch-Site:
// same-origin`, which a browser sends on its own page's long-polling requests
// and which no other page can forge), or with `allowMissingOrigin` for native
// clients that keep cookies. A bearer token is not ambient and needs no
// Origin; HTTP calls are guarded by their required JSON content type instead
// (RFC 0003 section 10).

import type { IncomingHttpHeaders } from "node:http";
import { QuickdrawError } from "../../../protocol/errors";
import type { AuthenticateRequest } from "../../transports/auth";
import { cookiesOf } from "../../transports/body";
import type { MaybePromise, Principal } from "../../types";
import { SESSION_COOKIE } from "../sessionCookie";
import { originAllowlist, type AllowedOrigin, type OriginAllowlist } from "./origins";
import type { AuthSession, SessionStore } from "./sessions";
import { checkSessionKeys, liveSession } from "./tokens";

/** Builds the principal of a session's user; `null` refuses the connection. */
export type PrincipalLoader<P extends Principal> = (
  userId: string,
  session: AuthSession,
) => MaybePromise<P | null | undefined>;

/** Options of {@link socketAuth}. */
export interface SocketAuthOptions<P extends Principal = Principal> {
  /** The store the auth routes write sessions to. */
  readonly sessions: SessionStore;
  /** The secret the auth routes sign session JWTs with. */
  readonly jwtSecret: string;
  /** The web app's origins, the same list as `createAuthRoutes`' `allowedOrigins`. */
  readonly allowedOrigins: readonly AllowedOrigin[];
  /**
   * Accept a cookie-authenticated handshake that has no `Origin` header, for
   * native clients that keep cookies. Default `false`. A handshake whose
   * `Origin` is not allowed is refused either way.
   */
  readonly allowMissingOrigin?: boolean;
  /** The session cookie's name. Default `"session"`. */
  readonly cookieName?: string;
  /**
   * Builds the principal, for example with `kind` and the user's
   * `serviceAccess`; its `userId` must be the session's. Default
   * `{ userId, kind: "user" }`, whose grants `createServer`'s
   * `auth.loadServiceAccess` then loads.
   */
  readonly loadPrincipal?: PrincipalLoader<P>;
}

/** What {@link socketAuth} returns: an `authenticate` for `createServer`'s `auth`. */
export type SessionAuthenticate<P extends Principal> = (
  request: AuthenticateRequest,
) => Promise<P | null>;

interface Credential {
  readonly token: string;
  /** True for a socket authenticated by the ambient session cookie. */
  readonly checkOrigin: boolean;
}

function credentialOf(request: AuthenticateRequest, cookieName: string): Credential | null {
  const { token } = request.auth;
  if (typeof token === "string" && token !== "") {
    return { token, checkOrigin: false };
  }
  if (request.transport === "http") {
    return null;
  }
  const cookie = cookiesOf({ headers: request.headers })[cookieName];
  return cookie === undefined || cookie === "" ? null : { token: cookie, checkOrigin: true };
}

function originAccepted(
  headers: IncomingHttpHeaders,
  origins: OriginAllowlist,
  allowMissing: boolean,
): boolean {
  const { origin } = headers;
  if (origin !== undefined) {
    return origins.allowed(origin) !== null;
  }
  return allowMissing || headers["sec-fetch-site"] === "same-origin";
}

function refused(message: string): QuickdrawError {
  return new QuickdrawError("UNAUTHENTICATED", message);
}

/**
 * The `authenticate` for `createServer` over the auth routes' sessions:
 * `createServer({ auth: { authenticate: socketAuth({ sessions, jwtSecret, allowedOrigins }) } })`.
 */
export function socketAuth<P extends Principal>(
  options: SocketAuthOptions<P> & { readonly loadPrincipal: PrincipalLoader<P> },
): SessionAuthenticate<P>;
export function socketAuth(options: SocketAuthOptions): SessionAuthenticate<Principal>;
export function socketAuth(options: SocketAuthOptions): SessionAuthenticate<Principal> {
  const keys = checkSessionKeys(options, "socketAuth");
  const origins = originAllowlist(options.allowedOrigins, "socketAuth", true);
  const cookieName = options.cookieName ?? SESSION_COOKIE;
  const allowMissing = options.allowMissingOrigin === true;
  const { loadPrincipal } = options;
  if (loadPrincipal !== undefined && typeof loadPrincipal !== "function") {
    throw new TypeError("socketAuth: loadPrincipal must be a function");
  }
  return async (request) => {
    const credential = credentialOf(request, cookieName);
    if (credential === null) {
      return null;
    }
    if (credential.checkOrigin && !originAccepted(request.headers, origins, allowMissing)) {
      throw refused("This page's origin may not use the session cookie on a socket");
    }
    const session = await liveSession(keys, credential.token);
    if (session === null) {
      throw refused("The session is not valid");
    }
    if (loadPrincipal === undefined) {
      return { userId: session.userId, kind: "user" };
    }
    const principal = await loadPrincipal(session.userId, session);
    if (principal === null || principal === undefined) {
      throw refused("The session's user has no principal");
    }
    if (principal.userId !== session.userId) {
      throw new TypeError(
        "socketAuth: loadPrincipal must return the principal of the session's user",
      );
    }
    return principal;
  };
}
