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
import type { Logger } from "../../contract/logger";
import { QuickdrawError } from "../../protocol/errors";
import { modelKey } from "../storage";
import type { MaybePromise, Principal } from "../types";
import type { FlushSink } from "../uow/flushSink";
import { ANY_FIELD } from "../uow/types";

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
   * failed", with `{ code: "UNAUTHENTICATED" }` as the `connect_error` data) or
   * answers the HTTP call with `UNAUTHENTICATED`; returning nothing lets the
   * caller in anonymously, so only `"public"` methods pass. Throw a
   * `QuickdrawError("UNAUTHENTICATED", ...)` for a refusal that is the
   * caller's doing (it logs at debug; anything else thrown logs at error).
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
   * section 4.4). Needs `loadServiceAccess`.
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

const SOCKET_SESSIONS = new WeakMap<object, string>();

/**
 * Records the session a socket authenticated with, so that
 * `server.access.disconnectUser(userId, { sessionId })` can end that
 * session's sockets alone. `socketAuth` calls it for the auth routes'
 * sessions; an app's own `authenticate` may too.
 */
export function recordSocketSession(socket: object, sessionId: string): void {
  SOCKET_SESSIONS.set(socket, sessionId);
}

/** The session a socket authenticated with, when its `authenticate` recorded one. */
export function socketSessionOf(socket: object): string | undefined {
  return SOCKET_SESSIONS.get(socket);
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
