// `requireSession(keys)` (finding F2.11 of the quickdraw-chat migration): an
// Express middleware for the app's own REST routes over the auth routes
// kit's sessions. It reads the request's credential the way the HTTP
// transport and `GET /auth/me` do (the session cookie under the shared
// naming rule, else an `Authorization: Bearer` token), verifies the JWT once
// and asks the session store whether the session it names is still live, so
// a signed-out session stops authenticating REST calls at once. 4.1's
// `createRequireAuth` stays for token-keyed sessions; over the kit's
// sessions it verified the JWT twice (its own check, then `liveSession`).
//
// It also builds the request's principal as `socketAuth` builds a socket's
// (`loadPrincipal`, default `{ userId, kind: "user" }`), and `sessionOf(req)`
// hands the route its user, session and principal, typed, without a cast of
// `req`, whose Express type has no `userId` (finding F5.4). The route then
// calls the services in process as that principal: `qd.caller(principal)`
// loads its service-wide grants as a socket's handshake does (F5.1).

import type { ServerResponse } from "node:http";
import { tokenOf, transportCookieNaming, type HttpRequest } from "../../transports/body";
import type { Principal } from "../../types";
import { refuse } from "./respond";
import type { PrincipalLoader } from "./socketAuth";
import { checkSessionKeys, liveSession, type SessionKeys } from "./tokens";

/** Options of {@link requireSession}. */
export interface RequireSessionOptions<P extends Principal = Principal> {
  /**
   * The session cookie's name, when the app gave the routes one
   * (`createAuthRoutes({ cookie: { name } })`). Default: the name the routes
   * set on the same request, by the shared rule (`__Host-session` over
   * HTTPS, `session` over plain HTTP or with `COOKIE_DOMAIN`).
   */
  readonly cookieName?: string;
  /**
   * Builds the principal of the session's user, as `socketAuth`'s option of
   * the same name builds a socket's: give both the same function, so a REST
   * route calls the services as the user's sockets do. Its `userId` must be
   * the session's; `null` answers 401. Default `{ userId, kind: "user" }`.
   */
  readonly loadPrincipal?: PrincipalLoader<P>;
}

/** What {@link sessionOf} answers for a request `requireSession` let through. */
export interface RequestSession<P extends Principal = Principal> {
  /** The signed-in user. */
  readonly userId: string;
  /** The session the credential named: `server.access.disconnectUser(userId, { sessionId })` ends its sockets. */
  readonly sessionId: string;
  /**
   * The user's principal, to call the services as: `qd.caller(principal)`,
   * which loads its service-wide grants as a socket's handshake does.
   */
  readonly principal: P;
}

/** A request `requireSession` let through: its user, its session and its principal. */
export type SessionRequest<P extends Principal = Principal> = HttpRequest & {
  /** The signed-in user. */
  userId?: string;
  /** The session the credential named. */
  sessionId?: string;
  /** The user's principal. */
  principal?: P;
};

/** What {@link requireSession} returns: an Express (4 or 5) middleware. */
export type SessionMiddleware<P extends Principal = Principal> = (
  req: SessionRequest<P>,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void;

/** The sessions `requireSession` let requests through with, by request. */
const SESSIONS = new WeakMap<object, RequestSession>();

/**
 * A middleware that lets a request through only with a live session of the
 * auth routes kit, keeping its user, session and principal for
 * {@link sessionOf} (and setting `req.userId`, `req.sessionId` and
 * `req.principal`); anything else answers 401
 * `{ error: "UNAUTHENTICATED", message }`, the routes' own failure shape. A
 * failing session store or `loadPrincipal` is passed to `next(error)`.
 *
 * @example
 * app.post("/api/push/resubscribe", express.json(), requireSession(keys), (req, res) => {
 *   const { principal } = sessionOf(req);
 *   // await qd.caller(principal).pushService.subscribePush(req.body), then answer
 * });
 */
export function requireSession<P extends Principal>(
  keys: SessionKeys,
  options: RequireSessionOptions<P> & { readonly loadPrincipal: PrincipalLoader<P> },
): SessionMiddleware<P>;
export function requireSession(
  keys: SessionKeys,
  options?: RequireSessionOptions,
): SessionMiddleware;
export function requireSession(
  keys: SessionKeys,
  options: RequireSessionOptions = {},
): SessionMiddleware {
  checkSessionKeys(keys, "requireSession");
  const naming = transportCookieNaming(options.cookieName);
  const { loadPrincipal } = options;
  if (loadPrincipal !== undefined && typeof loadPrincipal !== "function") {
    throw new TypeError("requireSession: loadPrincipal must be a function");
  }
  return (req, res, next) => {
    const check = async (): Promise<void> => {
      const token = tokenOf(req, naming);
      const session = token === null ? null : await liveSession(keys, token);
      if (session === null) {
        refuse(res, "UNAUTHENTICATED", "Not signed in");
        return;
      }
      const principal: Principal | null | undefined =
        loadPrincipal === undefined
          ? { userId: session.userId, kind: "user" }
          : await loadPrincipal(session.userId, session);
      if (principal === null || principal === undefined) {
        refuse(res, "UNAUTHENTICATED", "The session's user has no principal");
        return;
      }
      if (principal.userId !== session.userId) {
        throw new TypeError(
          "requireSession: loadPrincipal must return the principal of the session's user",
        );
      }
      SESSIONS.set(
        req,
        Object.freeze({ userId: session.userId, sessionId: session.id, principal }),
      );
      req.userId = session.userId;
      req.sessionId = session.id;
      req.principal = principal;
      next();
    };
    check().catch((error: unknown) => {
      next(error);
    });
  };
}

/**
 * The user, session and principal `requireSession` let `req` through with,
 * typed: `P` is the type its `loadPrincipal` returns
 * (`sessionOf<AppPrincipal>(req)`). Throws a `TypeError` for a request no
 * `requireSession` let through, a route mounted without it.
 *
 * @example
 * const { principal } = sessionOf(req);
 * res.json(await qd.caller(principal).taskService.get({ id: req.params.id }));
 */
export function sessionOf<P extends Principal = Principal>(req: object): RequestSession<P> {
  const session = SESSIONS.get(req);
  if (session === undefined) {
    throw new TypeError(
      "sessionOf: no requireSession let this request through; mount requireSession(keys) before the route",
    );
  }
  return session as RequestSession<P>;
}
