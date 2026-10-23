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
// tagged with the deployment), and a node asks the others for the hosts
// their own sockets hold and their clocks (`quickdraw:room-hosts`) when it
// starts behind a cluster adapter, or once `setupRedisAdapter` set one
// (`seedRoomHosts`). The Redis adapter waits for as many answers as it
// counts subscribers when asked, and right after it subscribed it can miss
// its own: so the ask goes once the adapter's subscribing connection
// answered a PING sent after its subscriptions (one connection's commands
// run in order), and with an adapter that has no such client it goes again
// `cluster.timeoutMs` after the first answer. Each ask waits as presence's
// requests do (`requestDeadlineOf`) and keeps the answers that came, so one
// silent node among several withholds only its own hosts. Each record has a
// version, a hybrid clock in microseconds: the time, or one past every
// version the node heard when that is later. Records are ordered by
// version, then by socket id, and a clear ends every record of the room
// ordered at or before the one it clears, whatever its host, and is
// remembered (the latest `MAX_CLEARED` rooms). So each node holds what the
// latest event it heard says, a host or none, whatever order the events
// reached it in, and two `setHost` at once on two nodes leave every node
// with the same answer. A node that turns down a record older than what it
// holds sends what it holds again, so a node whose clock is behind, or that
// started late, comes round. A node that dies without closing leaves its
// hosts' records on the others until the room's host is set or cleared
// again.

import { SERVER_EVENTS } from "../../contract/names";
import { QuickdrawError } from "../../protocol/errors";
import { isRoomName, isSocketId } from "../../protocol/peer";
import { answersOf, DEFAULT_CLUSTER_TIMEOUT_MS, requestDeadlineOf, within } from "../cluster/acks";
import { emitToNodes, onNodeEvent, tagged } from "../cluster/deployment";
import { track, type Hub } from "../emit/hub";
import { describeError } from "../pipeline/metrics";
import type { QuickdrawIo, QuickdrawServerSocket } from "../transports/types";
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
  /** The record each room was last cleared of, oldest first: no record ordered at or before it applies again. */
  readonly cleared: Map<string, HostRecord>;
  /** The latest version this node took or heard, of any room: its next one is later. */
  clock: number;
  hooks: readonly HostLeaveHook[];
  run: Run | undefined;
}

/** Microseconds per millisecond: a version is a time in microseconds, as a revision is. */
const MICROS_PER_MS = 1000;

/** True when `record` wins over `other`: a higher version, or the same and a greater host. */
function wins(record: HostRecord, other: HostRecord | undefined): boolean {
  return (
    other === undefined ||
    record.version > other.version ||
    (record.version === other.version && record.host > other.host)
  );
}

/** True when the room was cleared of a record `record` does not win over: it is as old or older. */
function stale(state: State, room: string, record: HostRecord): boolean {
  const cleared = state.cleared.get(room);
  return cleared !== undefined && !wins(record, cleared);
}

/** Notes a version heard: this node's next one is later. */
function observe(state: State, version: number): void {
  state.clock = Math.max(state.clock, version);
}

/** The version of a change made here: the time in microseconds, after every version heard. */
function nextVersion(state: State): number {
  state.clock = Math.max(Date.now() * MICROS_PER_MS, state.clock + 1);
  return state.clock;
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

/** Ends the room's record when it is ordered at or before `cleared`, and remembers the clear. */
function forget(state: State, room: string, cleared: HostRecord): void {
  const current = state.hosts.get(room);
  if (current !== undefined && !wins(current, cleared)) {
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

/** Makes `host` the room's host from here, ordered after every record this node heard. */
function change(state: State, room: string, host: string): void {
  const record = { host, version: nextVersion(state) };
  apply(state, room, record);
  publish(state, room, host, record);
}

/**
 * A record from another node lost to what this node holds of the room (its
 * host, or the clear that ended the last one): this node sends what it holds
 * again, so the node that took the older record comes round. A copy of what
 * it holds changes nothing, and is not answered.
 */
function repair(state: State, room: string, record: HostRecord): void {
  const current = state.hosts.get(room);
  const cleared = state.cleared.get(room);
  if (cleared !== undefined && wins(cleared, current)) {
    if (wins(cleared, record)) {
      publish(state, room, null, cleared);
    }
  } else if (current !== undefined && wins(current, record)) {
    publish(state, room, current.host, current);
  }
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

/** Takes the other nodes' clocks, and the hosts they hold where they win over this node's records. */
function merge(state: State, answers: unknown): void {
  for (const answer of Array.isArray(answers) ? answers : []) {
    const { hosts, clock } = (answer ?? {}) as {
      readonly hosts?: unknown;
      readonly clock?: unknown;
    };
    if (isVersion(clock)) {
      observe(state, clock);
    }
    for (const entry of Array.isArray(hosts) ? (hosts as unknown[]) : []) {
      const [room, host, version] = Array.isArray(entry) ? (entry as unknown[]) : [];
      if (isRoomName(room) && isSocketId(host) && isVersion(version)) {
        observe(state, version);
        apply(state, room, { host, version });
      }
    }
  }
}

/** The room hosts of each server, by its Socket.IO server, for `seedRoomHosts`. */
const HOSTS_BY_IO = new WeakMap<object, State>();

/** A client that answers PING. */
interface Pinging {
  ping(): unknown;
}

/**
 * The subscribing client of `io`'s Socket.IO Redis adapter, when its PING
 * goes on the connection that holds the adapter's subscriptions, after them.
 * None for another adapter, or a cluster client (ioredis's `Cluster`,
 * node-redis's `createCluster`), which may send it to another node.
 */
function subscriberOf(io: QuickdrawIo): Pinging | undefined {
  const adapter = io.sockets.adapter as unknown as { readonly subClient?: unknown } | undefined;
  const client = adapter?.subClient;
  if (typeof client !== "object" || client === null) {
    return undefined;
  }
  const { ping, isCluster, masters } = client as {
    readonly ping?: unknown;
    readonly isCluster?: unknown;
    readonly masters?: unknown;
  };
  const cluster = isCluster === true || Array.isArray(masters);
  return typeof ping === "function" && !cluster ? (client as Pinging) : undefined;
}

/**
 * Asks the other nodes for the hosts their own sockets are, and their
 * clocks, and takes whatever came: every answer, or, when a node did not
 * answer in time, those the adapter handed over at its own timeout
 * (`requestDeadlineOf`, as presence waits).
 */
async function ask(state: State, io: QuickdrawIo): Promise<void> {
  try {
    merge(
      state,
      await within(
        io.serverSideEmitWithAck(ROOM_HOSTS_EVENT, tagged(io, {})),
        requestDeadlineOf(state.hub, io),
      ),
    );
  } catch (error) {
    // The silent node's hosts reach this node with their next changes.
    merge(state, answersOf(error));
  }
}

/** Resolves after `ms`, without holding the process open. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * Asks the other nodes for their hosts once this node's adapter can count it
 * (the top of this file): after its subscribing connection answered a PING,
 * or, with an adapter that cannot say, at once and again `cluster.timeoutMs`
 * after the first answer. Nothing on a server still on its in-memory adapter.
 */
function seed(state: State): void {
  const { io } = state.hub;
  if (io === undefined || state.hub.probe.local()) {
    return;
  }
  const timeoutMs = state.hub.cluster?.timeoutMs ?? DEFAULT_CLUSTER_TIMEOUT_MS;
  const twice = async (): Promise<void> => {
    await ask(state, io);
    await pause(timeoutMs);
    await ask(state, io);
  };
  const subscriber = subscriberOf(io);
  if (subscriber === undefined) {
    void twice();
    return;
  }
  void within(
    Promise.resolve().then(() => subscriber.ping()),
    timeoutMs,
  ).then(async () => {
    await ask(state, io);
  }, twice);
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
    observe(state, read.record.version);
    if (read.host === null) {
      // A clear ends the record it names, and any ordered before it; never one set since.
      forget(state, read.room, read.record);
    } else if (!apply(state, read.room, read.record)) {
      repair(state, read.room, read.record);
    }
  });
  onNodeEvent(
    io,
    state.hub.logger,
    ROOM_HOSTS_EVENT,
    (_payload, answer) => {
      // The hosts this node's own sockets are (the records it is sure of), and its clock.
      answer({
        hosts: [...state.hosts]
          .filter(([, record]) => io.sockets.sockets.has(record.host))
          .map(([room, record]) => [room, record.host, record.version]),
        clock: state.clock,
      });
    },
    { hosts: [] },
  );
  HOSTS_BY_IO.set(io, state);
  seed(state);
}

/**
 * Asks the other nodes for the hosts they hold, for the server whose
 * Socket.IO server is `io`, now that it runs a cluster adapter it did not
 * start with: `setupRedisAdapter` calls it once it set the adapter. Nothing
 * for a server still on its in-memory adapter, or one without room hosts.
 */
export function seedRoomHosts(io: object): void {
  const state = HOSTS_BY_IO.get(io);
  if (state !== undefined) {
    seed(state);
  }
}

/** Creates the room hosts of one dispatcher; `served` says whether its server serves peer links. */
export function createRoomHosts(hub: Hub, served: () => boolean): RoomHosts {
  const state: State = {
    hub,
    served,
    hosts: new Map(),
    cleared: new Map(),
    clock: 0,
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
