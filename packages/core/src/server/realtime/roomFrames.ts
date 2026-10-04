// The `qd:presence` frames of app rooms (RFC 0003 section 12.5): a socket
// that joins gets `{ room, users }`, the whole list (its own user included);
// the room's other sockets get `{ room, joined }` when it is its user's first
// socket there, and `{ room, left }` when a user's last socket leaves or
// disconnects; a socket that leaves gets `{ room, users: [] }`.
//
// On the in-memory adapter the list comes from this process's records, sent
// in order with the join. Behind a cluster adapter it is read from every node
// (`fetchSockets`, asynchronously), and a user's last socket here leaving
// sends `left` only when no node still has one of theirs in the room. A
// `joined` may then repeat for a user already there on another node; a client
// keeps a set, so a repeat changes nothing.

import { SERVER_EVENTS } from "../../contract/names";
import type { PresenceFrame } from "../../protocol/envelope";
import { track, type Hub } from "../emit/hub";
import { describeError } from "../pipeline/metrics";
import type { QuickdrawServerSocket } from "../transports/types";
import { inRoom, usersInRoom, type PresenceRecords } from "./presence";

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
        if (socket.connected) {
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
 * A socket left app room `room` (`told`: it asked to, and is told it sees
 * nobody now) or disconnected: the room hears when its user is gone.
 */
export function exited(
  state: RoomState,
  socket: QuickdrawServerSocket,
  room: string,
  told: boolean,
): void {
  if (told) {
    sendList(socket, room, []);
  }
  const userId = socket.data.principal?.userId;
  const last = typeof userId === "string" && userId !== "" && state.records.exited(room, userId);
  const { io } = state.hub;
  if (!last || io === undefined) {
    return;
  }
  const frame: PresenceFrame = { room, left: userId };
  if (state.hub.probe.local()) {
    io.to(room).emit(SERVER_EVENTS.presence, frame);
    return;
  }
  track(
    state.hub,
    inRoom(state.hub, state.records, room, userId).then(
      (still) => {
        if (!still) {
          io.to(room).emit(SERVER_EVENTS.presence, frame);
        }
      },
      (error: unknown) => {
        logFailure(state, room, error);
      },
    ),
  );
}
