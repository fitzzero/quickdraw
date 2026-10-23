// What one connection serves of one app room as its host (host mode, RFC
// 0003 section 12.5): the runtime of each contract `serve` was called for,
// over one set of links to the room's peers. It answers the room's link
// requests (`onPeerRequest`: peers offer, the host answers) and takes the
// host's own client over an in-process link (`registerLocalHost`, with
// `local.ts`'s maker, which only a host loads). Each peer, either way, is
// attached to every runtime with its link (`HostPeer.link`), and each of
// its messages goes to the runtime of the message's service; a subscribe
// to a service no runtime serves is refused (`NOT_FOUND`) by one that
// does, within the peer's subscribe bucket there and through its way out,
// so a peer's feed never waits on it and a peer cannot flood the host with
// them. A peer is detached when its link closes. The last runtime's
// removal stops it all: the links close, and no request is answered.
//
// React-free.

import type { HostMessage } from "../../protocol/envelope";
import type { QuickdrawConnection } from "../connection";
import { controlOf } from "../peer/core";
import { onPeerRequest, type PeerRequest } from "../peer/link";
import type { PeerLink } from "../peer/types";
import { registerLocalHost } from "./links";
import { createLocalLink } from "./local";
import type { AttachedPeer, HostPeer, HostRuntime, HostSend, RuntimePeer } from "./runtime";

/** One connection's serving of one room. */
export interface RoomServing {
  /** Serves `service` with `runtime`; a `TypeError` when the room serves that service already. */
  add(service: string, runtime: HostRuntime): void;
  /** Stops serving `service` (its runtime closes); the room's last one stops it all. */
  remove(service: string, runtime: HostRuntime): void;
}

/** A peer of the room, either way, and what each runtime attached of it. */
interface Attachment {
  readonly peer: HostPeer;
  readonly send: HostSend;
  readonly close: () => void;
  readonly attached: Map<string, RuntimePeer>;
}

interface State {
  readonly room: string;
  readonly runtimes: Map<string, HostRuntime>;
  readonly peers: Set<Attachment>;
  readonly links: Set<PeerLink>;
}

const all = new WeakMap<QuickdrawConnection, Map<string, RoomServing>>();

function attachAll(state: State, at: Attachment): void {
  for (const [service, runtime] of state.runtimes) {
    if (!at.attached.has(service)) {
      at.attached.set(service, runtime.attach(at.peer, at.send, at.close));
    }
  }
}

/** A message from a peer: to the runtime of its service, or a subscribe refused. */
function deliver(at: Attachment, message: HostMessage): void {
  const attached = at.attached.get(message[1]);
  if (attached !== undefined) {
    attached.receive(message);
  } else if (message[0] === 4) {
    at.attached.values().next().value?.unserved(message);
  }
}

/** A peer, either way: attached to every runtime, now and later, until `detach`. */
function join(state: State, peer: HostPeer, send: HostSend, close: () => void): AttachedPeer {
  const at: Attachment = { peer, send, close, attached: new Map() };
  state.peers.add(at);
  attachAll(state, at);
  return {
    receive: (message) => {
      deliver(at, message);
    },
    detach: () => {
      for (const attached of at.attached.values()) {
        attached.detach();
      }
      at.attached.clear();
      state.peers.delete(at);
    },
  };
}

/** Takes `link` as a peer of the room's, of user `userId`, until it closes; `close` ends it after a flood. */
function adopt(state: State, link: PeerLink, userId: string, close: () => void): void {
  const control = controlOf(link);
  if (control === undefined || link.state === "closed") {
    return;
  }
  state.links.add(link);
  const peer = join(state, { socketId: link.peer, userId, link }, control.send, close);
  const off = control.on((message) => {
    peer.receive(message);
  });
  link.on("close", () => {
    off();
    peer.detach();
    state.links.delete(link);
  });
}

function accept(state: State, request: PeerRequest): void {
  let link: PeerLink;
  try {
    link = request.accept();
  } catch {
    // A link the app opened itself to that peer, in this room.
    return;
  }
  adopt(state, link, request.userId, () => {
    link.close();
  });
}

function open(
  connection: QuickdrawConnection,
  room: string,
  rooms: Map<string, RoomServing>,
): RoomServing {
  const state: State = { room, runtimes: new Map(), peers: new Set(), links: new Set() };
  const stopRequests = onPeerRequest(connection, (request) => {
    if (request.room === room) {
      accept(state, request);
    }
  });
  // The host's own client: a flood of its own is not ended.
  const unregister = registerLocalHost(
    connection,
    room,
    (link) => {
      adopt(state, link, link.userId ?? "", () => undefined);
    },
    createLocalLink,
  );
  return {
    add(service: string, runtime: HostRuntime): void {
      if (state.runtimes.has(service)) {
        throw new TypeError(
          `serve: this connection serves ${service} in room "${room}" already; close that Host first`,
        );
      }
      state.runtimes.set(service, runtime);
      for (const at of state.peers) {
        attachAll(state, at);
      }
    },
    remove(service: string, runtime: HostRuntime): void {
      if (state.runtimes.get(service) !== runtime) {
        return;
      }
      state.runtimes.delete(service);
      for (const at of state.peers) {
        at.attached.get(service)?.detach();
        at.attached.delete(service);
      }
      runtime.close();
      if (state.runtimes.size > 0) {
        return;
      }
      rooms.delete(room);
      stopRequests();
      unregister();
      for (const link of [...state.links]) {
        link.close();
      }
    },
  };
}

/** The serving of `room` on `connection`, opened on first use. */
export function serving(connection: QuickdrawConnection, room: string): RoomServing {
  let rooms = all.get(connection);
  if (rooms === undefined) {
    rooms = new Map();
    all.set(connection, rooms);
  }
  let found = rooms.get(room);
  if (found === undefined) {
    found = open(connection, room, rooms);
    rooms.set(room, found);
  }
  return found;
}
