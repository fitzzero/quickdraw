// `requireSession(keys)` (finding F2.11 of the quickdraw-chat migration): an
// Express middleware for the app's own REST routes over the auth routes
// kit's sessions. It reads the request's credential the way the HTTP
// transport and `GET /auth/me` do (the session cookie under the shared
// naming rule, else an `Authorization: Bearer` token), verifies the JWT once
// and asks the session store whether the session it names is still live, so
// a signed-out session stops authenticating REST calls at once. 4.1's
// `createRequireAuth` stays for token-keyed sessions; over the kit's
// sessions it verified the JWT twice (its own check, then `liveSession`).

import type { ServerResponse } from "node:http";
import { tokenOf, transportCookieNaming, type HttpRequest } from "../../transports/body";
import { refuse } from "./respond";
import { checkSessionKeys, liveSession, type SessionKeys } from "./tokens";

/** Options of {@link requireSession}. */
export interface RequireSessionOptions {
  /**
   * The session cookie's name, when the app gave the routes one
   * (`createAuthRoutes({ cookie: { name } })`). Default: the name the routes
   * set on the same request, by the shared rule (`__Host-session` over
   * HTTPS, `session` over plain HTTP or with `COOKIE_DOMAIN`).
   */
  readonly cookieName?: string;
}

/** A request `requireSession` let through: its user and its session. */
export type SessionRequest = HttpRequest & {
  /** The signed-in user. */
  userId?: string;
  /** The session the credential named: `server.access.disconnectUser(userId, { sessionId })` ends its sockets. */
  sessionId?: string;
};

/** What {@link requireSession} returns: an Express (4 or 5) middleware. */
export type SessionMiddleware = (
  req: SessionRequest,
  res: ServerResponse,
  next: (error?: unknown) => void,
) => void;

/**
 * A middleware that lets a request through only with a live session of the
 * auth routes kit, setting `req.userId` and `req.sessionId`; anything else
 * answers 401 `{ error: "UNAUTHENTICATED", message }`, the routes' own
 * failure shape. A failing session store is passed to `next(error)`.
 *
 * @example
 * app.post("/api/push/resubscribe", requireSession({ sessions, jwtSecret }), (req, res) => {
 *   res.json({ userId: req.userId });
 * });
 */
export function requireSession(
  keys: SessionKeys,
  options: RequireSessionOptions = {},
): SessionMiddleware {
  checkSessionKeys(keys, "requireSession");
  const naming = transportCookieNaming(options.cookieName);
  return (req, res, next) => {
    const check = async (): Promise<void> => {
      const token = tokenOf(req, naming);
      const session = token === null ? null : await liveSession(keys, token);
      if (session === null) {
        refuse(res, "UNAUTHENTICATED", "Not signed in");
        return;
      }
      req.userId = session.userId;
      req.sessionId = session.id;
      next();
    };
    check().catch((error: unknown) => {
      next(error);
    });
  };
}
