// What a quickdraw server pushes on the app's request, and how the other
// nodes of a cluster hear of it (RFC 0003 sections 4.4 and 8.3):
//
// - `qd:rotate`: every client reconnects within a jitter window;
// - `server.access.refresh(userId)`: the user's grants are reloaded, put in
//   the principal of their sockets, sent to them as `qd:access`, and their
//   entity subscriptions are resolved again (a lost `Admin` grant can end
//   them). Behind a cluster adapter the reloaded grants are broadcast, so
//   every node updates its own sockets of the user;
// - `server.access.disconnectUser(userId, { sessionId? })`: the user's
//   sockets (of one session) are disconnected, on every node.
//
// The adapter probe tells the live data whether rooms are local: true while
// the server runs the in-memory adapter it was created with.

import type { Logger } from "../../contract/logger";
import { SERVER_EVENTS, userRoom } from "../../contract/names";
import type { AdapterProbe } from "../emit/hub";
import { describeError } from "../pipeline/metrics";
import { socketSessionOf, type ServerAuth, type ServiceGrants } from "./auth";
import type { SocketExtension } from "./socketio";
import type { QuickdrawIo } from "./types";

/** The server-to-server event reloaded grants are broadcast on behind a cluster adapter. */
export const GRANTS_EVENT = "quickdraw:grants";

/** The server-to-server event `server.access.disconnectUser` is broadcast on behind a cluster adapter. */
export const DISCONNECT_USER_EVENT = "quickdraw:disconnect-user";

/** Options of `server.access.disconnectUser`. */
export interface DisconnectUserOptions {
  /** End only the sockets that authenticated with this session (`recordSocketSession`). */
  readonly sessionId?: string;
  /** Why, for the log. */
  readonly reason?: string;
}

/** What the socket server needs of its dispatcher's live data (`emit/live.ts`). */
export interface LiveData {
  readonly extension: SocketExtension;
  attach(io: QuickdrawIo, probe: AdapterProbe): void;
  regranted(userId: string): Promise<void>;
}

/**
 * The adapter probe of `io`: local while the server's adapter is the
 * in-memory one it was created with. An adapter given in the Socket.IO
 * options (`configured`) counts as a cluster adapter, like one an app sets
 * later with `io.adapter(...)` (`setupRedisAdapter`).
 */
export function adapterProbe(io: QuickdrawIo, configured: boolean): AdapterProbe {
  const initial = configured ? undefined : io.adapter();
  return Object.freeze({ local: () => initial !== undefined && io.adapter() === initial });
}

/** Sends `qd:rotate` to every client. */
export function rotate(io: QuickdrawIo, withinMs: number): void {
  if (typeof withinMs !== "number" || !Number.isFinite(withinMs) || withinMs < 0) {
    throw new TypeError("rotate: withinMs must be a number of milliseconds, 0 or more");
  }
  io.emit(SERVER_EVENTS.rotate, { withinMs });
}

/** Puts `serviceAccess` in the principal of this process's sockets of `userId`. */
function regrant(io: QuickdrawIo, userId: string, serviceAccess: ServiceGrants): void {
  for (const socketId of io.sockets.adapter.rooms.get(userRoom(userId)) ?? []) {
    const socket = io.sockets.sockets.get(socketId);
    const principal = socket?.data.principal;
    if (socket !== undefined && principal?.userId === userId) {
      socket.data.principal = { ...principal, serviceAccess };
    }
  }
}

/** Disconnects this process's sockets of `userId` (of one session, with `sessionId`); returns how many. */
function disconnectHere(io: QuickdrawIo, userId: string, sessionId: string | undefined): number {
  let ended = 0;
  for (const socketId of [...(io.sockets.adapter.rooms.get(userRoom(userId)) ?? [])]) {
    const socket = io.sockets.sockets.get(socketId);
    const own = socket?.data.principal?.userId === userId;
    if (
      socket !== undefined &&
      own &&
      (sessionId === undefined || socketSessionOf(socket) === sessionId)
    ) {
      socket.disconnect(true);
      ended += 1;
    }
  }
  return ended;
}

/** A broadcast `disconnectUser`, read; `undefined` for anything else. */
function readDisconnect(
  value: unknown,
): { readonly userId: string; readonly sessionId: string | undefined } | undefined {
  const { userId, sessionId } = (value ?? {}) as {
    readonly userId?: unknown;
    readonly sessionId?: unknown;
  };
  if (typeof userId !== "string" || userId.length === 0) {
    return undefined;
  }
  return { userId, sessionId: typeof sessionId === "string" ? sessionId : undefined };
}

/**
 * `server.access.disconnectUser(userId, options)`: disconnects every socket
 * of the user on this node (only those of one session with `sessionId`), and,
 * behind a cluster adapter, tells every other node to do the same. For a
 * session the app revoked (`createAuthRoutes`' `onRevoke`): a socket keeps
 * the principal it authenticated with until it reconnects, and its
 * reconnect is authenticated afresh. Returns how many sockets this node ended.
 */
export function disconnectUser(
  io: QuickdrawIo,
  probe: AdapterProbe,
  logger: Logger,
  userId: string,
  options: DisconnectUserOptions = {},
): number {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new TypeError("access.disconnectUser: pass the user's id");
  }
  const { sessionId, reason } = options;
  if (!probe.local()) {
    io.serverSideEmit(
      DISCONNECT_USER_EVENT,
      sessionId === undefined ? { userId } : { userId, sessionId },
    );
  }
  const ended = disconnectHere(io, userId, sessionId);
  logger.info("Disconnected a user's sockets", {
    category: "quickdraw.socket",
    userId,
    sockets: ended,
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(reason === undefined ? {} : { reason }),
  });
  return ended;
}

/** Listens for `disconnectUser` broadcasts from other nodes, and ends this node's sockets they name. */
export function listenForDisconnects(io: QuickdrawIo): void {
  io.on(DISCONNECT_USER_EVENT, (broadcast: unknown) => {
    const request = readDisconnect(broadcast);
    if (request !== undefined) {
      disconnectHere(io, request.userId, request.sessionId);
    }
  });
}

/** Listens for grants other nodes reloaded, and applies them to this node's sockets. */
export function listenForGrants(io: QuickdrawIo, live: LiveData | undefined, logger: Logger): void {
  io.on(GRANTS_EVENT, (broadcast: unknown) => {
    const { userId, serviceAccess } = (broadcast ?? {}) as {
      readonly userId?: unknown;
      readonly serviceAccess?: unknown;
    };
    const grants = typeof serviceAccess === "object" && serviceAccess !== null;
    if (typeof userId === "string" && userId.length > 0 && grants) {
      regrant(io, userId, serviceAccess as ServiceGrants);
      live?.regranted(userId).catch((error: unknown) => {
        logger.error("Resolving the subscriptions of a user another node regranted failed", {
          category: "quickdraw.access",
          userId,
          error: describeError(error),
        });
      });
    }
  });
}

/**
 * `server.access.refresh(userId)`: reloads the user's grants, applies them on
 * every node (broadcast behind a cluster adapter), sends them to the user's
 * sockets as `qd:access`, and resolves this node's subscriptions of the user
 * again.
 */
export async function refreshGrants(
  io: QuickdrawIo,
  load: ServerAuth["loadServiceAccess"],
  live: LiveData | undefined,
  probe: AdapterProbe,
  userId: string,
): Promise<ServiceGrants> {
  if (load === undefined) {
    throw new TypeError("access.refresh needs auth.loadServiceAccess to reload a user's grants");
  }
  const serviceAccess = (await load(userId)) ?? {};
  if (!probe.local()) {
    io.serverSideEmit(GRANTS_EVENT, { userId, serviceAccess });
  }
  regrant(io, userId, serviceAccess);
  io.to(userRoom(userId)).emit(SERVER_EVENTS.access, { serviceAccess });
  await live?.regranted(userId);
  return serviceAccess;
}
