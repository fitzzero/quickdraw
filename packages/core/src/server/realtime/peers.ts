// Peer links (RFC 0003 section 12.5), on a server created with `peers:
// true`: two sockets of one app room open WebRTC data channels between them
// (`createPeerLink` on the client), and the server carries what the link
// needs from it and nothing else. It never terminates WebRTC (a server on
// Cloud Run or behind a tunnel has no UDP ingress): it signals and relays.
//
// - `qd:peer { room, to, sig }`, acknowledged when asked, forwards a signal
//   (a session description, an ICE candidate, `relay`, `bye`) to socket `to`
//   as `{ room, from, userId, sig }`: `userId` is the sender's user as the
//   server knows it, so a peer never takes another's word for who it is. The
//   sender must be signed in and in the room, and `to` too (checked on the
//   node that holds it); a socket signals at most `MAX_PEER_LINKS` peers at
//   once, `PEER_SIGNAL_RATE` signals a second (`PEER_SIGNAL_BURST` at once).
// - `qd:relay [room, to, label, text]`, never acknowledged, carries one link
//   message when the data channels cannot (ICE failed, a client without
//   WebRTC) as `[room, from, label, text]`, dropped on `fast` while the receiver's connection is backed up (`peerDelivery.ts`). Only
//   between two sockets of the room that signalled each other in it, at
//   most `PEER_RELAY_RATE` messages a second to each peer and
//   `PEER_RELAY_BYTES_PER_SECOND` bytes to all of them. The text is never
//   parsed. Dropped silently otherwise; a socket that keeps flooding either
//   event is disconnected, as for channels.
// - When a socket leaves a room (its own leave, a removal) or disconnects,
//   each peer it signalled there, and each that signalled it, gets
//   `{ sig: { bye: true } }` from it, so a player taken out of a room loses
//   the links the room gave it, and a peer waiting for its answer hears at
//   once that none will come.
//
// What travels over a direct link never reaches the server: it authorizes
// signalling and relay by room membership, and trusts nothing a peer sends.

import { CLIENT_EVENTS } from "../../contract/names";
import type { Ok } from "../../protocol/envelope";
import { QuickdrawError } from "../../protocol/errors";
import { answerNow, onDisconnect } from "../emit/answer";
import type { Hub } from "../emit/hub";
import { describeError } from "../pipeline/metrics";
import type { QuickdrawServerSocket, SocketContext } from "../transports/types";
import {
  clusterOf,
  listenForPeers,
  localSocket,
  sayGoodbye,
  sendRelay,
  sendSignal,
} from "./peerDelivery";
import { readRelayFrame, readSignalFrame } from "./peerFrames";
import {
  disengage,
  engage,
  inRoom,
  knownPeers,
  MAX_PEER_LINKS,
  pairOf,
  peersOf,
  reachable,
  relayFlood,
  signalFlood,
  signalWaitMs,
  takeRelay,
  takeSignal,
  type SocketPeers,
} from "./peerState";

const OK: Ok = Object.freeze({ ok: true });

function flooded(hub: Hub, state: SocketPeers, event: string): void {
  hub.logger.warn(`Disconnecting socket ${state.socket.id} for sustained flooding of ${event}`, {
    category: "quickdraw.peer",
    userId: state.socket.data.principal?.userId,
  });
  state.socket.disconnect(true);
}

/** Refuses a signal over the socket's rate, and disconnects a socket that keeps sending. */
function overRate(hub: Hub, state: SocketPeers, now: number): QuickdrawError {
  if (signalFlood(state, now)) {
    flooded(hub, state, CLIENT_EVENTS.peer);
  }
  return new QuickdrawError("RATE_LIMITED", "Too many peer signals from this socket", {
    retryAfterMs: signalWaitMs(state),
  });
}

/** One `qd:peer` frame, checked, then delivered; a refusal throws its `QuickdrawError`. */
function signal(hub: Hub, state: SocketPeers, frame: unknown): Ok {
  const { socket } = state;
  const { room, to, sig } = readSignalFrame(frame, socket.id);
  const now = Date.now();
  if (!takeSignal(state, now)) {
    if (sig.bye === true) {
      // The pair ends here all the same; only the peer is not told.
      disengage(state, room, to);
    }
    throw overRate(hub, state, now);
  }
  const { principal } = socket.data;
  if (principal === null) {
    throw new QuickdrawError("UNAUTHENTICATED", "Sign in to signal a peer");
  }
  if (!inRoom(socket, room)) {
    throw new QuickdrawError("FORBIDDEN", `This socket is not in room "${room}"`);
  }
  const forward = { room, from: socket.id, userId: principal.userId, sig };
  if (sig.bye === true) {
    disengage(state, room, to);
    sendSignal(hub, to, forward);
    return OK;
  }
  const target = localSocket(hub, to);
  if (target === undefined ? clusterOf(hub) === undefined : !reachable(target, room)) {
    // A pair whose peer went away without a bye frees its place.
    disengage(state, room, to);
    throw new QuickdrawError("NOT_FOUND", `No signed-in socket ${to} is in room "${room}"`);
  }
  if (!engage(state, room, to, now)) {
    throw new QuickdrawError(
      "CONFLICT",
      `A socket may signal at most ${MAX_PEER_LINKS} peers at once; close a link first`,
    );
  }
  sendSignal(hub, to, forward);
  return OK;
}

/** One `qd:relay` frame: passed on when the pair may relay it, else dropped. */
function relay(hub: Hub, state: SocketPeers, frame: unknown): void {
  const now = Date.now();
  const read = readRelayFrame(frame);
  const pair = read === undefined ? undefined : pairOf(state, read.room, read.to);
  if (
    read === undefined ||
    pair?.mutual !== true ||
    !inRoom(state.socket, read.room) ||
    !takeRelay(state, pair, read.bytes, now)
  ) {
    if (relayFlood(state, now)) {
      flooded(hub, state, CLIENT_EVENTS.relay);
    }
    return;
  }
  sendRelay(hub, read.to, [read.room, state.socket.id, read.label, read.text]);
}

/** The peer links of one dispatcher's live data. */
export interface PeerLinks {
  /** Serves `qd:peer` and `qd:relay` on a v5 socket, and ends its links when it disconnects. */
  extension(socket: QuickdrawServerSocket, context: SocketContext): void;
  /** Delivers what the other nodes forward to this node's sockets: once, when the server serves peer links. */
  listen(): void;
  /** The socket left an app room and is still connected: its links in rooms it left end. */
  left(socket: QuickdrawServerSocket): void;
  /** True once the server serves peer links (`listen` ran), which a room's host needs. */
  served(): boolean;
}

/** Creates the peer links of the dispatcher whose hub this is. */
export function createPeerLinks(hub: Hub): PeerLinks {
  let served = false;
  return Object.freeze({
    extension(socket: QuickdrawServerSocket, context: SocketContext): void {
      socket.on(CLIENT_EVENTS.peer, (frame: unknown, ack: unknown) => {
        answerNow(socket, context, CLIENT_EVENTS.peer, ack, () =>
          signal(hub, peersOf(socket), frame),
        );
      });
      socket.on(CLIENT_EVENTS.relay, (frame: unknown) => {
        try {
          relay(hub, peersOf(socket), frame);
        } catch (error) {
          // Socket.IO runs listeners from nextTick, where a throw would end the process.
          hub.logger.error("A relay message failed", {
            category: "quickdraw.peer",
            socketId: socket.id,
            error: describeError(error),
          });
        }
      });
      onDisconnect(socket, context, () => {
        const state = knownPeers(socket);
        if (state !== undefined) {
          sayGoodbye(hub, state);
        }
      });
    },
    listen: () => {
      served = true;
      listenForPeers(hub);
    },
    served: () => served,
    left(socket: QuickdrawServerSocket): void {
      const state = knownPeers(socket);
      if (state !== undefined) {
        sayGoodbye(hub, state, (room) => !inRoom(socket, room));
      }
    },
  });
}
