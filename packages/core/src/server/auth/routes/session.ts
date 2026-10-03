// The session routes of the auth kit (RFC 0003 section 12.6). Each reads the
// session the request carries the way the HTTP transport does: the session
// cookie, else an `Authorization: Bearer` token.
//
// - `GET {basePath}/me`: `{ userId }` for a live session, else 401. The
//   answer is the same whether the request had no credential, a forged or
//   expired one, or one whose session was revoked.
// - `POST {basePath}/logout`: revokes the request's session, if it names
//   one, and clears the cookie; 204 either way.
// - `POST {basePath}/logout-all`: needs a live session; revokes every session
//   of its user and clears the cookie (204), else 401.

import { verifyJWT } from "../jwt";
import { tokenOf } from "../../transports/body";
import {
  noContent,
  refuse,
  sendJson,
  type AuthRouteRequest,
  type AuthRouteResponse,
} from "./respond";
import type { AuthSession } from "./sessions";
import { clearSession, sessionCookieName, type RouteSettings } from "./settings";
import { liveSession } from "./tokens";

type Handler = (req: AuthRouteRequest, res: AuthRouteResponse) => Promise<void>;

const NOT_SIGNED_IN = "Not signed in";

/** The live session the request carries, or `null`. */
function sessionOf(settings: RouteSettings, req: AuthRouteRequest): Promise<AuthSession | null> {
  const token = tokenOf(req, sessionCookieName(settings, req));
  return token === null ? Promise.resolve(null) : liveSession(settings.keys, token);
}

/** `GET {basePath}/me`. */
export function meRoute(settings: RouteSettings): Handler {
  return async (req, res) => {
    const session = await sessionOf(settings, req);
    if (session === null) {
      refuse(res, "UNAUTHENTICATED", NOT_SIGNED_IN);
      return;
    }
    sendJson(res, 200, { userId: session.userId });
  };
}

/** `POST {basePath}/logout`. */
export function logoutRoute(settings: RouteSettings): Handler {
  return async (req, res) => {
    const token = tokenOf(req, sessionCookieName(settings, req));
    const payload = token === null ? null : await verifyJWT(token, settings.keys.jwtSecret);
    if (payload?.sid !== undefined) {
      await settings.keys.sessions.revoke(payload.sid);
      settings.logger.info("Signed out", { category: "quickdraw.auth", userId: payload.userId });
    }
    clearSession(res, settings, req);
    noContent(res);
  };
}

/** `POST {basePath}/logout-all`. */
export function logoutAllRoute(settings: RouteSettings): Handler {
  return async (req, res) => {
    const session = await sessionOf(settings, req);
    clearSession(res, settings, req);
    if (session === null) {
      refuse(res, "UNAUTHENTICATED", NOT_SIGNED_IN);
      return;
    }
    await settings.keys.sessions.revokeAll(session.userId);
    settings.logger.info("Signed out everywhere", {
      category: "quickdraw.auth",
      userId: session.userId,
    });
    noContent(res);
  };
}
