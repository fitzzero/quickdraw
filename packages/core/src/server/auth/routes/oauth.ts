// The OAuth routes of the auth kit (RFC 0003 section 12.6): `GET
// {basePath}/{provider}/start` and `GET {basePath}/{provider}/callback`.
//
// `start` validates the return origin (`?returnTo=`, an origin or a URL on
// it; the first exact allowed origin when absent), keeps it with a new state
// in the state cookie (`state.ts`) and redirects to the provider. The
// callback clears that cookie first, whatever happens next; validates the
// remembered origin again before redirecting anywhere; checks and redeems the
// state; exchanges the code; asks the app's `onLogin` for the user id;
// creates the session and sets its cookie; and redirects to the return
// origin. A failure after the origin is known redirects there with
// `?error=state` (state missing, wrong, expired or already redeemed),
// `denied` (the provider or `onLogin` refused) or `failed` (the exchange,
// `onLogin` or the session store failed).

import { setSessionCookie } from "../sessionCookie";
import { cookiesOf } from "../../transports/body";
import type { AuthProfile, OAuthSignInProvider } from "./providers";
import {
  queryOf,
  redirect,
  refuse,
  type AuthRouteRequest,
  type AuthRouteResponse,
} from "./respond";
import {
  issueFor,
  landingOf,
  redirectUriOf,
  sessionCookieOf,
  stateCookieOf,
  type RouteSettings,
} from "./settings";
import { decodePending, encodePending, newState, OAUTH_STATE_COOKIE, stateMatches } from "./state";

/** A provider the routes drive; `enabled` is checked again on every request (the mock provider's). */
export interface SignInFlow extends OAuthSignInProvider {
  readonly enabled?: () => boolean;
}

type Handler = (req: AuthRouteRequest, res: AuthRouteResponse) => void | Promise<void>;

const CATEGORY = "quickdraw.auth";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `GET {basePath}/{provider}/start`. */
export function startRoute(settings: RouteSettings, flow: SignInFlow): Handler {
  return (req, res) => {
    if (flow.enabled?.() === false) {
      refuse(res, "NOT_FOUND", "Not found");
      return;
    }
    const returnTo = queryOf(req, "returnTo");
    const origin =
      returnTo === null ? (settings.origins.fallback ?? null) : settings.origins.allowed(returnTo);
    if (origin === null) {
      refuse(res, "VALIDATION", "returnTo is not one of the allowed origins");
      return;
    }
    const state = newState();
    const location = flow.authorizeUrl(state, redirectUriOf(settings, flow.id));
    const pending = encodePending({ state, provider: flow.id, origin, issuedAt: Date.now() });
    res.cookie(OAUTH_STATE_COOKIE, pending, stateCookieOf(settings, req, true));
    redirect(res, location);
  };
}

/** The user `onLogin` names for the callback's code, or why there is none. */
type SignInUser = { readonly userId: string } | { readonly error: "denied" | "failed" };

async function userFor(
  settings: RouteSettings,
  flow: SignInFlow,
  code: string,
): Promise<SignInUser> {
  let profile: AuthProfile;
  try {
    profile = await flow.profile(code, redirectUriOf(settings, flow.id));
  } catch (error) {
    settings.logger.warn("A sign-in's code exchange failed", {
      category: CATEGORY,
      provider: flow.id,
      error: messageOf(error),
    });
    return { error: "failed" };
  }
  try {
    const userId: unknown = await settings.onLogin(profile, flow.id);
    if (typeof userId === "string" && userId !== "") {
      return { userId };
    }
    settings.logger.info("onLogin refused a sign-in", { category: CATEGORY, provider: flow.id });
    return { error: "denied" };
  } catch (error) {
    settings.logger.error("onLogin failed", {
      category: CATEGORY,
      provider: flow.id,
      error: messageOf(error),
    });
    return { error: "failed" };
  }
}

/** Signs the callback's user in and lands on `origin`, or lands there with the error. */
async function complete(
  settings: RouteSettings,
  flow: SignInFlow,
  req: AuthRouteRequest,
  res: AuthRouteResponse,
  origin: string,
): Promise<void> {
  const code = queryOf(req, "code");
  if (queryOf(req, "error") !== null || code === null || code === "") {
    redirect(res, landingOf(settings, origin, "denied"));
    return;
  }
  const user = await userFor(settings, flow, code);
  if ("error" in user) {
    redirect(res, landingOf(settings, origin, user.error));
    return;
  }
  const { userId } = user;
  let token: string;
  try {
    ({ token } = await issueFor(settings, userId, flow.id, req));
  } catch (error) {
    settings.logger.error("Creating a session failed", {
      category: CATEGORY,
      error: messageOf(error),
    });
    redirect(res, landingOf(settings, origin, "failed"));
    return;
  }
  setSessionCookie(res, token, sessionCookieOf(settings, req));
  settings.logger.info("Signed in", { category: CATEGORY, provider: flow.id, userId });
  redirect(res, landingOf(settings, origin));
}

/** `GET {basePath}/{provider}/callback`. */
export function callbackRoute(settings: RouteSettings, flow: SignInFlow): Handler {
  return async (req, res) => {
    if (flow.enabled?.() === false) {
      refuse(res, "NOT_FOUND", "Not found");
      return;
    }
    const pending = decodePending(cookiesOf(req)[OAUTH_STATE_COOKIE]);
    // Single use: the state cookie goes whatever happens next.
    res.clearCookie(OAUTH_STATE_COOKIE, stateCookieOf(settings, req));
    if (pending === null) {
      // Started in another browser, or more than ten minutes ago: no origin was remembered.
      const { fallback } = settings.origins;
      if (fallback === undefined) {
        refuse(res, "FORBIDDEN", "This sign-in has no state in this browser; start it again");
      } else {
        redirect(res, landingOf(settings, fallback, "state"));
      }
      return;
    }
    // Validated when it was stored, and again before anything redirects to it.
    const origin = settings.origins.allowed(pending.origin);
    if (origin === null) {
      refuse(res, "VALIDATION", "This sign-in's return origin is not allowed");
      return;
    }
    const now = Date.now();
    const valid = stateMatches(pending, flow.id, queryOf(req, "state"), now);
    if (!valid || !settings.redeemed.redeem(pending.state, now)) {
      settings.logger.debug("Refused a sign-in callback's state", {
        category: CATEGORY,
        provider: flow.id,
      });
      redirect(res, landingOf(settings, origin, "state"));
      return;
    }
    await complete(settings, flow, req, res, origin);
  };
}
