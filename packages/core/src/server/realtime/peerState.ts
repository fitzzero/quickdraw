// What a server keeps for each socket's peer links (RFC 0003 section 12.5):
// its token buckets, the peers it signalled and the peers that signalled it.
// A socket that sends a signal (`qd:peer`) to a peer in a room engages that
// peer: the pair is recorded, at most `MAX_PEER_LINKS` per socket, with its
// own relay bucket. A signal delivered to a socket is heard: the socket's
// pair with its sender turns mutual, or, while the socket has not answered,
// the sender is kept among the heard (at most `MAX_HEARD`, the oldest
// forgotten first). A forgotten sender gets no bye when the socket leaves
// (its link waits out its open timeout), and its pair turns mutual only
// once it signals again after the socket answered: only a socket that
// leaves twice `MAX_PEER_LINKS` signals unanswered meets either. Only a
// mutual pair may relay (`qd:relay`), so a socket relays to no socket that
// never answered it, a made-up id included, and the node it is on drops
// what it sends there; the target's node drops it too once the target left
// the room, before the bye ended the pair. Signals have a bucket of
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

/** A pair the socket engaged: its relay bucket, and whether the peer signalled the socket too. */
export interface PeerPair extends PeerBucket {
  mutual: boolean;
}

/** Peers that signalled a socket it has not answered yet, kept at once. */
export const MAX_HEARD = MAX_PEER_LINKS * 2;

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
  readonly links: Map<string, Map<string, PeerPair>>;
  /** How many pairs `links` holds. */
  count: number;
  /** The peers that signalled the socket and that it has not signalled, oldest first: `[room, peer]` by key. */
  readonly heard: Map<string, readonly [string, string]>;
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
      heard: new Map(),
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

/** The pair, or `undefined` when the socket never signalled `peer` in `room`. */
export function pairOf(state: SocketPeers, room: string, peer: string): PeerPair | undefined {
  return state.links.get(room)?.get(peer);
}

/** The key of a heard peer: a socket id holds no NUL. */
const heardKey = (room: string, peer: string): string => `${room}\u0000${peer}`;

/**
 * Records that `peer` signalled the socket in `room`: their pair turns
 * mutual, or the peer is kept among the heard until the socket answers.
 */
export function hear(state: SocketPeers, room: string, peer: string): void {
  const pair = pairOf(state, room, peer);
  if (pair !== undefined) {
    pair.mutual = true;
    return;
  }
  const key = heardKey(room, peer);
  state.heard.delete(key);
  state.heard.set(key, [room, peer]);
  if (state.heard.size > MAX_HEARD) {
    const [oldest] = state.heard.keys();
    if (oldest !== undefined) {
      state.heard.delete(oldest);
    }
  }
}

/**
 * Records that the socket signalled `peer` in `room`, mutual when the peer
 * signalled it first. False when the pair is new and the socket already
 * signals `MAX_PEER_LINKS` peers.
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
  const mutual = state.heard.delete(heardKey(room, peer));
  peers.set(peer, { ...bucket(PEER_RELAY_BURST, now), mutual });
  state.count += 1;
  return true;
}

/** Forgets the pair, and the peer among the heard: its link ended. */
export function disengage(state: SocketPeers, room: string, peer: string): void {
  state.heard.delete(heardKey(room, peer));
  const peers = state.links.get(room);
  if (peers?.delete(peer) === true) {
    state.count -= 1;
    if (peers.size === 0) {
      state.links.delete(room);
    }
  }
}

/**
 * Forgets every pair and every heard peer in the rooms `ended` accepts (all
 * of them by default) and returns them, each `[room, peer]` once.
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
  for (const [key, entry] of state.heard) {
    if (ended(entry[0])) {
      state.heard.delete(key);
      gone.push(entry);
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
