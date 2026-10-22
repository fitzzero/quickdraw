// What a room's host does with its peers' messages (host mode, RFC 0003
// section 12.5), apart from how they reach it: `host.ts` attaches a peer per
// link (and the host's own client, in process), and this checks each
// message the way the server checks `qd:ch` and `qd:stream:sub`, and fans
// pushed items out.
//
// - `[3, service, channel, payload]`: a host-served channel of the contract,
//   within the peer's bucket for it (`ratePerSecond`, `burst`), its payload
//   valid for the channel's schema (synchronously: a schema that validates
//   asynchronously drops every message, reported once), for this host's
//   room by the channel's `requires: { room }`. Then the handler runs with
//   `{ peer, room }`. A peer whose drops for one channel within 10 s pass
//   100 times its rate loses its link, as a socket is disconnected.
// - `[4, service, stream, scope]`: a host-served stream whose room for the
//   scope is this host's room; the answer is the seed (`[6]`, in chunks
//   that each fit the message limit): the implementation's `seed(scope)`,
//   or the latest `seed` items pushed. A peer holds at most 500 feeds.
//   Anything else is refused (`[8]`).
// - `[5, service, stream, scope]` leaves the feed.
//
// `push(stream, scope, item)` checks the item against the stream's schema,
// keeps it for the seed, and sends it to the feed's peers (`[7]`) on `fast`
// for a volatile stream, else `rel`.
//
// React-free.

import type { AnyContract } from "../../contract/defineContract";
import { CHANNEL_DEFAULT_RATE, isHostServed, type StreamDef } from "../../contract/realtime";
import { validateNow } from "../../contract/validateNow";
import type { HostMessage, PeerLabel } from "../../protocol/envelope";
import type { ErrorCode } from "../../protocol/errors";
import { encodeMessage, messageBytes } from "../peer/codec";
import { throwLater } from "../peer/core";
import { channelRoomOf, streamRoomOf } from "./rooms";

/** A peer of a host: its socket and its user, as the server named them. */
export interface HostPeer {
  readonly socketId: string;
  readonly userId: string;
}

/** What a host-served channel's handler receives beside the payload. */
export interface HostChannelContext {
  /** Who sent it: the user the server named for the peer's socket. */
  readonly peer: HostPeer;
  /** The host's room. */
  readonly room: string;
}

/** The handlers and options of a host, by member, whatever their declared types. */
export interface AnyHostImplementation {
  readonly channels?: Readonly<Record<string, (payload: unknown, ctx: HostChannelContext) => void>>;
  readonly streams?: Readonly<
    Record<string, { readonly seed?: (scope: string) => readonly unknown[] } | undefined>
  >;
}

/** Sends a host mode message to one peer; false when it was dropped. */
export type HostSend = (label: PeerLabel, message: HostMessage) => boolean;

/** One peer, attached: what it sends, and its end. */
export interface AttachedPeer {
  receive(message: HostMessage): void;
  detach(): void;
}

/** One room's host, whatever carries its peers' messages. */
export interface HostRuntime {
  /** Attaches a peer; `close` ends its link (a flood). */
  attach(peer: HostPeer, send: HostSend, close: () => void): AttachedPeer;
  readonly peers: readonly HostPeer[];
  push(stream: string, scope: string, item: unknown): void;
  close(): void;
}

/** A host-served channel's drops within this long are counted toward a flood. */
const ABUSE_WINDOW_MS = 10_000;

/** A peer whose drops within the window pass this many times the channel's rate loses its link. */
const ABUSE_MULTIPLIER = 100;

/** The feeds one peer may hold. */
const MAX_FEEDS = 500;

/** The scopes whose latest items a stream keeps. */
const MAX_KEPT_SCOPES = 10_000;

interface Bucket {
  tokens: number;
  refilledAt: number;
  windowStart: number;
  dropped: number;
}

interface PeerState {
  readonly peer: HostPeer;
  readonly send: HostSend;
  readonly close: () => void;
  readonly buckets: Map<string, Bucket>;
  readonly feeds: Set<string>;
}

interface State {
  readonly contract: AnyContract;
  readonly implementation: AnyHostImplementation;
  readonly room: string;
  readonly maxBytes: () => number;
  readonly peers: Set<PeerState>;
  /** The peers of each feed, by `feedKey`. */
  readonly feeds: Map<string, Set<PeerState>>;
  /** The latest items of each stream's scopes, for a seed. */
  readonly kept: Map<string, Map<string, unknown[]>>;
  readonly warned: Set<string>;
  closed: boolean;
}

const feedKey = (stream: string, scope: string): string => `${stream}\u0000${scope}`;

function own<T>(record: Readonly<Record<string, T>>, name: string): T | undefined {
  return Object.hasOwn(record, name) ? record[name] : undefined;
}

/** Takes a token, refilling first; on a drop, true once the peer floods. */
function overRate(bucket: Bucket, rate: number, burst: number, now: number): boolean | undefined {
  bucket.tokens = Math.min(burst, bucket.tokens + ((now - bucket.refilledAt) / 1000) * rate);
  bucket.refilledAt = now;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    return undefined;
  }
  if (now - bucket.windowStart > ABUSE_WINDOW_MS) {
    bucket.windowStart = now;
    bucket.dropped = 0;
  }
  bucket.dropped += 1;
  return bucket.dropped > rate * ABUSE_MULTIPLIER;
}

function onChannel(state: State, from: PeerState, name: string, payload: unknown): void {
  const def = own(state.contract.channels, name);
  const handler = own(state.implementation.channels ?? {}, name);
  if (def === undefined || !isHostServed(def) || handler === undefined) {
    return;
  }
  const rate = def.ratePerSecond ?? CHANNEL_DEFAULT_RATE;
  const burst = def.burst ?? Math.max(1, rate * 2);
  const now = Date.now();
  let bucket = from.buckets.get(name);
  if (bucket === undefined) {
    bucket = { tokens: burst, refilledAt: now, windowStart: now, dropped: 0 };
    from.buckets.set(name, bucket);
  }
  const dropped = overRate(bucket, rate, burst, now);
  if (dropped !== undefined) {
    if (dropped) {
      from.close();
    }
    return;
  }
  const parsed = validateNow(def.payload, payload);
  if (parsed === "async") {
    if (!state.warned.has(name)) {
      state.warned.add(name);
      throwLater(
        new TypeError(
          `Host of ${state.room}: channel ${state.contract.name}.${name} has a payload schema that validates asynchronously; its messages are dropped, since a host checks them synchronously`,
        ),
      );
    }
    return;
  }
  if (
    parsed.issues !== undefined ||
    channelRoomOf(def, parsed.value, [state.room]) !== state.room
  ) {
    return;
  }
  try {
    handler(parsed.value, { peer: from.peer, room: state.room });
  } catch (error) {
    throwLater(error);
  }
}

/** The seed of a feed: the implementation's, checked against the item schema, or the latest items pushed. */
function seedOf(state: State, name: string, def: StreamDef, scope: string): readonly unknown[] {
  const seed = own(state.implementation.streams ?? {}, name)?.seed;
  if (seed === undefined) {
    return state.kept.get(name)?.get(scope) ?? [];
  }
  return seed(scope).map((item) => {
    const checked = validateNow(def.item, item);
    if (checked === "async" || checked.issues !== undefined) {
      throw new TypeError(
        `Host of ${state.room}: the seed of ${state.contract.name}.${name} holds an item its schema refuses`,
      );
    }
    return checked.value;
  });
}

/** Sends a seed in chunks that each fit the message limit; `last` on the final one. */
function sendSeed(
  state: State,
  to: PeerState,
  name: string,
  scope: string,
  items: readonly unknown[],
): void {
  const service = state.contract.name;
  const max = state.maxBytes();
  const overhead = messageBytes(encodeMessage([6, service, name, scope, [], false]));
  let chunk: unknown[] = [];
  let size = overhead;
  for (const item of items) {
    const bytes = messageBytes(JSON.stringify(item) ?? "null") + 1;
    if (chunk.length > 0 && size + bytes > max) {
      to.send("rel", [6, service, name, scope, chunk, false]);
      chunk = [];
      size = overhead;
    }
    chunk.push(item);
    size += bytes;
  }
  to.send("rel", [6, service, name, scope, chunk, true]);
}

function onSubscribe(state: State, from: PeerState, name: string, scope: string): void {
  const service = state.contract.name;
  const refuse = (code: ErrorCode, message: string): void => {
    from.send("rel", [8, service, name, scope, { code, message }]);
  };
  const def = own(state.contract.streams, name);
  if (def === undefined || !isHostServed(def)) {
    refuse("NOT_FOUND", `${service} has no host-served stream "${name}"`);
    return;
  }
  if (streamRoomOf(def, scope) !== state.room) {
    refuse("FORBIDDEN", `The feed of scope "${scope}" is served by the host of another room`);
    return;
  }
  const key = feedKey(name, scope);
  if (!from.feeds.has(key) && from.feeds.size >= MAX_FEEDS) {
    refuse("CONFLICT", `A peer may hold at most ${MAX_FEEDS} feeds of a host`);
    return;
  }
  let items: readonly unknown[];
  try {
    items = seedOf(state, name, def, scope);
  } catch (error) {
    refuse("INTERNAL", "The host could not make the feed's seed");
    throwLater(error);
    return;
  }
  from.feeds.add(key);
  const subscribers = state.feeds.get(key) ?? new Set<PeerState>();
  state.feeds.set(key, subscribers);
  subscribers.add(from);
  sendSeed(state, from, name, scope, items);
}

function leave(state: State, from: PeerState, key: string): void {
  from.feeds.delete(key);
  const subscribers = state.feeds.get(key);
  subscribers?.delete(from);
  if (subscribers?.size === 0) {
    state.feeds.delete(key);
  }
}

function receive(state: State, from: PeerState, message: HostMessage): void {
  if (state.closed || !state.peers.has(from) || message[1] !== state.contract.name) {
    return;
  }
  if (message[0] === 3) {
    onChannel(state, from, message[2], message[3]);
  } else if (message[0] === 4) {
    onSubscribe(state, from, message[2], message[3]);
  } else if (message[0] === 5) {
    leave(state, from, feedKey(message[2], message[3]));
  }
}

/** Keeps the latest items of a scope for a seed: the contract's `seed` of them. */
function keep(state: State, name: string, keepCount: number, scope: string, item: unknown): void {
  const scopes = state.kept.get(name) ?? new Map<string, unknown[]>();
  state.kept.set(name, scopes);
  const items = scopes.get(scope) ?? [];
  scopes.delete(scope);
  scopes.set(scope, [...items, item].slice(-keepCount));
  if (scopes.size > MAX_KEPT_SCOPES) {
    const [oldest] = scopes.keys();
    if (oldest !== undefined) {
      scopes.delete(oldest);
    }
  }
}

function push(state: State, name: string, scope: string, item: unknown): void {
  const service = state.contract.name;
  const def = own(state.contract.streams, name);
  if (def === undefined || !isHostServed(def)) {
    throw new TypeError(`host.stream: ${service} has no host-served stream "${name}"`);
  }
  if (typeof scope !== "string" || scope === "") {
    throw new TypeError(`host.stream("${name}").push: pass (scope, item), the scope a string`);
  }
  const checked = validateNow(def.item, item);
  if (checked === "async" || checked.issues !== undefined) {
    throw new TypeError(
      `host.stream("${name}").push: the item does not match the stream's schema${checked === "async" ? " (it validates asynchronously)" : ""}`,
    );
  }
  const message: HostMessage = [7, service, name, scope, checked.value];
  const bytes = messageBytes(encodeMessage(message));
  if (bytes > state.maxBytes()) {
    throw new RangeError(
      `host.stream("${name}").push: an item holds at most ${state.maxBytes()} bytes as JSON with its message; this one has ${bytes}`,
    );
  }
  const keepCount =
    own(state.implementation.streams ?? {}, name)?.seed === undefined ? (def.seed ?? 0) : 0;
  if (keepCount > 0) {
    keep(state, name, keepCount, scope, checked.value);
  }
  const label = def.volatile === true ? "fast" : "rel";
  for (const to of state.feeds.get(feedKey(name, scope)) ?? []) {
    to.send(label, message);
  }
}

/** Creates the host of `room` for `contract`'s host-served members; `maxBytes` is the message limit. */
export function createHostRuntime(
  contract: AnyContract,
  implementation: AnyHostImplementation,
  room: string,
  maxBytes: () => number,
): HostRuntime {
  const state: State = {
    contract,
    implementation,
    room,
    maxBytes,
    peers: new Set(),
    feeds: new Map(),
    kept: new Map(),
    warned: new Set(),
    closed: false,
  };
  return Object.freeze({
    attach(peer: HostPeer, send: HostSend, close: () => void): AttachedPeer {
      const from: PeerState = { peer, send, close, buckets: new Map(), feeds: new Set() };
      state.peers.add(from);
      return {
        receive: (message: HostMessage) => {
          receive(state, from, message);
        },
        detach: () => {
          for (const key of [...from.feeds]) {
            leave(state, from, key);
          }
          state.peers.delete(from);
        },
      };
    },
    get peers(): readonly HostPeer[] {
      return [...state.peers].map(({ peer }) => peer);
    },
    push: (stream: string, scope: string, item: unknown) => {
      push(state, stream, scope, item);
    },
    close(): void {
      state.closed = true;
      state.peers.clear();
      state.feeds.clear();
    },
  });
}
