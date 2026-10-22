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
//   `{ peer, room }`. A peer whose drops for one channel within
//   `ABUSE_WINDOW_MS` pass `ABUSE_MULTIPLIER` times its rate loses its link,
//   as a socket is disconnected.
// - `[4, service, stream, scope]`: a host-served stream whose room for the
//   scope is this host's room; the answer is the seed (`[6]`, in chunks
//   that each fit the message limit): the implementation's `seed(scope)`,
//   or the latest `seed` items pushed. A peer holds at most `MAX_HOST_FEEDS`
//   feeds, and subscribes at most `HOST_SUBSCRIBE_RATE` times a second after
//   a burst of as many (`RATE_LIMITED`; a flood of them, as for a channel,
//   ends its link), its subscribes to a service none of the room's runtimes
//   serves included (`unserved`, which `serving.ts` calls). A seed whose
//   items do not each fit a message alone is refused (`INTERNAL`), never
//   sent in part. Anything else is refused (`[8]`).
// - `[5, service, stream, scope]` leaves the feed.
//
// `push(stream, scope, item)` checks the item against the stream's schema
// and the message limit (as a seed chunk of its own, so a kept item can
// always seed), keeps it for the seed, and sends it to the feed's peers
// (`[7]`) on `fast` for a volatile stream, else `rel`. What goes on `rel`
// keeps its order and is sent again when the link drops it (`outbox.ts`).
//
// React-free.

import type { AnyContract } from "../../contract/defineContract";
import { CHANNEL_DEFAULT_RATE, isHostServed, type StreamDef } from "../../contract/realtime";
import { validateNow } from "../../contract/validateNow";
import type { HostMessage, HostSubscribe } from "../../protocol/envelope";
import type { ErrorCode } from "../../protocol/errors";
import { encodeMessage, messageBytes } from "../peer/codec";
import { throwLater } from "../peer/core";
import { createOutbox, type HostSend, type Outbox } from "./outbox";
import { channelRoomOf, streamRoomOf } from "./rooms";

export type { HostSend } from "./outbox";

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

/** One peer, attached: what it sends, and its end. */
export interface AttachedPeer {
  receive(message: HostMessage): void;
  detach(): void;
}

/** A peer as one runtime holds it: it also refuses for the room's other services. */
export interface RuntimePeer extends AttachedPeer {
  /**
   * Refuses a subscribe to a service no runtime of the room serves
   * (`NOT_FOUND`), within the peer's subscribe bucket and through its way out.
   */
  unserved(message: HostSubscribe): void;
}

/** One room's host, whatever carries its peers' messages. */
export interface HostRuntime {
  /** Attaches a peer; `close` ends its link (a flood). */
  attach(peer: HostPeer, send: HostSend, close: () => void): RuntimePeer;
  readonly peers: readonly HostPeer[];
  push(stream: string, scope: string, item: unknown): void;
  close(): void;
}

/**
 * A host-served channel's drops within this long are counted toward a
 * flood: the server's `CHANNEL_ABUSE_WINDOW_MS`.
 */
export const ABUSE_WINDOW_MS = 10_000;

/**
 * A peer whose drops within the window pass this many times the channel's
 * rate loses its link: the server's `CHANNEL_ABUSE_MULTIPLIER`.
 */
export const ABUSE_MULTIPLIER = 100;

/** The feeds one peer may hold of a host, and the subscribes it may send it at once. */
export const MAX_HOST_FEEDS = 500;

/** The subscribes a second a peer may send a host after a burst of `MAX_HOST_FEEDS`. */
export const HOST_SUBSCRIBE_RATE = 50;

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
  readonly out: Outbox;
  readonly close: () => void;
  readonly buckets: Map<string, Bucket>;
  /** Its subscribes' bucket. */
  readonly subscribes: Bucket;
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

/** The bytes `item` takes in a seed chunk of its own: what every item must fit. */
function aloneBytes(state: State, name: string, scope: string, item: unknown): number {
  return messageBytes(encodeMessage([6, state.contract.name, name, scope, [item], false]));
}

/** A seed's chunks, each within the message limit; `undefined` when an item fits none alone. */
function chunksOf(
  state: State,
  name: string,
  scope: string,
  items: readonly unknown[],
): unknown[][] | undefined {
  const max = state.maxBytes();
  const overhead = messageBytes(encodeMessage([6, state.contract.name, name, scope, [], false]));
  const chunks: unknown[][] = [[]];
  let size = overhead;
  for (const item of items) {
    // The first item of a chunk takes no comma, as `push` measures it alone.
    const bytes = messageBytes(JSON.stringify(item) ?? "null");
    if (overhead + bytes > max) {
      return undefined;
    }
    const chunk = chunks.at(-1) ?? [];
    if (chunk.length === 0) {
      chunk.push(item);
      size += bytes;
    } else if (size + 1 + bytes > max) {
      chunks.push([item]);
      size = overhead + bytes;
    } else {
      chunk.push(item);
      size += 1 + bytes;
    }
  }
  return chunks;
}

type Refuse = (code: ErrorCode, message: string) => void;

/** Refuses the peer's subscribe to `service`'s `name` for `scope`, through its way out. */
function refusal(from: PeerState, service: string, name: string, scope: string): Refuse {
  return (code, message) => {
    from.out.send("rel", [8, service, name, scope, { code, message }]);
  };
}

/**
 * Takes one of the peer's subscribe tokens: true when it had one. Past them
 * the subscribe is refused (`RATE_LIMITED`), and a flood of them ends the
 * peer's link.
 */
function admits(from: PeerState, refuse: Refuse): boolean {
  const flood = overRate(from.subscribes, HOST_SUBSCRIBE_RATE, MAX_HOST_FEEDS, Date.now());
  if (flood === undefined) {
    return true;
  }
  if (flood) {
    from.close();
  } else {
    refuse("RATE_LIMITED", `A peer subscribes at most ${HOST_SUBSCRIBE_RATE} times a second`);
  }
  return false;
}

/** A subscribe to a service no runtime of the room serves: refused, within the peer's bucket. */
function onUnserved(state: State, from: PeerState, message: HostSubscribe): void {
  const [, service, name, scope] = message;
  const refuse = refusal(from, service, name, scope);
  if (!state.closed && state.peers.has(from) && admits(from, refuse)) {
    refuse("NOT_FOUND", `The host of ${state.room} serves no service "${service}"`);
  }
}

function onSubscribe(state: State, from: PeerState, name: string, scope: string): void {
  const service = state.contract.name;
  const refuse = refusal(from, service, name, scope);
  if (!admits(from, refuse)) {
    return;
  }
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
  if (!from.feeds.has(key) && from.feeds.size >= MAX_HOST_FEEDS) {
    refuse("CONFLICT", `A peer may hold at most ${MAX_HOST_FEEDS} feeds of a host`);
    return;
  }
  let chunks: unknown[][] | undefined;
  try {
    chunks = chunksOf(state, name, scope, seedOf(state, name, def, scope));
  } catch (error) {
    refuse("INTERNAL", "The host could not make the feed's seed");
    throwLater(error);
    return;
  }
  if (chunks === undefined) {
    refuse("INTERNAL", "The feed's seed holds an item over the message limit");
    throwLater(
      new RangeError(
        `Host of ${state.room}: the seed of ${service}.${name} holds an item over ${state.maxBytes()} bytes with its message; keep each item smaller`,
      ),
    );
    return;
  }
  from.feeds.add(key);
  const subscribers = state.feeds.get(key) ?? new Set<PeerState>();
  state.feeds.set(key, subscribers);
  subscribers.add(from);
  chunks.forEach((chunk, index) => {
    from.out.send("rel", [6, service, name, scope, chunk, index === chunks.length - 1]);
  });
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
  // Within a seed chunk of its own too, so that a kept item always seeds.
  const bytes = aloneBytes(state, name, scope, checked.value);
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
    to.out.send(label, message);
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
    attach(peer: HostPeer, send: HostSend, close: () => void): RuntimePeer {
      const now = Date.now();
      const from: PeerState = {
        peer,
        out: createOutbox(send, close),
        close,
        buckets: new Map(),
        subscribes: { tokens: MAX_HOST_FEEDS, refilledAt: now, windowStart: now, dropped: 0 },
        feeds: new Set(),
      };
      state.peers.add(from);
      return {
        receive: (message: HostMessage) => {
          receive(state, from, message);
        },
        unserved: (message: HostSubscribe) => {
          onUnserved(state, from, message);
        },
        detach: () => {
          for (const key of [...from.feeds]) {
            leave(state, from, key);
          }
          from.out.clear();
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
      for (const from of state.peers) {
        from.out.clear();
      }
      state.peers.clear();
      state.feeds.clear();
    },
  });
}
