// What a quickdraw server pushes on the app's request, and how the other
// nodes of a cluster hear of it (RFC 0003 sections 4.4 and 8.3):
//
// - `qd:rotate`: every client reconnects within a jitter window;
// - `server.access.refresh(userId)`: the user's grants are reloaded, put in
//   the principal of their sockets, sent to them as `qd:access`, and their
//   entity subscriptions are resolved again (a lost `Admin` grant can end
//   them). Behind a cluster adapter the reloaded grants are broadcast, so
//   every node updates its own sockets of the user.
//
// The adapter probe tells the live data whether rooms are local: true while
// the server runs the in-memory adapter it was created with.

import { SERVER_EVENTS, userRoom } from "../../contract/names";
import type { AdapterProbe } from "../emit/hub";
import type { ServerAuth, ServiceGrants } from "./auth";
import type { SocketExtension } from "./socketio";
import type { QuickdrawIo } from "./types";

/** The server-to-server event reloaded grants are broadcast on behind a cluster adapter. */
export const GRANTS_EVENT = "quickdraw:grants";

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

/** Listens for grants other nodes reloaded, and applies them to this node's sockets. */
export function listenForGrants(io: QuickdrawIo, live: LiveData | undefined): void {
  io.on(GRANTS_EVENT, (broadcast: unknown) => {
    const { userId, serviceAccess } = (broadcast ?? {}) as {
      readonly userId?: unknown;
      readonly serviceAccess?: unknown;
    };
    const grants = typeof serviceAccess === "object" && serviceAccess !== null;
    if (typeof userId === "string" && userId.length > 0 && grants) {
      regrant(io, userId, serviceAccess as ServiceGrants);
      void live?.regranted(userId);
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
