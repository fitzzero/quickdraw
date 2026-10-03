// `ctx.rooms` (RFC 0003 sections 3 and 12.5): app-defined rooms a method puts
// its calling socket in (a lobby, a document's viewers), and the typed events
// sent to rooms (`events.ts`). Joining works for calls that arrived over a v5
// socket; any other call gets `false` back. The framework's own rooms (`qd:`
// entity, collection, topic and stream rooms, and `user:` rooms) are refused:
// a socket enters them only through their authorized paths, so a method
// cannot be talked into putting a socket in another user's room.
//
// Each socket keeps the app rooms it joined on `socket.data.appRooms` (at
// most `MAX_APP_ROOMS`, in an object without a prototype), so presence knows
// what a disconnect leaves; `qd:presence` frames tell each room who comes and
// goes (`roomFrames.ts`).

import { RESERVED_ROOM_PREFIXES, userRoom } from "../../contract/names";
import { QuickdrawError } from "../../protocol/errors";
import { MAX_SCOPE_LENGTH } from "../../protocol/version";
import { emptyRecords, ownRecord } from "../emit/subscriptions";
import { unreadable } from "../transports/ack";
import type { QuickdrawServerSocket } from "../transports/types";
import { createRoomEvents } from "./events";
import { MAX_APP_ROOMS } from "./presence";
import { entered, exited, type RoomState } from "./roomFrames";
import type { ContextRooms } from "./types";

/** Throws `VALIDATION` unless `room` can name an app room. */
function checkRoom(room: unknown): asserts room is string {
  if (typeof room !== "string" || room === "" || room.length > MAX_SCOPE_LENGTH) {
    throw unreadable(`A room name is a string of 1 to ${MAX_SCOPE_LENGTH} characters`);
  }
  if (RESERVED_ROOM_PREFIXES.some((prefix) => room.startsWith(prefix))) {
    throw unreadable(
      `Room "${room}" is reserved: rooms starting with ${RESERVED_ROOM_PREFIXES.join(" or ")} are joined only through their own subscriptions`,
    );
  }
}

function join(state: RoomState, socket: QuickdrawServerSocket, room: string): boolean {
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

function leave(state: RoomState, socket: QuickdrawServerSocket, room: string): boolean {
  checkRoom(room);
  const joined = socket.data.appRooms;
  if (joined === undefined || ownRecord(joined, room) === undefined) {
    return false;
  }
  delete joined[room];
  void socket.leave(room);
  exited(state, socket, room, socket.connected);
  return true;
}

/** The `ctx.rooms` of each socket, and of calls without one, for one dispatcher. */
export interface Rooms {
  /** The `ctx.rooms` of calls and channel messages from `socket`: made once per socket. */
  of(socket: QuickdrawServerSocket): ContextRooms;
  /** The `ctx.rooms` of calls without a socket: `join` and `leave` answer `false`. */
  readonly detached: ContextRooms;
  /** A socket disconnected (Socket.IO has emptied its rooms): its users leave its app rooms. */
  disconnected(socket: QuickdrawServerSocket): void;
}

/** Creates the rooms of one dispatcher, and their typed events (`events.ts`). */
export function createRooms(state: RoomState): Rooms {
  const events = createRoomEvents(state.hub);
  const bySocket = new WeakMap<QuickdrawServerSocket, ContextRooms>();
  const detached: ContextRooms = Object.freeze({
    ...events,
    join: (room: string) => {
      checkRoom(room);
      return false;
    },
    leave: (room: string) => {
      checkRoom(room);
      return false;
    },
  });
  return Object.freeze({
    of(socket: QuickdrawServerSocket): ContextRooms {
      let rooms = bySocket.get(socket);
      if (rooms === undefined) {
        rooms = Object.freeze({
          ...events,
          join: (room: string) => join(state, socket, room),
          leave: (room: string) => leave(state, socket, room),
        });
        bySocket.set(socket, rooms);
      }
      return rooms;
    },
    detached,
    disconnected(socket: QuickdrawServerSocket): void {
      for (const room of Object.keys(socket.data.appRooms ?? {})) {
        exited(state, socket, room, false);
      }
      socket.data.appRooms = emptyRecords();
      const userId = socket.data.principal?.userId;
      const sockets =
        typeof userId === "string"
          ? state.hub.io?.sockets.adapter.rooms.get(userRoom(userId))
          : undefined;
      if (typeof userId === "string" && userId !== "" && (sockets?.size ?? 0) === 0) {
        state.records.seen(userId, Date.now());
      }
    },
  });
}
