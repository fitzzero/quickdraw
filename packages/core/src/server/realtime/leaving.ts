// Leaving app rooms (RFC 0003 section 12.5, pack H child 3's open questions):
// a socket's own leave, a disconnect, a user taken out of a room from
// anywhere, and the `onRoomLeave` hook that hears each of them.
//
// `leave(room, { userId })` takes every socket of a user out of a room, from
// a handler or from code that is not one (`qd.rooms`): this node's sockets at
// once, and behind a cluster adapter every other node's through an answered
// broadcast (`ROOM_LEAVE_EVENT`, as access changes are:
// `../cluster/broadcasts.ts`), so once it resolves the user hears nothing
// more of the room on any node, and a channel that requires the room drops
// their messages (the requirement reads `socket.data.appRooms`).
//
// Whenever a socket leaves app rooms the hooks hear of it once, on the node
// that held the socket, with each room and whether the socket was its user's
// last one there (`roomFrames.ts` decides it with the room's `left` frame).
// The hooks are every service's own `onRoomLeave` (`defineService`) and the
// server's (`createServer`), composed by `createServer` so no server root
// can forget a service's. Each runs in a detached unit of work of its own
// (`qd.run(fn, { detached: true })`): a leave a handler causes never joins
// that handler's unit, and one hook's writes never flush with another's.
// What one throws is logged with whose hook it is, and the others run all
// the same; the hub keeps their runs in flight, so a server's `close()`
// waits for them.

import { userRoom } from "../../contract/names";
import { answerOf } from "../cluster/acks";
import { track, type Hub } from "../emit/hub";
import { emptyRecords, ownRecord } from "../emit/subscriptions";
import { describeError } from "../pipeline/metrics";
import type { QuickdrawServerSocket } from "../transports/types";
import { exited, type LastInRoom, type RoomState } from "./roomFrames";
import { checkRoom } from "./roomNames";
import type { RoomLeave, RoomLeaveHandler, RoomLeaveReason, RoomLeft } from "./types";

/** The server-to-server event `rooms.leave(room, { userId })` is broadcast on behind a cluster adapter. */
export const ROOM_LEAVE_EVENT = "quickdraw:room-leave";

/** Hears every socket that left app rooms: the app's `onRoomLeave` hooks, wrapped by {@link leaveListener}. */
export type RoomLeaveListener = (leave: RoomLeave) => Promise<void>;

/** Runs a function in a detached unit of work of the dispatcher: `dispatcher.run(fn, { detached: true })`. */
export type DetachedRun = (
  fn: (ctx: Parameters<RoomLeaveHandler>[1]) => Promise<void>,
) => Promise<void>;

/** One `onRoomLeave` hook, and whose it is for the logs: a service's name, or `"createServer"`. */
export interface RoomLeaveHook {
  readonly owner: string;
  readonly handler: RoomLeaveHandler;
}

/** What the app rooms of one dispatcher share, with who hears sockets leave. */
export interface LeavingState extends RoomState {
  listener: RoomLeaveListener | undefined;
}

/**
 * The app's `onRoomLeave` hooks as one listener: for each leave, every hook
 * in a detached unit of work of its own, all at once, each with what it
 * throws logged, so one failing hook stops none of the others.
 */
export function leaveListener(
  hooks: readonly RoomLeaveHook[],
  run: DetachedRun,
  logger: Hub["logger"],
): RoomLeaveListener {
  return async (leave) => {
    await Promise.all(
      hooks.map(async ({ owner, handler }) => {
        try {
          await run(async (ctx) => {
            await handler(leave, ctx);
          });
        } catch (error) {
          logger.error("onRoomLeave threw", {
            category: "quickdraw.rooms",
            owner,
            socketId: leave.socketId,
            reason: leave.reason,
            rooms: leave.rooms.map(({ room }) => room),
            error: describeError(error),
          });
        }
      }),
    );
  };
}

/**
 * Tells the listener that `socket` left `left` (each room with whether it was
 * its user's last socket there, known now or once the other nodes answered).
 */
function heard(
  state: LeavingState,
  socket: QuickdrawServerSocket,
  reason: RoomLeaveReason,
  left: readonly (readonly [string, LastInRoom])[],
): void {
  const { listener } = state;
  if (listener === undefined || left.length === 0) {
    return;
  }
  const principal = socket.data.principal ?? null;
  const deliver = (rooms: readonly RoomLeft[]): void => {
    track(state.hub, listener({ principal, socketId: socket.id, reason, rooms }));
  };
  if (left.every(([, last]) => typeof last === "boolean")) {
    deliver(left.map(([room, last]) => ({ room, last: last as boolean })));
    return;
  }
  track(
    state.hub,
    Promise.all(left.map(async ([room, last]) => ({ room, last: await last }))).then(deliver),
  );
}

/**
 * Takes `socket` out of app room `room` (its own leave, or a removal): it is
 * told it sees nobody now, the room hears its user left when it was their
 * last socket, and the listener hears of it. `false` when it was not in it.
 */
export function leaveRoom(
  state: LeavingState,
  socket: QuickdrawServerSocket,
  room: string,
  reason: Exclude<RoomLeaveReason, "disconnect">,
): boolean {
  const joined = socket.data.appRooms;
  if (joined === undefined || ownRecord(joined, room) === undefined) {
    return false;
  }
  delete joined[room];
  void socket.leave(room);
  const last = exited(state, socket, room, socket.connected, reason === "removed");
  heard(state, socket, reason, [[room, last]]);
  return true;
}

/** A socket disconnected (Socket.IO has emptied its rooms): it leaves every app room it was in. */
export function leaveAll(state: LeavingState, socket: QuickdrawServerSocket): void {
  const left = Object.keys(socket.data.appRooms ?? {}).map(
    (room) => [room, exited(state, socket, room, false)] as const,
  );
  socket.data.appRooms = emptyRecords();
  heard(state, socket, "disconnect", left);
}

/** The user `rooms.leave(room, target)` names; a `TypeError` for anything else. */
function targetUser(target: unknown): string {
  const userId: unknown =
    typeof target === "object" && target !== null
      ? (target as { readonly userId?: unknown }).userId
      : undefined;
  if (typeof userId !== "string" || userId === "") {
    throw new TypeError("rooms.leave: pass { userId } to take a user's sockets out of a room");
  }
  return userId;
}

/** Takes this node's sockets of `userId` out of app room `room`. */
function removeHere(state: LeavingState, room: string, userId: string): void {
  const { io } = state.hub;
  for (const socketId of [...(io?.sockets.adapter.rooms.get(userRoom(userId)) ?? [])]) {
    const socket = io?.sockets.sockets.get(socketId);
    if (socket?.data.principal?.userId === userId) {
      leaveRoom(state, socket, room, "removed");
    }
  }
}

/**
 * `rooms.leave(room, { userId })`: this node's sockets of the user at once,
 * and behind a cluster adapter every other node's, resolving once they
 * answered (at most `cluster.timeoutMs`; at once while the broadcasts are
 * degraded).
 */
export async function removeUser(
  state: LeavingState,
  room: unknown,
  target: unknown,
): Promise<void> {
  checkRoom(room);
  const userId = targetUser(target);
  const { hub } = state;
  const others =
    hub.io === undefined || hub.probe.local()
      ? undefined
      : hub.broadcasts?.broadcast(ROOM_LEAVE_EVENT, { room, userId });
  removeHere(state, room, userId);
  await others;
}

/** Takes this node's sockets out of the rooms other nodes' `leave(room, { userId })` name, and answers. */
export function listenForRemovals(state: LeavingState): void {
  state.hub.io?.on(ROOM_LEAVE_EVENT, (broadcast: unknown, ...rest: unknown[]) => {
    const answer = answerOf(rest);
    const { room, userId } = (broadcast ?? {}) as Readonly<Record<string, unknown>>;
    try {
      checkRoom(room);
      removeHere(state, room, targetUser({ userId }));
      answer(true);
    } catch {
      answer(false);
    }
  });
}
