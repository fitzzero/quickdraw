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
// Origin.
//
// An HTTP call that sends the cookie gets the same check (finding F7.1 of the
// quickdraw-chat review; before rc.5 it relied on its required JSON content
// type and the app's CORS alone): an `Origin` outside `allowedOrigins` is
// answered `FORBIDDEN`. A call without `Origin` is accepted, since a browser
// sends one with every POST: it comes from curl or a server rendering a page
// with the user's cookie, unless `Sec-Fetch-Site` says another site sent it.
//
// The cookie is read under the names the auth routes' rule gives the
// handshake (`sessionCookieNamesFor`): a configured `cookieName`; else
// `session` when `COOKIE_DOMAIN` gives the cookie a domain; else, over HTTPS,
// only `__Host-session` (a site under the same parent domain can plant a
// plain `session` cookie, and a secure handshake must not take it in place of
// the host-only one), and over plain HTTP `session`, then `__Host-session`.
//
// `devCredentials` (finding F2.13 of the quickdraw-chat migration) signs a
// socket in by the user id its handshake names (`auth: { userId }`), for a
// game editor or load-test bots in development. It cannot be used in
// production: `socketAuth` throws when it is given and `NODE_ENV` is
// `"production"`, and a handshake is refused it there whatever the
// environment says later.

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
  /**
   * The web app's origins, the same list as `createAuthRoutes`' `allowedOrigins`:
   * the pages that may use the session cookie, on a socket and (since rc.5)
   * on an HTTP call, which is answered `FORBIDDEN` from any other `Origin`.
   */
  readonly allowedOrigins: readonly AllowedOrigin[];
  /**
   * Accept a cookie-authenticated handshake that has no `Origin` header, for
   * native clients that keep cookies. Default `false`. A handshake whose
   * `Origin` is not allowed is refused either way. HTTP calls do not need
   * it: one without `Origin` is accepted (a browser sends `Origin` with every
   * POST, so it is not a page's), unless `Sec-Fetch-Site` names another site.
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
  /**
   * Development sign-in without a session: a socket whose handshake carries
   * `auth: { userId }` and no token is that user, as this function answers:
   * their principal (its `userId` the one named), or `null` to refuse the
   * handshake (an unknown id). For a game editor or load-test bots. Never in
   * production: `socketAuth` throws when it is given while `NODE_ENV` is
   * `"production"`, and refuses such a handshake there anyway. HTTP calls
   * never use it. Pass it only when the app's own flag is on:
   * `devCredentials: env.ENABLE_DEV_CREDENTIALS ? findDevUser : undefined`.
   */
  readonly devCredentials?: DevCredentials<P>;
}

/** `socketAuth`'s `devCredentials`: the principal of the user a development handshake names, or `null`. */
export type DevCredentials<P extends Principal> = (
  userId: string,
) => MaybePromise<P | null | undefined>;

/** What {@link socketAuth} returns: an `authenticate` for `createServer`'s `auth`. */
export type SessionAuthenticate<P extends Principal> = (
  request: AuthenticateRequest,
) => Promise<P | null>;

interface Credential {
  readonly token: string;
  /** True for the ambient session cookie: a socket's, or an HTTP call's (finding F7.1). */
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
    // The HTTP transport found it, and says whether it was the session cookie.
    return { token, checkOrigin: request.transport === "http" && request.credential === "cookie" };
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

/**
 * The same rule for an HTTP call that sends the session cookie. An `Origin`
 * must be allowed, as on a socket. Without one it differs: the transport
 * serves only POST, and a browser sends `Origin` with every POST (the Fetch
 * standard; a socket's long-polling handshake is a GET, which a same-origin
 * page or an `<img>` sends without one), so a call without it is not a
 * page's: curl, or a server rendering a page with the user's forwarded
 * cookie (`createServerCaller`). It is accepted, unless the browser's fetch
 * metadata says another site sent it.
 */
function httpOriginAccepted(headers: IncomingHttpHeaders, origins: OriginAllowlist): boolean {
  const { origin } = headers;
  if (origin !== undefined) {
    return origins.allowed(origin) !== null;
  }
  const site = headers["sec-fetch-site"];
  return site === undefined || site === "same-origin";
}

/** The allowlists `cookieOriginAllowed` compiled, by the list it was given. */
const compiled = new WeakMap<readonly AllowedOrigin[], OriginAllowlist>();

/** A request whose credential came from the session cookie: its headers, and the transport of a call. */
export interface CookieOriginRequest {
  readonly headers: IncomingHttpHeaders;
  /** `"socket"` applies the handshake's rule; anything else (an HTTP call, a REST route) the HTTP one. */
  readonly transport?: string;
}

/**
 * The rule `socketAuth` applies to a request that authenticates with the
 * session cookie, for a custom `authenticate` or route: true when the page
 * that sent it may use the cookie. Its `Origin` must be in `allowedOrigins`
 * (the `createAuthRoutes` list: exact origins or anchored patterns). Without
 * one, an HTTP request (a browser sends `Origin` with every POST, so it is
 * curl or a server forwarding the user's cookie) is accepted unless
 * `Sec-Fetch-Site` names another site, and a socket handshake only when
 * `Sec-Fetch-Site` is `same-origin` or with `allowMissingOrigin`. A bearer
 * token is not ambient: check only a credential that came from the cookie
 * (`request.credential === "cookie"` on an HTTP `authenticate` request).
 *
 * @example
 * authenticate: async (request) => {
 *   if (request.transport === "http" && request.credential === "cookie" &&
 *       !cookieOriginAllowed(request, allowedOrigins)) {
 *     throw new QuickdrawError("FORBIDDEN", "This page may not use the session cookie");
 *   }
 *   // ...
 * }
 */
export function cookieOriginAllowed(
  request: CookieOriginRequest,
  allowedOrigins: readonly AllowedOrigin[],
  options: { readonly allowMissingOrigin?: boolean } = {},
): boolean {
  let origins = compiled.get(allowedOrigins);
  if (origins === undefined) {
    origins = originAllowlist(allowedOrigins, "cookieOriginAllowed", true);
    compiled.set(allowedOrigins, origins);
  }
  return request.transport === "socket"
    ? originAccepted(request.headers, origins, options.allowMissingOrigin === true)
    : httpOriginAccepted(request.headers, origins);
}

/** Whether an HTTP request that sends the session cookie may use it, against a compiled allowlist. */
export function httpCookieOriginAllowed(
  headers: IncomingHttpHeaders,
  origins: OriginAllowlist,
): boolean {
  return httpOriginAccepted(headers, origins);
}

/** Refuses a session cookie used from a page `allowedOrigins` does not list. */
function checkCookieOrigin(
  request: AuthenticateRequest,
  origins: OriginAllowlist,
  allowMissing: boolean,
): void {
  if (request.transport === "http") {
    if (!httpOriginAccepted(request.headers, origins)) {
      // FORBIDDEN, which the HTTP transport answers as it is: the session is fine, the page is not.
      throw new QuickdrawError(
        "FORBIDDEN",
        "This page's origin may not use the session cookie; send it from an allowed origin or use a bearer token",
      );
    }
    return;
  }
  if (!originAccepted(request.headers, origins, allowMissing)) {
    throw refused("This page's origin may not use the session cookie on a socket");
  }
}

function refused(message: string): QuickdrawError {
  return new QuickdrawError("UNAUTHENTICATED", message);
}

function production(): boolean {
  return process.env.NODE_ENV === "production";
}

/** `devCredentials`, checked: a function, and never in production. */
function checkDevCredentials(
  devCredentials: DevCredentials<Principal> | undefined,
): DevCredentials<Principal> | undefined {
  if (devCredentials === undefined) {
    return undefined;
  }
  if (typeof devCredentials !== "function") {
    throw new TypeError("socketAuth: devCredentials must be a function of the user id");
  }
  if (production()) {
    throw new TypeError(
      "socketAuth: devCredentials signs sockets in by a user id alone, so it cannot be used when NODE_ENV is production",
    );
  }
  return devCredentials;
}

/** The user a development socket handshake names (`auth: { userId }` without a token), or `undefined`. */
function devUserOf(request: AuthenticateRequest): string | undefined {
  const { token, userId } = request.auth;
  const tokenless = token === undefined || token === null || token === "";
  return request.transport === "socket" && tokenless && typeof userId === "string" && userId !== ""
    ? userId
    : undefined;
}

/** The principal of a development handshake's user; refused in production and for an unknown user. */
async function devPrincipal(
  devCredentials: DevCredentials<Principal>,
  userId: string,
): Promise<Principal> {
  if (production()) {
    throw refused("Development credentials are refused in production");
  }
  const principal = await devCredentials(userId);
  if (principal === null || principal === undefined) {
    throw refused("No development user has that id");
  }
  if (principal.userId !== userId) {
    throw new TypeError("socketAuth: devCredentials must return the principal of the user named");
  }
  return principal;
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
  const devCredentials = checkDevCredentials(options.devCredentials);
  return async (request) => {
    const devUser = devCredentials === undefined ? undefined : devUserOf(request);
    if (devCredentials !== undefined && devUser !== undefined) {
      return await devPrincipal(devCredentials, devUser);
    }
    const credential = credentialOf(request, naming);
    if (credential === null) {
      return null;
    }
    if (credential.checkOrigin) {
      checkCookieOrigin(request, origins, allowMissing);
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
