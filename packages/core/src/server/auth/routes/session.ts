// The session routes of the auth kit (RFC 0003 section 12.6). Each reads the
// session the request carries the way the HTTP transport does: the session
// cookie, under the names the shared rule gives the request
// (`sessionCookieNamesFor`), else an `Authorization: Bearer` token. A cookie
// sent from a page `allowedOrigins` does not list is answered 403
// `FORBIDDEN`, as `socketAuth` answers it on the HTTP transport (rule F7.1;
// the 5.1 audit's AUTH-5: a cross-site page with CORS help could read the
// user id or sign the user out everywhere); a bearer token is not ambient,
// so any page may send it.
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

import { readVerifiedJWT } from "../jwt";
import { httpCredentialOf } from "../../transports/body";
import {
  noContent,
  refuse,
  sendJson,
  type AuthRouteRequest,
  type AuthRouteResponse,
} from "./respond";
import type { AuthSession } from "./sessions";
import { clearSession, sessionCookieNaming, type RouteSettings } from "./settings";
import { COOKIE_REFUSED, httpCookieOriginAllowed } from "./socketAuth";
import { liveSession } from "./tokens";
import { errorText } from "../../../contract/logger";

type Handler = (req: AuthRouteRequest, res: AuthRouteResponse) => Promise<void>;

const NOT_SIGNED_IN = "Not signed in";

/**
 * The token the request carries (the session cookie, else a bearer token),
 * or `null`; `undefined` once the route has answered 403: the cookie came
 * from a page `allowedOrigins` does not list.
 */
function tokenFor(
  settings: RouteSettings,
  req: AuthRouteRequest,
  res: AuthRouteResponse,
): string | null | undefined {
  const credential = httpCredentialOf(req, sessionCookieNaming(settings));
  if (credential?.from === "cookie" && !httpCookieOriginAllowed(req.headers, settings.origins)) {
    refuse(res, "FORBIDDEN", COOKIE_REFUSED);
    return undefined;
  }
  return credential?.token ?? null;
}

/** The live session `token` names, or `null`. */
function sessionOf(settings: RouteSettings, token: string | null): Promise<AuthSession | null> {
  return token === null ? Promise.resolve(null) : liveSession(settings.keys, token);
}

/** `GET {basePath}/me`. */
export function meRoute(settings: RouteSettings): Handler {
  return async (req, res) => {
    const token = tokenFor(settings, req, res);
    if (token === undefined) {
      return;
    }
    const session = await sessionOf(settings, token);
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
      error: errorText(error),
    });
  }
}

/** `POST {basePath}/logout`. */
export function logoutRoute(settings: RouteSettings): Handler {
  return async (req, res) => {
    const token = tokenFor(settings, req, res);
    if (token === undefined) {
      return;
    }
    const payload = token === null ? null : await readVerifiedJWT(token, settings.keys.jwtSecret);
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
    const token = tokenFor(settings, req, res);
    if (token === undefined) {
      return;
    }
    const session = await sessionOf(settings, token);
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
