// What a server keeps for each socket's peer links (RFC 0003 section 12.5):
// its token buckets and the peers it signalled. A socket that sends a
// signal (`qd:peer`) to a peer in a room engages that peer: the pair is
// recorded, at most `MAX_PEER_LINKS` per socket, and only an engaged pair
// may relay (`qd:relay`), each with its own bucket. Signals have a bucket of
// their own, and relayed bytes one more, shared by all of a socket's peers.
// Messages dropped over a bucket count toward the channels' abuse guard: a
// socket whose drops within `CHANNEL_ABUSE_WINDOW_MS` pass
// `CHANNEL_ABUSE_MULTIPLIER` times the rate is disconnected.

import {
  MAX_PEER_LINKS,
  PEER_RELAY_BURST,
  PEER_RELAY_BYTES_BURST,
  PEER_RELAY_BYTES_PER_SECOND,
  PEER_RELAY_RATE,
  PEER_SIGNAL_BURST,
  PEER_SIGNAL_RATE,
} from "../../protocol/version";
import { ownRecord } from "../emit/subscriptions";
import type { QuickdrawServerSocket } from "../transports/types";
import { CHANNEL_ABUSE_MULTIPLIER, CHANNEL_ABUSE_WINDOW_MS } from "./channels";

export { MAX_PEER_LINKS } from "../../protocol/version";

/** A token bucket. */
export interface PeerBucket {
  tokens: number;
  refilledAt: number;
}

/** The messages one socket had dropped since its abuse window started. */
interface Drops {
  windowStart: number;
  dropped: number;
}

/** What one socket's peer links share. */
export interface SocketPeers {
  readonly socket: QuickdrawServerSocket;
  readonly signals: PeerBucket;
  /** Relayed bytes, to every peer together. */
  readonly bytes: PeerBucket;
  /** The peers the socket signalled, by room, each with the pair's relay bucket. */
  readonly links: Map<string, Map<string, PeerBucket>>;
  /** How many pairs `links` holds. */
  count: number;
  readonly signalDrops: Drops;
  readonly relayDrops: Drops;
}

const STATES = new WeakMap<QuickdrawServerSocket, SocketPeers>();

function bucket(tokens: number, now: number): PeerBucket {
  return { tokens, refilledAt: now };
}

/** The socket's peer state, made on first use. */
export function peersOf(socket: QuickdrawServerSocket, now = Date.now()): SocketPeers {
  let state = STATES.get(socket);
  if (state === undefined) {
    state = {
      socket,
      signals: bucket(PEER_SIGNAL_BURST, now),
      bytes: bucket(PEER_RELAY_BYTES_BURST, now),
      links: new Map(),
      count: 0,
      signalDrops: { windowStart: now, dropped: 0 },
      relayDrops: { windowStart: now, dropped: 0 },
    };
    STATES.set(socket, state);
  }
  return state;
}

/** The socket's peer state, if it ever signalled or was signalled through this node. */
export function knownPeers(socket: QuickdrawServerSocket): SocketPeers | undefined {
  return STATES.get(socket);
}

/** Takes `cost` tokens, refilling first at `rate` a second up to `burst`; false when too few are left. */
function take(state: PeerBucket, rate: number, burst: number, now: number, cost = 1): boolean {
  state.tokens = Math.min(burst, state.tokens + ((now - state.refilledAt) / 1000) * rate);
  state.refilledAt = now;
  if (state.tokens < cost) {
    return false;
  }
  state.tokens -= cost;
  return true;
}

/** Takes a signal's token; false when the socket is over its signal rate. */
export function takeSignal(state: SocketPeers, now: number): boolean {
  return take(state.signals, PEER_SIGNAL_RATE, PEER_SIGNAL_BURST, now);
}

/** How long until the socket may signal again, in milliseconds, for `RATE_LIMITED`. */
export function signalWaitMs(state: SocketPeers): number {
  return Math.ceil(((1 - state.signals.tokens) / PEER_SIGNAL_RATE) * 1000);
}

/** Takes a relay message's tokens from the pair's bucket and `bytes` from the socket's; false when either is short. */
export function takeRelay(
  state: SocketPeers,
  pair: PeerBucket,
  bytes: number,
  now: number,
): boolean {
  if (!take(pair, PEER_RELAY_RATE, PEER_RELAY_BURST, now)) {
    return false;
  }
  return take(state.bytes, PEER_RELAY_BYTES_PER_SECOND, PEER_RELAY_BYTES_BURST, now, bytes);
}

/** Counts a drop; true once the window's drops pass the abuse threshold for `rate`. */
function abusive(drops: Drops, rate: number, now: number): boolean {
  if (now - drops.windowStart > CHANNEL_ABUSE_WINDOW_MS) {
    drops.windowStart = now;
    drops.dropped = 0;
  }
  drops.dropped += 1;
  return drops.dropped > rate * CHANNEL_ABUSE_MULTIPLIER;
}

/** Counts a refused signal; true once the socket floods. */
export function signalFlood(state: SocketPeers, now: number): boolean {
  return abusive(state.signalDrops, PEER_SIGNAL_RATE, now);
}

/** Counts a dropped relay message; true once the socket floods. */
export function relayFlood(state: SocketPeers, now: number): boolean {
  return abusive(state.relayDrops, PEER_RELAY_RATE, now);
}

/** The pair's relay bucket, or `undefined` when the socket never signalled `peer` in `room`. */
export function pairOf(state: SocketPeers, room: string, peer: string): PeerBucket | undefined {
  return state.links.get(room)?.get(peer);
}

/**
 * Records that the socket signalled `peer` in `room`. False when the pair is
 * new and the socket already signals `MAX_PEER_LINKS` peers.
 */
export function engage(state: SocketPeers, room: string, peer: string, now: number): boolean {
  if (pairOf(state, room, peer) !== undefined) {
    return true;
  }
  if (state.count >= MAX_PEER_LINKS) {
    return false;
  }
  let peers = state.links.get(room);
  if (peers === undefined) {
    peers = new Map();
    state.links.set(room, peers);
  }
  peers.set(peer, bucket(PEER_RELAY_BURST, now));
  state.count += 1;
  return true;
}

/** Forgets the pair: its link ended. */
export function disengage(state: SocketPeers, room: string, peer: string): void {
  const peers = state.links.get(room);
  if (peers?.delete(peer) === true) {
    state.count -= 1;
    if (peers.size === 0) {
      state.links.delete(room);
    }
  }
}

/**
 * Forgets every pair in the rooms `ended` accepts (all of them by default)
 * and returns them, each `[room, peer]`.
 */
export function disengageAll(
  state: SocketPeers,
  ended: (room: string) => boolean = () => true,
): (readonly [string, string])[] {
  const gone: (readonly [string, string])[] = [];
  for (const [room, peers] of state.links) {
    if (ended(room)) {
      for (const peer of peers.keys()) {
        gone.push([room, peer]);
      }
      state.links.delete(room);
      state.count -= peers.size;
    }
  }
  return gone;
}

/** Whether the socket is in app room `room` (one a method joined). */
export function inRoom(socket: QuickdrawServerSocket, room: string): boolean {
  return ownRecord(socket.data.appRooms, room) !== undefined;
}

/** Whether a peer link frame may reach `socket` in `room`: a connected, signed-in v5 socket in the room. */
export function reachable(socket: QuickdrawServerSocket, room: string): boolean {
  return (
    socket.connected &&
    socket.data.protocol !== "legacy" &&
    socket.data.principal !== null &&
    inRoom(socket, room)
  );
}
