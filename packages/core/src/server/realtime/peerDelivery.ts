// Delivering peer link frames (RFC 0003 section 12.5): a signal or a relay
// message goes to its socket when the socket is on this node, connected,
// signed in and in the frame's room. Behind a cluster adapter a socket on
// no socket of this node may be on another: the frame goes to every node of
// the deployment (`quickdraw:peer`, `quickdraw:relay`, tagged:
// `../cluster/deployment.ts`), and the node that holds the socket checks it
// the same way before it sends.
//
// A signal delivered to a socket is heard (`peerState.ts`): it makes the
// pair mutual, which relaying needs. A `bye` ends the pair on both sides:
// the sender's record (`peers.ts`) and the receiver's, so neither keeps a
// slot for a link that is over.
//
// A relay message on `fast` is dropped while the target's connection is
// backed up: `PEER_RELAY_FAST_BACKLOG` relay messages sent to it wait for
// the transport (counted until the connection hands what waits to it, its
// `drain`). Not Socket.IO's volatile, which drops a message whenever a
// write is in flight, so that of two `fast` messages that reach the server
// at once the second was always lost.

import { SERVER_EVENTS } from "../../contract/names";
import type { PeerForwardFrame, RelayForwardFrame } from "../../protocol/envelope";
import { PEER_RELAY_FAST_BACKLOG } from "../../protocol/version";
import { emitToNodes, onNodeEvent } from "../cluster/deployment";
import type { Hub } from "../emit/hub";
import type { QuickdrawServerSocket } from "../transports/types";
import { readForwardedRelay, readForwardedSignal } from "./peerFrames";
import {
  disengage,
  disengageAll,
  hear,
  knownPeers,
  peersOf,
  reachable,
  type SocketPeers,
} from "./peerState";

/** The server-to-server event a signal for a socket of another node goes out on. */
export const PEER_SIGNAL_EVENT = "quickdraw:peer";

/** The server-to-server event a relay message for a socket of another node goes out on. */
export const PEER_RELAY_EVENT = "quickdraw:relay";

/** The socket `id` names, when it is connected to this node. */
export function localSocket(hub: Hub, id: string): QuickdrawServerSocket | undefined {
  return hub.io?.sockets.sockets.get(id);
}

/** The server, when the sockets of other nodes may be reached through it: behind a cluster adapter. */
export function clusterOf(hub: Hub): Hub["io"] {
  return hub.probe.local() ? undefined : hub.io;
}

/** Sends a signal to `target`, which hears it; a `bye` ends the target's own record of the pair. */
function emitSignal(target: QuickdrawServerSocket, frame: PeerForwardFrame): void {
  target.emit(SERVER_EVENTS.peer, frame);
  if (frame.sig.bye !== true) {
    hear(peersOf(target), frame.room, frame.from);
    return;
  }
  const state = knownPeers(target);
  if (state !== undefined) {
    disengage(state, frame.room, frame.from);
  }
}

/** Relay messages sent to each socket since its connection last handed what waits to its transport. */
const waiting = new WeakMap<QuickdrawServerSocket, number>();

/** Sends a relay message to `target`; one on `fast` is dropped while its connection is backed up. */
function emitRelay(target: QuickdrawServerSocket, frame: RelayForwardFrame): void {
  const count = waiting.get(target) ?? 0;
  if (frame[2] === "fast" && count >= PEER_RELAY_FAST_BACKLOG) {
    return;
  }
  if (count === 0) {
    target.conn.once("drain", () => {
      waiting.delete(target);
    });
  }
  waiting.set(target, count + 1);
  target.emit(SERVER_EVENTS.relay, frame);
}

/** Delivers a signal for socket `to`: here when it is this node's, else to the other nodes. */
export function sendSignal(hub: Hub, to: string, frame: PeerForwardFrame): void {
  const target = localSocket(hub, to);
  if (target !== undefined) {
    if (reachable(target, frame.room)) {
      emitSignal(target, frame);
    }
    return;
  }
  const io = clusterOf(hub);
  if (io !== undefined) {
    emitToNodes(io, PEER_SIGNAL_EVENT, { ...frame, to });
  }
}

/** Delivers a relay message for socket `to`: here when it is this node's, else to the other nodes. */
export function sendRelay(hub: Hub, to: string, frame: RelayForwardFrame): void {
  const target = localSocket(hub, to);
  if (target !== undefined) {
    if (reachable(target, frame[0])) {
      emitRelay(target, frame);
    }
    return;
  }
  const io = clusterOf(hub);
  if (io !== undefined) {
    const [room, from, label, text] = frame;
    emitToNodes(io, PEER_RELAY_EVENT, { room, to, from, label, text });
  }
}

/**
 * Ends the socket's links in the rooms `ended` accepts (every room by
 * default): each peer it signalled there, and each that signalled it, gets
 * a `bye` from it, and the pairs are forgotten.
 */
export function sayGoodbye(hub: Hub, state: SocketPeers, ended?: (room: string) => boolean): void {
  const { socket } = state;
  const userId = socket.data.principal?.userId;
  for (const [room, peer] of disengageAll(state, ended)) {
    // Only a signed-in socket signals, so a pair always has a user.
    if (userId !== undefined) {
      sendSignal(hub, peer, { room, from: socket.id, userId, sig: { bye: true } });
    }
  }
}

/** Delivers the signals and relay messages other nodes of the deployment forward to this node's sockets. */
export function listenForPeers(hub: Hub): void {
  const { io } = hub;
  if (io === undefined) {
    return;
  }
  onNodeEvent(io, hub.logger, PEER_SIGNAL_EVENT, (payload) => {
    const signal = readForwardedSignal(payload);
    const target = signal === undefined ? undefined : localSocket(hub, signal.to);
    if (signal !== undefined && target !== undefined && reachable(target, signal.room)) {
      const { room, from, userId, sig } = signal;
      emitSignal(target, { room, from, userId, sig });
    }
  });
  onNodeEvent(io, hub.logger, PEER_RELAY_EVENT, (payload) => {
    const relay = readForwardedRelay(payload);
    const target = relay === undefined ? undefined : localSocket(hub, relay.to);
    if (relay !== undefined && target !== undefined && reachable(target, relay.room)) {
      emitRelay(target, [relay.room, relay.from, relay.label, relay.text]);
    }
  });
}
