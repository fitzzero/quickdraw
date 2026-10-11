// `bearerAuth` (RFC 0003 section 12.6): the bearer-token counterpart of
// `socketAuth`, for the hooks that are handed a token and nothing else: the
// MCP bridge's `principal` hook, and an app's own `authenticate` that takes
// only `auth.token`. A token stands for a session only while the session
// store still holds it (`liveSession`: the JWT's signature and expiry, its
// `sid`, the store's entry for that user, and its `expiresAt`), checked on
// every call, so signing out, logging out everywhere or revoking a session
// stops its token at once. `verifyJWT` alone checks the signature and expiry
// only, so a signed-out session kept working for up to 7 days (the 5.1
// audit's AUTH-1).
//
// It never reads cookies: a bearer token is not ambient, so it needs no
// Origin check. It records no socket session either: for `createServer`'s
// `authenticate` use `socketAuth`, which reads the session cookie with the
// Origin rule and lets `server.access.disconnectUser` end a session's
// sockets.

import { QuickdrawError } from "../../../protocol/errors";
import type { Principal } from "../../types";
import { principalOfSession, type PrincipalLoader } from "./socketAuth";
import { checkSessionKeys, liveSession, type SessionKeys } from "./tokens";

/** Options of {@link bearerAuth}: the auth routes' session store and secret, and how a principal is built. */
export interface BearerAuthOptions<P extends Principal = Principal> extends SessionKeys {
  /**
   * Builds the principal of a session's user, for example `kind: "agent"`
   * for an MCP caller; its `userId` must be the session's. Default
   * `{ userId, kind: "user" }`.
   */
  readonly loadPrincipal?: PrincipalLoader<P>;
}

/**
 * What {@link bearerAuth} returns: the principal a bearer token signs in,
 * `null` for no token, and a rejection (`UNAUTHENTICATED`) for a token that
 * is not a live session's.
 */
export type BearerAuthenticate<P extends Principal> = (token: unknown) => Promise<P | null>;

/**
 * Checks bearer tokens against the auth routes' sessions, on every call: no
 * token (anything but a non-empty string) is anonymous (`null`); a token
 * whose session was signed out, revoked or has expired, or a JWT without a
 * session, is refused with `UNAUTHENTICATED`; a live session's token is its
 * user's principal, built as `socketAuth` builds it. It records no socket
 * session: for `createServer`'s `authenticate` use `socketAuth`.
 *
 * @example
 * const verifySession = bearerAuth({ sessions, jwtSecret, loadPrincipal: (userId) => ({ userId, kind: "agent" }) });
 * // the MCP bridge's principal hook
 * createMcpRegistry({ ..., principal: (request) => verifySession(request.transport === "http" ? request.token : process.env.AGENT_TOKEN) });
 * // an authenticate that takes bearer tokens only
 * createHttpRouter({ dispatcher, auth: { authenticate: ({ auth }) => verifySession(auth.token) } });
 */
export function bearerAuth<P extends Principal>(
  options: BearerAuthOptions<P> & { readonly loadPrincipal: PrincipalLoader<P> },
): BearerAuthenticate<P>;
export function bearerAuth(options: BearerAuthOptions): BearerAuthenticate<Principal>;
export function bearerAuth(options: BearerAuthOptions): BearerAuthenticate<Principal> {
  const keys = checkSessionKeys(options, "bearerAuth");
  const { loadPrincipal } = options;
  if (loadPrincipal !== undefined && typeof loadPrincipal !== "function") {
    throw new TypeError("bearerAuth: loadPrincipal must be a function");
  }
  return async (token) => {
    if (typeof token !== "string" || token === "") {
      return null;
    }
    const session = await liveSession(keys, token);
    if (session === null) {
      throw new QuickdrawError("UNAUTHENTICATED", "The session is not valid");
    }
    return await principalOfSession(session, loadPrincipal, "bearerAuth");
  };
}
