// Who a socket connection or an HTTP request acts for (RFC 0003 sections 3
// and 10). Ported from 4.1's socket middleware
// (`legacy-src/server/createServer.ts:85-113`): `authenticate` returns a user
// id or a principal, and `loadServiceAccess(userId)` supplies the service
// grants when the principal carries none. 4.1 asked only about sockets; here
// the same hooks also authenticate HTTP calls, so `authenticate` receives the
// transport, the credentials and the headers instead of the socket alone.

import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Socket } from "socket.io";
import type { AccessLevel } from "../../contract/access";
import type { MaybePromise, Principal } from "../types";

/** A principal's service-wide grants by service name: `{ taskService: "Admin" }`. */
export type ServiceGrants = Readonly<Record<string, AccessLevel>>;

interface AuthenticateRequestBase {
  /**
   * The credentials. For a socket, its handshake `auth` as the client sent
   * it (`{ token, qd }` from a v5 client). For an HTTP request, `{ token }`
   * with its session cookie or bearer token, or `{}` when it has neither.
   */
  readonly auth: Readonly<Record<string, unknown>>;
  /** The request's headers, or the socket handshake's. */
  readonly headers: IncomingHttpHeaders;
}

/** `authenticate`'s question about a connecting socket. */
export interface SocketAuthenticateRequest extends AuthenticateRequestBase {
  readonly transport: "socket";
  readonly socket: Socket;
}

/** `authenticate`'s question about an HTTP call. */
export interface HttpAuthenticateRequest extends AuthenticateRequestBase {
  readonly transport: "http";
  readonly req: IncomingMessage;
}

/** What `authenticate` is asked about: a socket connecting, or an HTTP call. */
export type AuthenticateRequest = SocketAuthenticateRequest | HttpAuthenticateRequest;

/**
 * What `authenticate` returns: the principal; its user id, when a bare
 * `{ userId }` is a valid principal of the app's type; or `null` or
 * `undefined` for an anonymous caller.
 */
export type AuthenticateResult<P extends Principal> =
  | P
  | ({ readonly userId: string } extends P ? string : never)
  | null
  | undefined;

/** How a server authenticates sockets and HTTP calls. Without it every caller is anonymous. */
export interface ServerAuth<P extends Principal = Principal> {
  /**
   * Says who is calling. Throwing refuses the socket connection ("Authentication
   * failed") or answers the HTTP call with `UNAUTHENTICATED`; returning
   * nothing lets the caller in anonymously, so only `"public"` methods pass.
   */
  readonly authenticate?: (request: AuthenticateRequest) => MaybePromise<AuthenticateResult<P>>;
  /**
   * Loads a user's service grants (for example `User.serviceAccess`) when
   * the principal `authenticate` returned has none. `access.refresh(userId)`
   * calls it again.
   */
  readonly loadServiceAccess?: (userId: string) => MaybePromise<ServiceGrants | null | undefined>;
}

/** Resolves a request to its principal, or `null`; rejects when authentication fails. */
export type ResolvePrincipal = (request: AuthenticateRequest) => Promise<Principal | null>;

/** True when `value` has a principal's shape: an object with a non-empty string `userId`. */
export function isPrincipal(value: unknown): value is Principal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly userId?: unknown }).userId === "string" &&
    (value as { readonly userId: string }).userId.length > 0
  );
}

function toPrincipal(result: unknown): Principal | null {
  if (result === null || result === undefined || result === "") {
    return null;
  }
  if (typeof result === "string") {
    return { userId: result };
  }
  if (isPrincipal(result)) {
    return result;
  }
  throw new TypeError(
    "authenticate must return a principal with a non-empty string userId, a user id, or null",
  );
}

/** Builds the function both transports authenticate with. */
export function createPrincipalResolver<P extends Principal>(
  auth: ServerAuth<P> | undefined,
): ResolvePrincipal {
  const authenticate = auth?.authenticate;
  const loadServiceAccess = auth?.loadServiceAccess;
  return async (request) => {
    if (authenticate === undefined) {
      return null;
    }
    const principal = toPrincipal(await authenticate(request));
    const carried = principal?.serviceAccess;
    if (principal === null || (carried !== undefined && carried !== null)) {
      return principal;
    }
    if (loadServiceAccess === undefined) {
      return principal;
    }
    const serviceAccess = (await loadServiceAccess(principal.userId)) ?? {};
    return { ...principal, serviceAccess };
  };
}
