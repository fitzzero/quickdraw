// Who a socket connection or an HTTP request acts for (RFC 0003 sections 3
// and 10). Ported from 4.1's socket middleware
// (4.1 `src/server/createServer.ts:85-113`): `authenticate` returns a user
// id or a principal, and `loadServiceAccess(userId)` supplies the service
// grants when the principal carries none. 4.1 asked only about sockets; here
// the same hooks also authenticate HTTP calls, so `authenticate` receives the
// transport, the credentials and the headers instead of the socket alone.

import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { Socket } from "socket.io";
import type { AccessLevel } from "../../contract/access";
import type { Logger } from "../../contract/logger";
import { QuickdrawError } from "../../protocol/errors";
import { modelKey } from "../storage";
import type { MaybePromise, Principal } from "../types";
import type { FlushSink } from "../uow/flushSink";
import { ANY_FIELD } from "../uow/types";
import type { HttpCredentialSource } from "./body";

export type { HttpCredentialSource };

/** A principal's service-wide grants by service name: `{ taskService: "Admin" }`. */
export type ServiceGrants = Readonly<Record<string, AccessLevel>>;

interface AuthenticateRequestBase {
  /**
   * The credentials. For a socket, its handshake `auth` as the client sent
   * it (`{ token, qd }` from a v5 client). For an HTTP request, `{ token }`
   * with its bearer token, or `{}` without one; for `socketAuth`'s
   * `authenticate` alone, the session cookie when the request carries one,
   * else the bearer token. Every other `authenticate` finds the cookie only
   * in `sessionCookie`.
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
  /**
   * The credential the transport chose (finding F7.1): `"cookie"` when the
   * request carries the session cookie, which a browser sends with a
   * request any page makes, so an `authenticate` that accepts it checks the
   * request's `Origin` as `socketAuth` does; else `"bearer"` for an
   * `Authorization: Bearer` header, which a page sends only on purpose.
   * Absent with neither.
   */
  readonly credential?: HttpCredentialSource;
  /**
   * The session cookie's value, when the request carries one. It is
   * ambient (a browser sends it with a request any page makes), so an
   * `authenticate` that accepts it first checks
   * `cookieOriginAllowed(request, allowedOrigins)`, then the session store,
   * on every call (`liveSession`). It is in `auth.token` only for
   * `socketAuth`'s `authenticate`.
   */
  readonly sessionCookie?: string;
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
   * failed", with `{ code: "UNAUTHENTICATED" }` as the `connect_error` data) or
   * answers the HTTP call with `UNAUTHENTICATED`; returning nothing lets the
   * caller in anonymously, so only `"public"` methods pass. Throw a
   * `QuickdrawError("UNAUTHENTICATED", ...)` for a refusal that is the
   * caller's doing (it logs at debug; anything else thrown logs at error).
   * On an HTTP call a thrown `QuickdrawError("FORBIDDEN", ...)` is answered
   * as it is, with 403 (logged at debug): a credential the request may not
   * use from where it came, as `socketAuth` answers a session cookie sent
   * from a page outside `allowedOrigins`.
   */
  readonly authenticate?: (request: AuthenticateRequest) => MaybePromise<AuthenticateResult<P>>;
  /**
   * Loads a user's service grants (for example `User.serviceAccess`) when
   * the principal `authenticate` returned has none. `access.refresh(userId)`
   * calls it again.
   */
  readonly loadServiceAccess?: (userId: string) => MaybePromise<ServiceGrants | null | undefined>;
  /**
   * Where `loadServiceAccess` reads grants from, as `{ model: "user", column:
   * "serviceAccess" }`, the row's id being the user's. A tracked write that
   * sets that column, or creates, deletes or touches such a row, refreshes
   * that user's grants once it is flushed (`server.access.refresh`), so a
   * changed grant reaches their sockets without a reconnect (RFC 0003
   * section 4.4). The admin kit on that model treats the column as the
   * grants field, whatever its name: hidden unless `grants: true`, and then
   * for service-wide Admins only. Needs `loadServiceAccess`.
   */
  readonly serviceAccessSource?: ServiceAccessSource;
}

/** Where a server's grants are stored: one row per user, the row's id being the user's. */
export interface ServiceAccessSource {
  /** The model, as the client names it: `"user"`. */
  readonly model: string;
  /** The column holding the grants: `"serviceAccess"`. */
  readonly column: string;
}

/** Resolves a request to its principal, or `null`; rejects when authentication fails. */
export type ResolvePrincipal = (request: AuthenticateRequest) => Promise<Principal | null>;

/** The session a socket authenticated with: its id, and when it expires (epoch milliseconds). */
interface SocketSession {
  readonly id: string;
  readonly expiresAt: number | undefined;
}

const SOCKET_SESSIONS = new WeakMap<object, SocketSession>();

/**
 * Records the session a socket authenticated with, so that
 * `server.access.disconnectUser(userId, { sessionId })` can end that
 * session's sockets alone, and, with `expiresAt`, so that the server
 * disconnects the socket when the session expires (the 5.1 audit's AUTH-4)
 * and refuses its handshake when it already has. `expiresAt` is a `Date`, a
 * date string, or epoch milliseconds: a JWT's `exp` is in seconds, so pass
 * `exp * 1000`. `socketAuth` calls it for the auth routes' sessions; an
 * app's own `authenticate` may too.
 */
export function recordSocketSession(
  socket: object,
  sessionId: string,
  expiresAt?: Date | number | string,
): void {
  const time = expiresAt === undefined ? Number.NaN : new Date(expiresAt).getTime();
  SOCKET_SESSIONS.set(socket, {
    id: sessionId,
    expiresAt: Number.isNaN(time) ? undefined : time,
  });
}

/** The session a socket authenticated with, when its `authenticate` recorded one. */
export function socketSessionOf(socket: object): string | undefined {
  return SOCKET_SESSIONS.get(socket)?.id;
}

/** When the session a socket authenticated with expires (epoch milliseconds), when it was recorded with one. */
export function socketSessionExpiryOf(socket: object): number | undefined {
  return SOCKET_SESSIONS.get(socket)?.expiresAt;
}

/** What the server knows of an `authenticate` that `socketAuth` made. */
export interface SocketAuthInfo {
  /** Whether it was given `devCredentials`, which sign a socket in by a user id alone. */
  readonly devCredentials: boolean;
}

const SOCKET_AUTHS = new WeakMap<object, SocketAuthInfo>();

/**
 * Marks `authenticate` as `socketAuth`'s: the HTTP transport hands only such
 * an `authenticate` the session cookie as `auth.token`, since it checks the
 * cookie's `Origin` and the session store; every other gets the cookie as
 * `request.sessionCookie` alone.
 */
export function markSocketAuth(authenticate: object, info: SocketAuthInfo): void {
  SOCKET_AUTHS.set(authenticate, Object.freeze({ ...info }));
}

/** What `socketAuth` recorded of `authenticate`, or `undefined` for an `authenticate` it did not make. */
export function socketAuthOf(authenticate: unknown): SocketAuthInfo | undefined {
  return typeof authenticate === "function" ? SOCKET_AUTHS.get(authenticate) : undefined;
}

/**
 * True for a refusal `authenticate` made on purpose, by throwing a
 * `QuickdrawError` with code `UNAUTHENTICATED` (a revoked session, a socket
 * from a page the cookie may not be used from). The transports log those at
 * debug, as the client's doing, and every other failure at error.
 */
export function isRefusal(error: unknown): boolean {
  return error instanceof QuickdrawError && error.code === "UNAUTHENTICATED";
}

/**
 * True for an HTTP call's refusal that `authenticate` made on purpose and
 * the transport answers as it is: a `QuickdrawError` with code `FORBIDDEN`
 * (a session cookie sent from a page `socketAuth` does not allow).
 */
export function isForbiddenCredential(error: unknown): error is QuickdrawError {
  return error instanceof QuickdrawError && error.code === "FORBIDDEN";
}

/** True when `value` has a principal's shape: an object with a non-empty string `userId`. */
export function isPrincipal(value: unknown): value is Principal {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly userId?: unknown }).userId === "string" &&
    (value as { readonly userId: string }).userId.length > 0
  );
}

/**
 * The principal an `authenticate` result stands for: a principal as is, a
 * user id as `{ userId }`, nothing as `null`. Throws `TypeError` for anything
 * else. The MCP bridge reads its `principal` hook's result the same way.
 */
export function toPrincipal(result: unknown): Principal | null {
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

/**
 * The flush sink that refreshes the grants of the users a flush wrote stored
 * grants for, or `undefined` without `serviceAccessSource`. `refresh` is
 * `server.access.refresh`, given once the server exists. Throws a
 * `TypeError` for a source without `loadServiceAccess`, or a malformed one.
 */
export function createGrantsSink<P extends Principal>(
  auth: ServerAuth<P> | undefined,
  refresh: () => ((userId: string) => Promise<unknown>) | undefined,
  logger: Logger,
): FlushSink | undefined {
  const source = auth?.serviceAccessSource;
  if (source === undefined) {
    return undefined;
  }
  const named = (value: unknown): boolean => typeof value === "string" && value.length > 0;
  if (!named(source.model) || !named(source.column)) {
    throw new TypeError("createServer: auth.serviceAccessSource must be { model, column }");
  }
  if (auth?.loadServiceAccess === undefined) {
    throw new TypeError(
      "createServer: auth.serviceAccessSource needs auth.loadServiceAccess to reload the grants it stores",
    );
  }
  const model = modelKey(source.model);
  return Object.freeze({
    async flush(writes): Promise<void> {
      const users = new Set<string>();
      for (const write of writes) {
        const sets = write.fields.includes(source.column) || write.fields.includes(ANY_FIELD);
        if (modelKey(write.model) === model && (write.op !== "update" || sets)) {
          users.add(write.id);
        }
      }
      await Promise.all(
        [...users].map(async (userId) => {
          try {
            await refresh()?.(userId);
          } catch (error) {
            logger.error("Refreshing a user's written grants failed", {
              category: "quickdraw.access",
              userId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }),
      );
    },
  } satisfies FlushSink);
}
