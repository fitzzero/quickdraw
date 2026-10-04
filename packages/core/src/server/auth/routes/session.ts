// The session routes of the auth kit (RFC 0003 section 12.6). Each reads the
// session the request carries the way the HTTP transport does: the session
// cookie, under the names the shared rule gives the request
// (`sessionCookieNamesFor`), else an `Authorization: Bearer` token.
//
// - `GET {basePath}/me`: `{ userId }` for a live session, else 401. The
//   answer is the same whether the request had no credential, a forged or
//   expired one, or one whose session was revoked.
// - `POST {basePath}/logout`: revokes the request's session, if it names
//   one, and clears the cookie; 204 either way.
// - `POST {basePath}/logout-all`: needs a live session; revokes every session
//   of its user and clears the cookie (204), else 401.
//
// Each revocation is told to the app's `onRevoke(userId, sessionId | null)`,
// which can end the sockets still open with the session
// (`server.access.disconnectUser`).

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
import { clearSession, sessionCookieNaming, type RouteSettings } from "./settings";
import { liveSession } from "./tokens";

type Handler = (req: AuthRouteRequest, res: AuthRouteResponse) => Promise<void>;

const NOT_SIGNED_IN = "Not signed in";

/** The live session the request carries, or `null`. */
function sessionOf(settings: RouteSettings, req: AuthRouteRequest): Promise<AuthSession | null> {
  const token = tokenOf(req, sessionCookieNaming(settings));
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

/** Tells the app's `onRevoke` a session (or, `null`, every one) of `userId` ended; a failure is logged. */
async function revoked(
  settings: RouteSettings,
  userId: string,
  sessionId: string | null,
): Promise<void> {
  try {
    await settings.onRevoke?.(userId, sessionId);
  } catch (error) {
    settings.logger.error("onRevoke failed", {
      category: "quickdraw.auth",
      userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** `POST {basePath}/logout`. */
export function logoutRoute(settings: RouteSettings): Handler {
  return async (req, res) => {
    const token = tokenOf(req, sessionCookieNaming(settings));
    const payload = token === null ? null : await verifyJWT(token, settings.keys.jwtSecret);
    if (payload?.sid !== undefined) {
      await settings.keys.sessions.revoke(payload.sid);
      settings.logger.info("Signed out", { category: "quickdraw.auth", userId: payload.userId });
      await revoked(settings, payload.userId, payload.sid);
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
    await revoked(settings, session.userId, null);
    noContent(res);
  };
}
