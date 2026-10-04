// `ctx.rooms` and `qd.rooms` (RFC 0003 sections 3 and 12.5): app-defined
// rooms a method puts its calling socket in (a lobby, a document's viewers),
// the typed events sent to rooms (`events.ts`), taking a user's sockets out
// of a room from anywhere and hearing sockets leave (`leaving.ts`).
//
// Joining works for calls that arrived over a v5 socket; any other call gets
// `false` back. The framework's own rooms (`qd:` entity, collection, topic
// and stream rooms, and `user:` rooms) are refused (`roomNames.ts`).
//
// Each socket keeps the app rooms it joined on `socket.data.appRooms` (at
// most `MAX_APP_ROOMS`, in an object without a prototype), so presence knows
// what a disconnect leaves; `qd:presence` frames tell each room who comes and
// goes (`roomFrames.ts`).

import { userRoom } from "../../contract/names";
import { QuickdrawError } from "../../protocol/errors";
import { emptyRecords, ownRecord } from "../emit/subscriptions";
import type { QuickdrawServerSocket } from "../transports/types";
import { createRoomEvents } from "./events";
import {
  leaveAll,
  leaveListener,
  leaveRoom,
  listenForRemovals,
  removeUser,
  type DetachedRun,
  type LeavingState,
  type RoomLeaveHook,
} from "./leaving";
import { markSeen, MAX_APP_ROOMS } from "./presence";
import { entered, type RoomState } from "./roomFrames";
import { checkRoom } from "./roomNames";
import type { ContextRooms, RoomTarget, ServerRooms } from "./types";

export { ROOM_LEAVE_EVENT, type DetachedRun, type RoomLeaveHook } from "./leaving";

function join(state: LeavingState, socket: QuickdrawServerSocket, room: string): boolean {
  checkRoom(room);
  if (!socket.connected) {
    return false;
  }
  const joined = (socket.data.appRooms ??= emptyRecords<true>());
  if (ownRecord(joined, room) !== undefined) {
    return true;
  }
  if (Object.keys(joined).length >= MAX_APP_ROOMS) {
    throw new QuickdrawError(
      "CONFLICT",
      `A socket may be in at most ${MAX_APP_ROOMS} rooms; leave one before joining another`,
    );
  }
  joined[room] = true;
  void socket.join(room);
  entered(state, socket, room);
  return true;
}

/** The `ctx.rooms` of each socket, of calls without one, and `qd.rooms`, for one dispatcher. */
export interface Rooms {
  /** The `ctx.rooms` of calls and channel messages from `socket`: made once per socket. */
  of(socket: QuickdrawServerSocket): ContextRooms;
  /** The `ctx.rooms` of calls without a socket: `join` and `leave(room)` answer `false`. */
  readonly detached: ContextRooms;
  /** `qd.rooms`, `server.rooms`, `dispatcher.rooms`: what needs no calling socket. */
  readonly server: ServerRooms;
  /** A socket disconnected (Socket.IO has emptied its rooms): its users leave its app rooms. */
  disconnected(socket: QuickdrawServerSocket): void;
  /**
   * Runs `hooks` for every socket that leaves app rooms from now on (each
   * service's `onRoomLeave` and `createServer`'s), each through `run`, a
   * detached unit of work of its own.
   */
  onLeave(hooks: readonly RoomLeaveHook[], run: DetachedRun): void;
  /** Takes this node's sockets out of rooms other nodes' `leave(room, { userId })` name. */
  listen(): void;
}

/** `leave(room)` and `leave(room, target)` in one function: `own` leaves the calling socket, if any. */
function leaveOf(
  own: (room: string) => boolean,
  removal: (room: string, target: RoomTarget) => Promise<void>,
): ContextRooms["leave"] {
  return ((room: string, target?: RoomTarget) => {
    if (target !== undefined) {
      return removal(room, target);
    }
    checkRoom(room);
    return own(room);
  }) as ContextRooms["leave"];
}

/** Creates the rooms of one dispatcher, and their typed events (`events.ts`). */
export function createRooms(base: RoomState): Rooms {
  const state: LeavingState = { ...base, listener: undefined };
  const events = createRoomEvents(state.hub);
  const removal = (room: string, target: RoomTarget): Promise<void> =>
    removeUser(state, room, target);
  const server: ServerRooms = Object.freeze({ ...events, leave: removal });
  const bySocket = new WeakMap<QuickdrawServerSocket, ContextRooms>();
  const detached: ContextRooms = Object.freeze({
    ...events,
    join: (room: string) => {
      checkRoom(room);
      return false;
    },
    leave: leaveOf(() => false, removal),
  });
  return Object.freeze({
    of(socket: QuickdrawServerSocket): ContextRooms {
      let rooms = bySocket.get(socket);
      if (rooms === undefined) {
        rooms = Object.freeze({
          ...events,
          join: (room: string) => join(state, socket, room),
          leave: leaveOf((room) => leaveRoom(state, socket, room, "leave"), removal),
        });
        bySocket.set(socket, rooms);
      }
      return rooms;
    },
    detached,
    server,
    disconnected(socket: QuickdrawServerSocket): void {
      leaveAll(state, socket);
      const userId = socket.data.principal?.userId;
      const sockets =
        typeof userId === "string"
          ? state.hub.io?.sockets.adapter.rooms.get(userRoom(userId))
          : undefined;
      if (typeof userId === "string" && userId !== "" && (sockets?.size ?? 0) === 0) {
        markSeen(state.hub, state.records, userId, Date.now());
      }
    },
    onLeave(hooks: readonly RoomLeaveHook[], run: DetachedRun): void {
      state.listener = hooks.length === 0 ? undefined : leaveListener(hooks, run, state.hub.logger);
    },
    listen(): void {
      listenForRemovals(state);
    },
  });
}

/**
 * `rooms` whose `join` and own `leave` throw `INTERNAL`: the `ctx.rooms` of
 * a method that shares its runs (`share`). A shared run serves several
 * callers with the first one's `ctx`, so it would join or leave that
 * caller's socket only. Its events (`emit`, `emitToUser`) and
 * `leave(room, { userId })` stay: they name their room or user.
 */
export function unjoinable(rooms: ContextRooms, share: string): ContextRooms {
  const refuse = (member: string): never => {
    throw new QuickdrawError(
      "INTERNAL",
      `ctx.rooms.${member} cannot run in a method that shares its runs (share: "${share}"): a shared run serves several callers and would ${member} only the first caller's socket; join rooms from a method without share`,
    );
  };
  return Object.freeze({
    ...rooms,
    join: () => refuse("join"),
    leave: ((room: string, target?: RoomTarget) =>
      target === undefined ? refuse("leave") : rooms.leave(room, target)) as ContextRooms["leave"],
  });
}
