// The guest provider of the auth routes kit (RFC 0003 section 12.6): `POST
// {basePath}/guest` creates a user through the app's `createUser` and signs
// it in with an ordinary session, so everything downstream (socket auth,
// access policies) sees a real user id rather than an anonymous socket. Like
// every POST route of the kit it needs a JSON body type, which a cross-site
// form cannot send, so a page elsewhere cannot sign a visitor in as a guest.

import { INTERNAL_MESSAGE, QuickdrawError } from "../../../protocol/errors";
import { readJsonInput } from "../../transports/body";
import type { MaybePromise } from "../../types";
import { refuse, sendJson, type AuthRouteRequest, type AuthRouteResponse } from "./respond";
import { issueFor, setSession, type RouteSettings } from "./settings";

/** The largest guest request body read, in bytes. */
export const GUEST_MAX_BODY_BYTES = 16_384;

/** The guest `createUser` made: its id, and the name it ended up with (`"Ada#4821"` for a taken "Ada"). */
export interface GuestUser {
  readonly userId: string;
  readonly name?: string;
}

/** The guest provider's options. */
export interface GuestOptions {
  /**
   * Creates the guest user and returns its id, or `{ userId, name }` when
   * the name it gave differs from the one asked for (a numbered one after a
   * collision): the route answers that name. `input` is the request's JSON
   * body (`undefined` without one), unchecked: validate it here. Throw a
   * `QuickdrawError` to refuse with its code, such as `VALIDATION` for a bad
   * name or `CONFLICT` for a taken one.
   */
  readonly createUser: (
    input: unknown,
    request: AuthRouteRequest,
  ) => MaybePromise<string | GuestUser>;
  /**
   * Also answer the session's token, for clients that keep no cookies (a
   * game engine, a page in a third-party iframe) and send it as
   * `auth.token` or a bearer token. Unlike the HttpOnly cookie, the token is
   * then readable by the page's scripts. Default `false`.
   */
  readonly token?: boolean;
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
  if (options.token !== undefined && typeof options.token !== "boolean") {
    throw new TypeError("guest(): token must be true or false");
  }
  return Object.freeze({ kind: "guest", id: "guest", options });
}

/** What `createUser` returned, read: the user's id and name; a `TypeError` for anything else. */
function guestUserOf(made: unknown): GuestUser {
  if (typeof made === "string" && made !== "") {
    return { userId: made };
  }
  const { userId, name } = (typeof made === "object" && made !== null ? made : {}) as {
    readonly userId?: unknown;
    readonly name?: unknown;
  };
  if (
    typeof userId !== "string" ||
    userId === "" ||
    (name !== undefined && typeof name !== "string")
  ) {
    throw new TypeError("guest(): createUser must return the new user's id, or { userId, name? }");
  }
  return name === undefined ? { userId } : { userId, name };
}

/** The user `createUser` made, or the failure already answered. */
async function createGuest(
  settings: RouteSettings,
  provider: GuestProvider,
  req: AuthRouteRequest,
  res: AuthRouteResponse,
): Promise<GuestUser | null> {
  try {
    const input = await readJsonInput(req, GUEST_MAX_BODY_BYTES);
    return guestUserOf(await provider.options.createUser(input, req));
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

/**
 * `POST {basePath}/guest`: a new guest user, signed in; answers
 * `{ userId, name? }`, plus `token` when the provider says so.
 */
export function guestRoute(
  settings: RouteSettings,
  provider: GuestProvider,
): (req: AuthRouteRequest, res: AuthRouteResponse) => Promise<void> {
  return async (req, res) => {
    const user = await createGuest(settings, provider, req, res);
    if (user === null) {
      return;
    }
    const { userId } = user;
    const { token } = await issueFor(settings, userId, provider.id, req);
    setSession(res, settings, req, token);
    settings.logger.info("Signed in a new guest", { category: "quickdraw.auth", userId });
    sendJson(res, 200, provider.options.token === true ? { ...user, token } : user);
  };
}
