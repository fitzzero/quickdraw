// The peer links of one connection (RFC 0003 section 12.5): one listener
// each for `qd:peer`, `qd:relay` and `qd:presence` on its socket, routing a
// frame by its room and peer however many links the connection holds, as
// `../live/demux.ts` routes live frames. A link belongs to its connection,
// not to a `QueryClient`, so the hub is per connection, made on first use.
//
// - A signal for a link routes to it; one from a peer without a link waits
//   (`PENDING_MS`, at most `MAX_PENDING` peers of `MAX_PENDING_SIGNALS`
//   signals) for the app to answer with a link, and the first one is a
//   request (`onPeerRequest`).
// - A socket that leaves an app room hears `{ room, users: [] }`: the
//   links of that room end (`left`). A disconnect ends every link: a link
//   lives as long as the socket it started on.
// - The relay keeps within what `qd:hello` announces (`limits.peers`), with
//   room for what the way to the server adds: nine tenths of each rate and
//   half of each burst, per peer and for the connection's bytes, so a `rel`
//   message is dropped here, where `send` says so, rather than silently by
//   the server.
//
// React-free.

import { CLIENT_EVENTS, SERVER_EVENTS } from "../../contract/names";
import type { Failure, Ok, PeerLabel, PeerSignal } from "../../protocol/envelope";
import { isRecord } from "../../protocol/guards";
import { isPeerLabel, isRoomName, isSocketId, readSignal } from "../../protocol/peer";
import { utf8ByteLength } from "../../protocol/utf8";
import {
  MAX_PEER_LINKS,
  MAX_PEER_MESSAGE_BYTES,
  PEER_RELAY_BURST,
  PEER_RELAY_BYTES_BURST,
  PEER_RELAY_BYTES_PER_SECOND,
  PEER_RELAY_RATE,
  type HelloPeerLimits,
} from "../../protocol/version";
import type { QuickdrawConnection } from "../connection";
import { throwLater } from "./core";

/** How long signals from a peer without a link wait for the app to answer. */
export const PENDING_MS = 15_000;

/** Peers whose signals may wait at once. */
const MAX_PENDING = 64;

/** Signals one waiting peer may have. */
const MAX_PENDING_SIGNALS = 64;

/** How long a signal waits for the server's acknowledgement. */
const SIGNAL_TIMEOUT_MS = 10_000;

/** The share of each relay rate the client uses, and of each burst. */
const RATE_SHARE = 0.9;
const BURST_SHARE = 0.5;

/** The limits of a server that announces none: this version's own. */
export const DEFAULT_PEER_LIMITS: HelloPeerLimits = Object.freeze({
  maxLinks: MAX_PEER_LINKS,
  maxMessageBytes: MAX_PEER_MESSAGE_BYTES,
  relayRate: PEER_RELAY_RATE,
  relayBurst: PEER_RELAY_BURST,
  relayBytesPerSecond: PEER_RELAY_BYTES_PER_SECOND,
  relayBytesBurst: PEER_RELAY_BYTES_BURST,
});

/** How a hub reaches a link. */
export interface LinkHandle {
  /**
   * A signal from the peer, with its user as the server named it. False when
   * it opens a new link instead (the peer's last bye was lost): the link
   * ended, and the hub takes the signal as a peer without a link.
   */
  signal(sig: PeerSignal, userId: string): boolean;
  /** A relayed message from the peer. */
  relay(label: PeerLabel, text: string): void;
  /** The socket disconnected, or the connection closed. */
  disconnected(): void;
  /** The socket left the link's room. */
  left(): void;
}

/** A peer that signalled with no link: the first signal of a request. */
export interface IncomingPeer {
  readonly room: string;
  readonly from: string;
  readonly userId: string;
}

/** A token bucket. */
export interface Bucket {
  tokens: number;
  refilledAt: number;
}

/** The peer links of one connection. */
export interface PeerHub {
  readonly connection: QuickdrawConnection;
  /** Adds a link; a `TypeError` when one for the room and peer is open. Returns its removal. */
  add(room: string, peer: string, handle: LinkHandle): () => void;
  /** Takes what waits from a peer without a link: its user and signals, in order. */
  take(room: string, peer: string): IncomingPeer & { readonly signals: readonly PeerSignal[] };
  /** Drops what waits from a peer, unanswered. */
  forget(room: string, peer: string): void;
  /** Sends a signal; resolves with the server's acknowledgement, or a failure. */
  signal(room: string, to: string, sig: PeerSignal): Promise<Ok | Failure>;
  /** Sends a relay message within the limits: false when it was dropped. */
  relay(room: string, to: string, label: PeerLabel, text: string, pair: Bucket): boolean;
  /** A fresh bucket for one peer's relay messages. */
  pairBucket(): Bucket;
  /** Calls `listener` for each peer that signals with no link; returns its removal. */
  requests(listener: (incoming: IncomingPeer) => void): () => void;
  /**
   * Calls `ready` once the connection is connected with a hello: with its
   * peer limits, or `undefined` when the server serves no peer links. Calls
   * `gone` instead when the connection is closed or refused first.
   */
  whenReady(ready: (limits: HelloPeerLimits | undefined) => void, gone: () => void): void;
  /** The limits of the server's hello, or this version's own. */
  limits(): HelloPeerLimits;
}

interface Pending extends IncomingPeer {
  readonly signals: PeerSignal[];
  readonly at: number;
}

const keyOf = (room: string, peer: string): string => `${room}\u0000${peer}`;

const now = (): number => performance.now();

/** Takes `cost` tokens, refilling first; false when too few are left. */
function take(bucket: Bucket, rate: number, burst: number, cost = 1): boolean {
  const at = now();
  bucket.tokens = Math.min(burst, bucket.tokens + ((at - bucket.refilledAt) / 1000) * rate);
  bucket.refilledAt = at;
  if (bucket.tokens < cost) {
    return false;
  }
  bucket.tokens -= cost;
  return true;
}

/** The peer limits a connection's current hello announces, if it serves peer links. */
function servedLimits(connection: QuickdrawConnection): HelloPeerLimits | undefined {
  const { hello } = connection.getState();
  return hello?.features.includes("peer") === true
    ? (hello.limits.peers ?? DEFAULT_PEER_LIMITS)
    : undefined;
}

function readForward(frame: unknown): (IncomingPeer & { readonly sig: PeerSignal }) | undefined {
  if (!isRecord(frame) || !isRoomName(frame.room) || !isSocketId(frame.from)) {
    return undefined;
  }
  const sig = readSignal(frame.sig);
  const { userId } = frame;
  return sig === undefined || typeof userId !== "string" || userId === ""
    ? undefined
    : { room: frame.room, from: frame.from, userId, sig };
}

/** The state of one connection's hub. */
interface HubState {
  readonly connection: QuickdrawConnection;
  readonly links: Map<string, LinkHandle>;
  readonly pending: Map<string, Pending>;
  readonly listeners: Set<(incoming: IncomingPeer) => void>;
  readonly bytes: Bucket;
}

function receiveSignal(state: HubState, frame: unknown): void {
  const forward = readForward(frame);
  if (forward === undefined) {
    return;
  }
  const key = keyOf(forward.room, forward.from);
  const link = state.links.get(key);
  if (link?.signal(forward.sig, forward.userId) === true) {
    return;
  }
  if (forward.sig.bye === true) {
    state.pending.delete(key);
    return;
  }
  const at = now();
  for (const [old, entry] of state.pending) {
    if (at - entry.at > PENDING_MS) {
      state.pending.delete(old);
    }
  }
  const entry = state.pending.get(key);
  if (entry !== undefined) {
    if (entry.signals.length < MAX_PENDING_SIGNALS) {
      entry.signals.push(forward.sig);
    }
    return;
  }
  if (state.pending.size >= MAX_PENDING) {
    return;
  }
  const { room, from, userId } = forward;
  state.pending.set(key, { room, from, userId, signals: [forward.sig], at });
  for (const listener of [...state.listeners]) {
    try {
      listener({ room, from, userId });
    } catch (error) {
      // Reported apart: the other listeners still hear the request.
      throwLater(error);
    }
  }
}

function receiveRelay(state: HubState, frame: unknown): void {
  if (!Array.isArray(frame)) {
    return;
  }
  const [room, from, label, text] = frame as readonly unknown[];
  if (isRoomName(room) && isSocketId(from) && isPeerLabel(label) && typeof text === "string") {
    state.links.get(keyOf(room, from))?.relay(label, text);
  }
}

/** A socket that left a room hears `{ room, users: [] }`: its links there end. */
function receivePresence(state: HubState, frame: unknown): void {
  if (!isRecord(frame) || !isRoomName(frame.room)) {
    return;
  }
  const { users } = frame;
  if (!Array.isArray(users) || users.length > 0) {
    return;
  }
  const prefix = keyOf(frame.room, "");
  for (const [key, link] of [...state.links]) {
    if (key.startsWith(prefix)) {
      link.left();
    }
  }
}

function listen(state: HubState): void {
  const { socket } = state.connection;
  socket.on(SERVER_EVENTS.peer, (frame: unknown) => {
    receiveSignal(state, frame);
  });
  socket.on(SERVER_EVENTS.relay, (frame: unknown) => {
    receiveRelay(state, frame);
  });
  socket.on(SERVER_EVENTS.presence, (frame: unknown) => {
    receivePresence(state, frame);
  });
  socket.on("disconnect", () => {
    state.pending.clear();
    for (const link of [...state.links.values()]) {
      link.disconnected();
    }
  });
}

function signalOf(
  state: HubState,
  room: string,
  to: string,
  sig: PeerSignal,
): Promise<Ok | Failure> {
  const { socket } = state.connection;
  if (!socket.connected) {
    return Promise.resolve({ ok: false, e: { code: "INTERNAL", message: "Not connected" } });
  }
  return socket
    .timeout(SIGNAL_TIMEOUT_MS)
    .emitWithAck(CLIENT_EVENTS.peer, { room, to, sig })
    .catch(
      (): Failure => ({ ok: false, e: { code: "TIMEOUT", message: "No answer to a peer signal" } }),
    );
}

function relayOf(
  state: HubState,
  frame: readonly [string, string, PeerLabel, string],
  pair: Bucket,
): boolean {
  const { socket } = state.connection;
  const limits = servedLimits(state.connection);
  if (!socket.connected || limits === undefined) {
    return false;
  }
  if (!take(pair, limits.relayRate * RATE_SHARE, limits.relayBurst * BURST_SHARE)) {
    return false;
  }
  const bytes = utf8ByteLength(frame[3]);
  const budget = limits.relayBytesPerSecond * RATE_SHARE;
  if (!take(state.bytes, budget, limits.relayBytesBurst * BURST_SHARE, bytes)) {
    pair.tokens += 1;
    return false;
  }
  (frame[2] === "fast" ? socket.volatile : socket).emit(CLIENT_EVENTS.relay, frame);
  return true;
}

function whenReady(
  connection: QuickdrawConnection,
  ready: (limits: HelloPeerLimits | undefined) => void,
  gone: () => void,
): void {
  let stop: (() => void) | undefined;
  const check = (): boolean => {
    const { status, hello } = connection.getState();
    if (status === "connected" && hello !== null) {
      stop?.();
      ready(servedLimits(connection));
      return true;
    }
    if (status === "idle" || status === "disconnected" || status === "refused") {
      stop?.();
      gone();
      return true;
    }
    return false;
  };
  // A microtask later, so a listener added right after the link was made hears its first event.
  queueMicrotask(() => {
    if (!check()) {
      stop = connection.subscribe(() => {
        check();
      });
    }
  });
}

function createHub(connection: QuickdrawConnection): PeerHub {
  const state: HubState = {
    connection,
    links: new Map(),
    pending: new Map(),
    listeners: new Set(),
    bytes: { tokens: 0, refilledAt: now() },
  };
  state.bytes.tokens = DEFAULT_PEER_LIMITS.relayBytesBurst * BURST_SHARE;
  listen(state);
  const hub: PeerHub = {
    connection,
    add(room: string, peer: string, handle: LinkHandle): () => void {
      const key = keyOf(room, peer);
      if (state.links.has(key)) {
        throw new TypeError(
          `createPeerLink: this connection has a link to ${peer} in room "${room}" already; close it first`,
        );
      }
      state.links.set(key, handle);
      return () => {
        if (state.links.get(key) === handle) {
          state.links.delete(key);
        }
      };
    },
    take(room: string, peer: string) {
      const key = keyOf(room, peer);
      const entry = state.pending.get(key);
      state.pending.delete(key);
      const fresh = entry !== undefined && now() - entry.at <= PENDING_MS;
      return {
        room,
        from: peer,
        userId: entry?.userId ?? "",
        signals: fresh ? entry.signals : [],
      };
    },
    forget(room: string, peer: string): void {
      state.pending.delete(keyOf(room, peer));
    },
    signal: (room, to, sig) => signalOf(state, room, to, sig),
    relay: (room, to, label, text, pair) => relayOf(state, [room, to, label, text], pair),
    pairBucket: () => ({
      tokens: (servedLimits(connection) ?? DEFAULT_PEER_LIMITS).relayBurst * BURST_SHARE,
      refilledAt: now(),
    }),
    requests(listener: (incoming: IncomingPeer) => void): () => void {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    whenReady: (ready, gone) => {
      whenReady(connection, ready, gone);
    },
    limits: () => servedLimits(connection) ?? DEFAULT_PEER_LIMITS,
  };
  return Object.freeze(hub);
}

const hubs = new WeakMap<QuickdrawConnection, PeerHub>();

/** The peer links of `connection`, made on first use. */
export function hubOf(connection: QuickdrawConnection): PeerHub {
  let hub = hubs.get(connection);
  if (hub === undefined) {
    hub = createHub(connection);
    hubs.set(connection, hub);
  }
  return hub;
}
