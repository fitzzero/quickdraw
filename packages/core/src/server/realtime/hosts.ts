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
// other nodes as `quickdraw:room-host` (`{ room, host, version, was? }`,
// tagged with the deployment), and a node that starts asks the others once
// for the hosts their own sockets hold (`quickdraw:room-hosts`). Each
// record has a version: a node's next host of a room takes one more than
// every record of it the node heard, and of two records the higher version
// wins, then the greater socket id, so two `setHost` at once on two nodes
// settle on one host on every node. A clear applies only to the record it
// names, and the node remembers it a while (the latest `MAX_CLEARED`), so a
// record of that host as old reaches no node again, an answer to a
// starting node's question included. A node that dies without closing
// leaves its hosts' records on the others until the room's host is set or
// cleared again.

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

/** A room's host, with the version that orders it against another node's record. */
interface HostRecord {
  readonly host: string;
  readonly version: number;
}

/** The most rooms whose last cleared host a node remembers. */
const MAX_CLEARED = 10_000;

interface State {
  readonly hub: Hub;
  /** True once the server serves peer links, which host mode runs over. */
  readonly served: () => boolean;
  /** The host of every room that has one, by room: this node's record of every node's. */
  readonly hosts: Map<string, HostRecord>;
  /** The host each room had when it was last cleared, oldest first: no record of it as old applies again. */
  readonly cleared: Map<string, HostRecord>;
  hooks: readonly HostLeaveHook[];
  run: Run | undefined;
}

/** True when `record` wins over `other`: a higher version, or the same and a greater host. */
function wins(record: HostRecord, other: HostRecord | undefined): boolean {
  return (
    other === undefined ||
    record.version > other.version ||
    (record.version === other.version && record.host > other.host)
  );
}

/** True when `record` names a host the room was cleared of at its version or after. */
function stale(state: State, room: string, record: HostRecord): boolean {
  const cleared = state.cleared.get(room);
  return cleared?.host === record.host && cleared.version >= record.version;
}

/** Tells the room's sockets on this node who its host is. */
function tell(state: State, room: string, host: string | null): void {
  state.hub.io?.local.to(room).emit(SERVER_EVENTS.host, [room, host]);
}

/** Takes in a record from here or another node, when it wins over the room's: true when it did. */
function apply(state: State, room: string, record: HostRecord): boolean {
  if (stale(state, room, record) || !wins(record, state.hosts.get(room))) {
    return false;
  }
  state.hosts.set(room, record);
  tell(state, room, record.host);
  return true;
}

/** Ends the room's record of `cleared`, and remembers it. */
function forget(state: State, room: string, cleared: HostRecord): void {
  const current = state.hosts.get(room);
  if (current?.host === cleared.host && current.version <= cleared.version) {
    state.hosts.delete(room);
    tell(state, room, null);
  }
  const known = state.cleared.get(room);
  if (known === undefined || wins(cleared, known)) {
    state.cleared.delete(room);
    state.cleared.set(room, cleared);
    const oldest = state.cleared.size > MAX_CLEARED ? state.cleared.keys().next().value : undefined;
    if (oldest !== undefined) {
      state.cleared.delete(oldest);
    }
  }
}

/** Tells the other nodes of a change made here. */
function publish(state: State, room: string, host: string | null, record: HostRecord): void {
  const { io } = state.hub;
  if (io !== undefined && !state.hub.probe.local()) {
    const was = host === null ? { was: record.host } : {};
    emitToNodes(io, ROOM_HOST_EVENT, { room, host, version: record.version, ...was });
  }
}

/** Makes `host` the room's host from here, after every record of the room this node heard. */
function change(state: State, room: string, host: string): void {
  const version =
    Math.max(state.hosts.get(room)?.version ?? 0, state.cleared.get(room)?.version ?? 0) + 1;
  const record = { host, version };
  apply(state, room, record);
  publish(state, room, host, record);
}

/** Clears the room's host from here, and tells the other nodes. */
function clear(state: State, room: string): void {
  const current = state.hosts.get(room);
  if (current !== undefined) {
    forget(state, room, current);
    publish(state, room, null, current);
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
  if (state.hosts.get(room)?.host !== socket.id) {
    change(state, room, socket.id);
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
  clear(state, room);
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

/** A record's version on the wire: a positive whole number. */
const isVersion = (version: unknown): version is number =>
  Number.isSafeInteger(version) && (version as number) > 0;

/** A `quickdraw:room-host` payload, read: `undefined` when it is not one. */
function readChange(
  payload: unknown,
):
  | { readonly room: string; readonly host: string | null; readonly record: HostRecord }
  | undefined {
  const { room, host, version, was } = (payload ?? {}) as Readonly<Record<string, unknown>>;
  if (!isRoomName(room) || !isVersion(version)) {
    return undefined;
  }
  if (host === null) {
    return isSocketId(was) ? { room, host, record: { host: was, version } } : undefined;
  }
  return isSocketId(host) ? { room, host, record: { host, version } } : undefined;
}

/** Takes the hosts the other nodes hold, where they win over this node's records. */
function merge(state: State, answers: unknown): void {
  for (const answer of Array.isArray(answers) ? answers : []) {
    for (const entry of Array.isArray(answer) ? (answer as unknown[]) : []) {
      const [room, host, version] = Array.isArray(entry) ? (entry as unknown[]) : [];
      if (isRoomName(room) && isSocketId(host) && isVersion(version)) {
        apply(state, room, { host, version });
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
    if (read.host === null) {
      // A clear ends the record it names, never one set since.
      forget(state, read.room, read.record);
    } else {
      apply(state, read.room, read.record);
    }
  });
  onNodeEvent(
    io,
    state.hub.logger,
    ROOM_HOSTS_EVENT,
    (_payload, answer) => {
      // The hosts this node's own sockets are: the records it is sure of.
      answer(
        [...state.hosts]
          .filter(([, record]) => io.sockets.sockets.has(record.host))
          .map(([room, record]) => [room, record.host, record.version]),
      );
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
  const state: State = {
    hub,
    served,
    hosts: new Map(),
    cleared: new Map(),
    hooks: [],
    run: undefined,
  };
  return Object.freeze({
    set: (socket: QuickdrawServerSocket, room: string) => setHost(state, socket, room),
    of(room: string): string | null {
      checkRoom(room);
      return state.hosts.get(room)?.host ?? null;
    },
    clear(room: string): void {
      checkRoom(room);
      clear(state, room);
    },
    joined(socket: QuickdrawServerSocket, room: string): void {
      const record = state.hosts.get(room);
      if (record !== undefined) {
        socket.emit(SERVER_EVENTS.host, [room, record.host]);
      }
    },
    left(socket: QuickdrawServerSocket, room: string, reason: RoomLeaveReason): void {
      if (state.hosts.get(room)?.host === socket.id) {
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
