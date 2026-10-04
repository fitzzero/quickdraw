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
// call, so a revoked session fails even while its JWT has not expired. A
// socket's session is recorded (`recordSocketSession`), so the app can end
// that session's open sockets when it revokes it: wire `createAuthRoutes`'
// `onRevoke` to `server.access.disconnectUser`.
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
//
// The cookie is read under the names the auth routes' rule gives the
// handshake (`sessionCookieNamesFor`): a configured `cookieName`; else
// `session` when `COOKIE_DOMAIN` gives the cookie a domain; else, over HTTPS,
// only `__Host-session` (a site under the same parent domain can plant a
// plain `session` cookie, and a secure handshake must not take it in place of
// the host-only one), and over plain HTTP `session`, then `__Host-session`.

import type { IncomingHttpHeaders } from "node:http";
import { QuickdrawError } from "../../../protocol/errors";
import {
  recordSocketSession,
  type AuthenticateRequest,
  type SocketAuthenticateRequest,
} from "../../transports/auth";
import { cookiesOf, cookieToken, transportCookieNaming } from "../../transports/body";
import type { MaybePromise, Principal } from "../../types";
import {
  sessionCookieNamesFor,
  type SessionCookieNaming,
  type SessionCookieRequest,
} from "../sessionCookie";
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
  /**
   * The session cookie's name. Default: the name the auth routes set on the
   * same handshake: `"session"` when `COOKIE_DOMAIN` gives the cookie a
   * domain; else `"__Host-session"` over HTTPS, where the plain name a
   * sibling site could plant is never read, and `"session"` (then
   * `"__Host-session"`) over plain HTTP. A name given here is the only one
   * read, on any handshake: give the routes' `cookie.name` here, or
   * `"session"` when their `cookie.domain` is set without `COOKIE_DOMAIN`. A
   * name the handshake repeats counts as no credential.
   */
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

/** A socket's handshake, as its session cookie's name depends on it: its headers, and whether TLS ended here. */
function handshakeOf(request: SocketAuthenticateRequest): SessionCookieRequest {
  const { handshake } = request.socket as Partial<
    Pick<SocketAuthenticateRequest["socket"], "handshake">
  >;
  return { headers: request.headers, secure: handshake?.secure === true };
}

function credentialOf(
  request: AuthenticateRequest,
  naming: SessionCookieNaming,
): Credential | null {
  const { token } = request.auth;
  if (typeof token === "string" && token !== "") {
    return { token, checkOrigin: false };
  }
  if (request.transport === "http") {
    return null;
  }
  const names = sessionCookieNamesFor(handshakeOf(request), naming);
  const cookie = cookieToken(cookiesOf({ headers: request.headers }), names);
  return cookie === null ? null : { token: cookie, checkOrigin: true };
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
  const naming = transportCookieNaming(options.cookieName);
  const allowMissing = options.allowMissingOrigin === true;
  const { loadPrincipal } = options;
  if (loadPrincipal !== undefined && typeof loadPrincipal !== "function") {
    throw new TypeError("socketAuth: loadPrincipal must be a function");
  }
  return async (request) => {
    const credential = credentialOf(request, naming);
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
    if (request.transport === "socket") {
      // So `server.access.disconnectUser(userId, { sessionId })` can end this session's sockets.
      recordSocketSession(request.socket, session.id);
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
