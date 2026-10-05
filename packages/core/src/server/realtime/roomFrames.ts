// The `qd:presence` frames of app rooms (RFC 0003 section 12.5): a socket
// that joins gets `{ room, users }`, the whole list (its own user included);
// the room's other sockets get `{ room, joined }` when it is its user's first
// socket there, and `{ room, left }` when a user's last socket leaves or
// disconnects; a socket that leaves, or is taken out, gets `{ room, users: [] }`.
//
// On the in-memory adapter the list comes from this process's records, sent
// in order with the join. Behind a cluster adapter it is read from every node
// (`fetchSockets`, asynchronously, and dropped when the socket left the room
// before it arrived), and a user's last socket here leaving sends `left` only
// when no node still has one of theirs in the room. A `joined` may then
// repeat for a user already there on another node; a client keeps a set, so a
// repeat changes nothing. A removal (`rooms.leave(room, { userId })`) reaches
// every node, so each sends `left` for its last socket of the user without
// asking the others: it may repeat, and is never missed.
//
// The same decision, whether a socket was its user's last in the room, is
// what `onRoomLeave` hears as `last` (`leaving.ts`).

import { SERVER_EVENTS } from "../../contract/names";
import type { PresenceFrame } from "../../protocol/envelope";
import { track, type Hub } from "../emit/hub";
import { ownRecord } from "../emit/subscriptions";
import { describeError } from "../pipeline/metrics";
import type { QuickdrawServerSocket } from "../transports/types";
import { inRoom, usersInRoom, type PresenceRecords } from "./presence";

/** Whether a socket that left a room was its user's last one there: known now, or once the other nodes answered. */
export type LastInRoom = boolean | Promise<boolean>;

/** What the app rooms of one dispatcher share. */
export interface RoomState {
  readonly hub: Hub;
  readonly records: PresenceRecords;
}

function logFailure(state: RoomState, room: string, error: unknown): void {
  state.hub.logger.error("Reading a room's presence from the cluster failed", {
    category: "quickdraw.presence",
    room,
    error: describeError(error),
  });
}

function sendList(socket: QuickdrawServerSocket, room: string, users: readonly string[]): void {
  const frame: PresenceFrame = { room, users };
  socket.emit(SERVER_EVENTS.presence, frame);
}

/** A socket entered app room `room`: it gets the list, the room hears of a new user. */
export function entered(state: RoomState, socket: QuickdrawServerSocket, room: string): void {
  const userId = socket.data.principal?.userId;
  const first = typeof userId === "string" && userId !== "" && state.records.entered(room, userId);
  if (first) {
    const frame: PresenceFrame = { room, joined: userId };
    socket.to(room).emit(SERVER_EVENTS.presence, frame);
  }
  if (state.hub.probe.local()) {
    sendList(socket, room, state.records.users(room) ?? []);
    return;
  }
  track(
    state.hub,
    usersInRoom(state.hub, state.records, room).then(
      (users) => {
        // A socket that left (or was taken out) meanwhile was told it sees nobody: keep it so.
        if (socket.connected && ownRecord(socket.data.appRooms, room) !== undefined) {
          sendList(socket, room, users);
        }
      },
      (error: unknown) => {
        logFailure(state, room, error);
      },
    ),
  );
}

/**
 * A socket left app room `room` (`told`: it asked to, or was taken out, and
 * is told it sees nobody now) or disconnected: the room hears when its user
 * is gone. Returns whether it was its user's last socket in the room (true
 * for an anonymous socket): on one server at once; behind a cluster adapter
 * once every node was asked (true when they cannot be), unless `everywhere`
 * says the user is being taken out on every node anyway (a removal), when
 * this node's last socket is last without asking.
 */
export function exited(
  state: RoomState,
  socket: QuickdrawServerSocket,
  room: string,
  told: boolean,
  everywhere = false,
): LastInRoom {
  if (told) {
    sendList(socket, room, []);
  }
  const userId = socket.data.principal?.userId;
  if (typeof userId !== "string" || userId === "") {
    return true;
  }
  const { io } = state.hub;
  if (!state.records.exited(room, userId)) {
    return false;
  }
  if (io === undefined) {
    return true;
  }
  const frame: PresenceFrame = { room, left: userId };
  if (state.hub.probe.local() || everywhere) {
    io.to(room).emit(SERVER_EVENTS.presence, frame);
    return true;
  }
  const last = inRoom(state.hub, state.records, room, userId).then(
    (still) => {
      if (!still) {
        io.to(room).emit(SERVER_EVENTS.presence, frame);
      }
      return !still;
    },
    (error: unknown) => {
      logFailure(state, room, error);
      return true;
    },
  );
  track(state.hub, last);
  return last;
}
