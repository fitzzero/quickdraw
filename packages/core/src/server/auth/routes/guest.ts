// The guest provider of the auth routes kit (RFC 0003 section 12.6): `POST
// {basePath}/guest` creates a user through the app's `createUser` and signs
// it in with an ordinary session, so everything downstream (socket auth,
// access policies) sees a real user id rather than an anonymous socket. Like
// every POST route of the kit it needs a JSON body type, which a cross-site
// form cannot send, so a page elsewhere cannot sign a visitor in as a guest.

import { INTERNAL_MESSAGE, QuickdrawError } from "../../../protocol/errors";
import { readJsonInput } from "../../transports/body";
import type { MaybePromise } from "../../types";
import { setSessionCookie } from "../sessionCookie";
import { refuse, sendJson, type AuthRouteRequest, type AuthRouteResponse } from "./respond";
import { issueFor, sessionCookieOf, type RouteSettings } from "./settings";

/** The largest guest request body read, in bytes. */
export const GUEST_MAX_BODY_BYTES = 16_384;

/** The guest provider's options. */
export interface GuestOptions {
  /**
   * Creates the guest user and returns its id. `input` is the request's
   * JSON body (`undefined` without one), unchecked: validate it here. Throw
   * a `QuickdrawError` to refuse with its code, such as `VALIDATION` for a
   * bad name or `CONFLICT` for a taken one.
   */
  readonly createUser: (input: unknown, request: AuthRouteRequest) => MaybePromise<string>;
}

/** The guest provider: `POST {basePath}/guest`. */
export interface GuestProvider {
  readonly kind: "guest";
  readonly id: "guest";
  readonly options: GuestOptions;
}

/** Signing in as a new guest user: `POST {basePath}/guest` with a JSON body. */
export function guest(options: GuestOptions): GuestProvider {
  if (typeof options.createUser !== "function") {
    throw new TypeError("guest(): createUser is required");
  }
  return Object.freeze({ kind: "guest", id: "guest", options });
}

/** The user `createUser` made, or the failure already answered. */
async function createGuest(
  settings: RouteSettings,
  provider: GuestProvider,
  req: AuthRouteRequest,
  res: AuthRouteResponse,
): Promise<string | null> {
  try {
    const input = await readJsonInput(req, GUEST_MAX_BODY_BYTES);
    const userId: unknown = await provider.options.createUser(input, req);
    if (typeof userId === "string" && userId !== "") {
      return userId;
    }
    throw new TypeError("guest(): createUser must return the new user's id");
  } catch (error) {
    if (error instanceof QuickdrawError && error.code !== "INTERNAL") {
      refuse(res, error.code, error.message);
      return null;
    }
    settings.logger.error("Creating a guest user failed", {
      category: "quickdraw.auth",
      error: error instanceof Error ? error.message : String(error),
    });
    refuse(res, "INTERNAL", INTERNAL_MESSAGE);
    return null;
  }
}

/** `POST {basePath}/guest`: a new guest user, signed in; answers `{ userId }`. */
export function guestRoute(
  settings: RouteSettings,
  provider: GuestProvider,
): (req: AuthRouteRequest, res: AuthRouteResponse) => Promise<void> {
  return async (req, res) => {
    const userId = await createGuest(settings, provider, req, res);
    if (userId === null) {
      return;
    }
    const { token } = await issueFor(settings, userId, provider.id, req);
    setSessionCookie(res, token, sessionCookieOf(settings, req));
    settings.logger.info("Signed in a new guest", { category: "quickdraw.auth", userId });
    sendJson(res, 200, { userId });
  };
}
