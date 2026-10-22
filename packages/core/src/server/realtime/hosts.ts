// The hosts of app rooms (host mode, RFC 0003 section 12.5). A method makes
// the calling socket a room's host with `ctx.rooms.setHost(room)`; the host's
// client then serves the room's host-served channels and streams to the
// room's other sockets over peer links, and the server only says who it is:
// `qd:host [room, host]` goes to the room's sockets on every change, and to
// a socket that joins a room with a host, so a client always knows whom to
// link to; `null` says the room has none.
//
// When the host socket leaves the room (its own leave, a removal) or
// disconnects, the room's host is cleared, the room hears
// `qd:host [room, null]`, and the `onHostLeave` hooks run, each in a
// detached unit of work of its own on the host's node. There is no
// re-election: the app decides what follows.
//
// Behind a cluster adapter each node keeps the host of every room, so a
// socket that joins on any node hears it at once: a change goes to the
// other nodes as `quickdraw:room-host` (`{ room, host, was }`, tagged with
// the deployment; a clear applies only to the host it names), and a node
// that starts asks the others once for the hosts their own sockets hold
// (`quickdraw:room-hosts`). A node that dies without closing leaves its
// hosts' records on the others until the room's host is set or cleared
// again.

import { SERVER_EVENTS } from "../../contract/names";
import { QuickdrawError } from "../../protocol/errors";
import { isRoomName, isSocketId } from "../../protocol/peer";
import { DEFAULT_CLUSTER_TIMEOUT_MS, within } from "../cluster/acks";
import { emitToNodes, onNodeEvent, tagged } from "../cluster/deployment";
import { track, type Hub } from "../emit/hub";
import { describeError } from "../pipeline/metrics";
import type { QuickdrawServerSocket } from "../transports/types";
import { checkRoom } from "./roomNames";
import type { HostLeave, HostLeaveHook, RoomHosts, RoomLeaveReason } from "./types";

/** The server-to-server event a room's new host, or its clearing, goes to the other nodes on. */
export const ROOM_HOST_EVENT = "quickdraw:room-host";

/** The server-to-server event a starting node asks the others for the hosts they hold on. */
export const ROOM_HOSTS_EVENT = "quickdraw:room-hosts";

type Run = Parameters<RoomHosts["onLeave"]>[1];

interface State {
  readonly hub: Hub;
  /** True once the server serves peer links, which host mode runs over. */
  readonly served: () => boolean;
  /** The host of every room that has one, by room: this node's record of every node's. */
  readonly hosts: Map<string, string>;
  hooks: readonly HostLeaveHook[];
  run: Run | undefined;
}

/** Tells the room's sockets on this node who its host is. */
function tell(state: State, room: string, host: string | null): void {
  state.hub.io?.local.to(room).emit(SERVER_EVENTS.host, [room, host]);
}

/** Records the room's host (`null`: none), tells its sockets here, and the other nodes. */
function change(state: State, room: string, host: string | null, was: string | undefined): void {
  if (host === null) {
    state.hosts.delete(room);
  } else {
    state.hosts.set(room, host);
  }
  tell(state, room, host);
  const { io } = state.hub;
  if (io !== undefined && !state.hub.probe.local()) {
    emitToNodes(io, ROOM_HOST_EVENT, { room, host, ...(was === undefined ? {} : { was }) });
  }
}

function setHost(state: State, socket: QuickdrawServerSocket, room: string): boolean {
  checkRoom(room);
  if (!state.served()) {
    throw new QuickdrawError(
      "INTERNAL",
      "ctx.rooms.setHost: host mode runs over peer links; create the server with peers: true",
    );
  }
  if (!socket.connected) {
    return false;
  }
  const joined = socket.data.appRooms;
  if (joined === undefined || !Object.hasOwn(joined, room)) {
    throw new QuickdrawError("FORBIDDEN", `Only a socket in room "${room}" can host it`);
  }
  if (socket.data.principal === null) {
    throw new QuickdrawError("UNAUTHENTICATED", "Sign in to host a room");
  }
  if (state.hosts.get(room) !== socket.id) {
    change(state, room, socket.id, state.hosts.get(room));
  }
  return true;
}

/** The room has no host now: its host left it. The hooks hear of it. */
function hostLeft(
  state: State,
  socket: QuickdrawServerSocket,
  room: string,
  reason: RoomLeaveReason,
): void {
  change(state, room, null, socket.id);
  const { hooks, run } = state;
  if (run === undefined) {
    return;
  }
  const leave: HostLeave = {
    room,
    socketId: socket.id,
    principal: socket.data.principal ?? null,
    reason,
  };
  for (const { owner, handler } of hooks) {
    const ran = run(async (ctx) => {
      await handler(leave, ctx);
    }).catch((error: unknown) => {
      state.hub.logger.error("onHostLeave threw", {
        category: "quickdraw.rooms",
        owner,
        room,
        socketId: socket.id,
        reason,
        error: describeError(error),
      });
    });
    track(state.hub, ran);
  }
}

/** A `quickdraw:room-host` payload, read: `undefined` when it is not one. */
function readChange(
  payload: unknown,
): { readonly room: string; readonly host: string | null; readonly was: unknown } | undefined {
  const { room, host, was } = (payload ?? {}) as Readonly<Record<string, unknown>>;
  return isRoomName(room) && (host === null || isSocketId(host)) ? { room, host, was } : undefined;
}

/** Takes the hosts the other nodes hold, for the rooms this node knows none of. */
function merge(state: State, answers: unknown): void {
  for (const answer of Array.isArray(answers) ? answers : []) {
    for (const entry of Array.isArray(answer) ? (answer as unknown[]) : []) {
      const [room, host] = Array.isArray(entry) ? (entry as unknown[]) : [];
      if (isRoomName(room) && isSocketId(host) && !state.hosts.has(room)) {
        state.hosts.set(room, host);
        tell(state, room, host);
      }
    }
  }
}

function listen(state: State): void {
  const { io } = state.hub;
  if (io === undefined) {
    return;
  }
  onNodeEvent(io, state.hub.logger, ROOM_HOST_EVENT, (payload) => {
    const read = readChange(payload);
    if (read === undefined) {
      return;
    }
    const { room, host, was } = read;
    if (host === null) {
      // A clear ends the host it names, never one set since.
      if (state.hosts.get(room) !== was) {
        return;
      }
      state.hosts.delete(room);
    } else {
      state.hosts.set(room, host);
    }
    tell(state, room, host);
  });
  onNodeEvent(
    io,
    state.hub.logger,
    ROOM_HOSTS_EVENT,
    (_payload, answer) => {
      // The hosts this node's own sockets are: the records it is sure of.
      answer([...state.hosts].filter(([, host]) => io.sockets.sockets.has(host)));
    },
    [],
  );
  if (!state.hub.probe.local()) {
    const timeoutMs = state.hub.cluster?.timeoutMs ?? DEFAULT_CLUSTER_TIMEOUT_MS;
    within(io.serverSideEmitWithAck(ROOM_HOSTS_EVENT, tagged(io, {})), timeoutMs).then(
      (answers) => {
        merge(state, answers);
      },
      () => undefined,
    );
  }
}

/** Creates the room hosts of one dispatcher; `served` says whether its server serves peer links. */
export function createRoomHosts(hub: Hub, served: () => boolean): RoomHosts {
  const state: State = { hub, served, hosts: new Map(), hooks: [], run: undefined };
  return Object.freeze({
    set: (socket: QuickdrawServerSocket, room: string) => setHost(state, socket, room),
    of(room: string): string | null {
      checkRoom(room);
      return state.hosts.get(room) ?? null;
    },
    clear(room: string): void {
      checkRoom(room);
      const was = state.hosts.get(room);
      if (was !== undefined) {
        change(state, room, null, was);
      }
    },
    joined(socket: QuickdrawServerSocket, room: string): void {
      const host = state.hosts.get(room);
      if (host !== undefined) {
        socket.emit(SERVER_EVENTS.host, [room, host]);
      }
    },
    left(socket: QuickdrawServerSocket, room: string, reason: RoomLeaveReason): void {
      if (state.hosts.get(room) === socket.id) {
        hostLeft(state, socket, room, reason);
      }
    },
    onLeave(hooks: readonly HostLeaveHook[], run: Run): void {
      state.hooks = hooks;
      state.run = run;
    },
    listen: () => {
      listen(state);
    },
  });
}
