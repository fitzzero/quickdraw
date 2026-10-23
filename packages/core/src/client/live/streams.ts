// The streams one connection holds (RFC 0003 section 12.5): one feed per
// stream and scope, counted by the hooks that hold it (`registry.ts`), with
// `qd:stream [service, stream, scope, item]` frames routed to it by their
// service, stream and scope (`null` for a global stream).
//
// - Holding a feed sends `qd:stream:sub` through the connection's lane
//   (`../lane.ts`), once the server's hello names the user (`host.ts`). The
//   answer's seed (the latest items the server kept, or what the service
//   computed for this subscriber) becomes the feed's
//   items, and every frame after it is appended, oldest first, keeping at
//   most the largest `max` any holder asked for.
// - The server joins the feed's room and reads its seed in one tick, so an
//   item pushed after the seed can arrive before the answer: frames that
//   arrive while a subscribe is unanswered are kept and appended after the
//   seed. A seed the server computes asynchronously may also hold such an
//   item, which then shows twice.
// - Every connect subscribes again, and the seed then replaces what is held:
//   the server forgot the socket's feeds, and nothing says which items were
//   missed meanwhile. Another user on the connection drops every feed's items
//   first. A refusal (`FORBIDDEN`, ...) empties the feed and stands until the
//   next connect; `RATE_LIMITED` waits out the backoff and asks again. A
//   `qd:revoked { kind: "stream" }` (access lowered while subscribed) does
//   the same as a `FORBIDDEN` refusal: the server took the socket out of the
//   feed's room.
// - The last holder's release unsubscribes a tick later (`qd:stream:unsub`),
//   unless the feed is held again first.
// - A host-served stream (`serve: "host"`) is not the server's: its feed
//   subscribes over the way to the host of the scope's room
//   (`../host/links.ts`), with the same rules (the seed replaces what is
//   held, items append, a refusal empties it, `RATE_LIMITED` asks again a
//   little later, `HOST_RETRY_MS` and up to half again, still loading, and
//   a scope the server would refuse is refused here, `VALIDATION`), and
//   again whenever a way to the room's host opens; a connect does not
//   subscribe it.
//
// React-free: the live data (`liveData.ts`) makes one per connection and
// `QueryClient`.

import { CLIENT_EVENTS } from "../../contract/names";
import { QuickdrawError } from "../../protocol/errors";
import { isName } from "../../protocol/guards";
import { MAX_SCOPE_LENGTH } from "../../protocol/version";
import { hostLinksOf } from "../host/links";
import { notifyEach } from "../watch";
import { request, type LiveHost } from "./host";
import { createRegistry, type Registry } from "./registry";

/** The most items a feed keeps, whatever `max` asks for. */
export const STREAM_MAX_ITEMS = 10_000;

/** How many items a feed keeps when its holders ask for no `max`. */
export const STREAM_DEFAULT_MAX = 500;

/** A hook's `max` option as a whole number from 1 to `STREAM_MAX_ITEMS`; `STREAM_DEFAULT_MAX` when absent. */
export function streamMaxOf(max: number | undefined): number {
  if (typeof max !== "number" || !Number.isFinite(max)) {
    return STREAM_DEFAULT_MAX;
  }
  return Math.min(Math.max(1, Math.floor(max)), STREAM_MAX_ITEMS);
}

/** One stream of a service, as its member and the store see it. */
export interface StreamTarget {
  readonly service: string;
  readonly stream: string;
  /** True for a stream with one feed per scope value; false for a global stream. */
  readonly scoped: boolean;
  /** A host-served stream's room of each scope, whose host serves the feed; absent for the server's. */
  readonly host?: (scope: string) => string | undefined;
}

/** What a feed shows: its items, oldest first, whether its seed is still to come, and why it failed. */
export interface StreamState<Item = unknown> {
  readonly items: readonly Item[];
  /** True until the first answer to the feed's subscribe. */
  readonly isLoading: boolean;
  /** Why the subscribe was refused: `FORBIDDEN` for a feed the user may not read. */
  readonly error: QuickdrawError | null;
}

/** The state of a feed nobody holds yet. */
export const PENDING_STREAM: StreamState = Object.freeze({
  items: Object.freeze([]),
  isLoading: true,
  error: null,
});

/** The streams of one connection. */
export interface StreamStore {
  /**
   * Holds a feed, keeping at least `max` items, for one user of it. Returns
   * the release; the feed is unsubscribed a tick after its last release.
   */
  hold(target: StreamTarget, scope: string | undefined, max: number): () => void;
  /** The feed's state: `PENDING_STREAM` while nobody holds it. The same object until it changes. */
  state(key: string): StreamState;
  /** Calls `listener` whenever the feed of `key` changes; returns the unsubscribe function. */
  listen(key: string, listener: () => void): () => void;
  /** A `qd:stream` frame arrived. */
  receive(frame: unknown): void;
  /**
   * The server ended the subscription to a feed (`qd:revoked`): its access
   * was lowered. The feed empties and shows `FORBIDDEN`, takes no further
   * item, and stands until the next connect subscribes again.
   */
  revoked(service: string, stream: string, scope: string | undefined): void;
  /** Subscribes every held feed again: the socket connected, or the user is known. */
  resume(): void;
  /** Another user acts on the connection now: drops every feed's items and subscribes again. */
  forget(): void;
  /** The connection closed: stops every retry until the next connect. */
  stop(): void;
}

/** The key of one feed: a stream's, or one scope's of a scoped stream. */
export function feedKey(service: string, stream: string, scope: string | undefined): string {
  return `${service}\u0000${stream}\u0000${scope === undefined ? "\u0001" : `\u0002${scope}`}`;
}

interface Feed {
  readonly key: string;
  readonly frame: { readonly s: string; readonly stream: string; readonly scope?: string };
  state: StreamState;
  /** The `max` of each holding. */
  readonly maxes: Map<object, number>;
  /** Items that arrived while a subscribe was unanswered; `undefined` otherwise. */
  pending: unknown[] | undefined;
  /** True once a subscribe was sent: the server may hold the socket in the feed's room. */
  sent: boolean;
  /** Raised by every subscribe and by `forget`, so an older answer is ignored. */
  attempt: number;
  retry: ReturnType<typeof setTimeout> | undefined;
  /** True for a host-served stream's feed, held over the way to its room's host. */
  readonly hosted: boolean;
  /** That room: the one the contract computes from the scope; `undefined` when it names none. */
  readonly room: string | undefined;
  /** Leaves the host's feed. */
  release: (() => void) | undefined;
}

function capOf(feed: Feed): number {
  return Math.min(Math.max(STREAM_DEFAULT_MAX, ...feed.maxes.values()), STREAM_MAX_ITEMS);
}

function latest(items: readonly unknown[], cap: number): readonly unknown[] {
  return items.length > cap ? items.slice(items.length - cap) : items;
}

/**
 * A `qd:stream` frame read from the network: `[service, stream, scope,
 * item]`, `scope` null for a global stream; elements after `item` are a
 * later protocol's and ignored. `undefined` for anything else.
 */
function readStreamFrame(value: unknown):
  | {
      readonly s: string;
      readonly stream: string;
      readonly scope: string | undefined;
      readonly item: unknown;
    }
  | undefined {
  if (!Array.isArray(value) || value.length < 4) {
    return undefined;
  }
  const [s, stream, scope, item] = value as readonly unknown[];
  if (!isName(s) || !isName(stream) || !(scope === null || isName(scope))) {
    return undefined;
  }
  return { s, stream, scope: scope ?? undefined, item };
}

/** What the feeds of one connection share. */
interface Feeds {
  readonly host: LiveHost;
  readonly registry: Registry<Feed>;
  /** Per feed key, the hooks to tell when it changes; kept apart from the feeds, which come and go. */
  readonly listeners: Map<string, Set<() => void>>;
}

function setState(feeds: Feeds, feed: Feed, state: StreamState): void {
  feed.state = state;
  notifyEach(feeds.listeners.get(feed.key) ?? [], (listener) => {
    listener();
  });
}

/** The subscribe was answered: the seed, then what arrived meanwhile. */
function answered(feeds: Feeds, feed: Feed, reply: Readonly<Record<string, unknown>>): void {
  const seed = Array.isArray(reply.seed) ? (reply.seed as readonly unknown[]) : [];
  const items = latest([...seed, ...(feed.pending ?? [])], capOf(feed));
  feed.pending = undefined;
  setState(feeds, feed, Object.freeze({ items, isLoading: false, error: null }));
}

/**
 * A host-served feed the host refused `RATE_LIMITED` asks again after this
 * long and up to half again, at random, so the feeds it refused at once do
 * not all ask again at once.
 */
export const HOST_RETRY_MS = 1000;

/** Holds a host-served feed over the way to its room's host, and settles it by what the host sends. */
function subscribeHost(feeds: Feeds, feed: Feed): void {
  clearTimeout(feed.retry);
  feed.retry = undefined;
  feed.release?.();
  feed.release = undefined;
  feed.attempt += 1;
  const { attempt } = feed;
  const current = (): boolean => feed.attempt === attempt && feeds.registry.get(feed.key) === feed;
  const { s: service, stream } = feed.frame;
  const scope = feed.frame.scope ?? "";
  const refused = (error: QuickdrawError): void => {
    feed.pending = undefined;
    setState(feeds, feed, Object.freeze({ items: [], isLoading: false, error }));
  };
  if (!isName(scope) || scope.length > MAX_SCOPE_LENGTH) {
    refused(
      new QuickdrawError(
        "VALIDATION",
        `${service}.${stream} is scoped: its scope is a string of 1 to ${MAX_SCOPE_LENGTH} characters`,
      ),
    );
    return;
  }
  if (feed.room === undefined) {
    refused(
      new QuickdrawError(
        "NOT_FOUND",
        `No app room serves scope "${scope}" of ${service}.${stream}`,
      ),
    );
    return;
  }
  feed.pending = [];
  feed.release = hostLinksOf(feeds.host.connection).subscribe(feed.room, {
    service,
    stream,
    scope,
    seeded: (items) => {
      if (current()) {
        answered(feeds, feed, { seed: items });
      }
    },
    item: (item) => {
      if (current()) {
        receive(feeds, [service, stream, scope, item]);
      }
    },
    refused: (error) => {
      if (!current()) {
        return;
      }
      if (error.code === "RATE_LIMITED") {
        feed.retry = setTimeout(
          () => {
            subscribeHost(feeds, feed);
          },
          HOST_RETRY_MS * (1 + Math.random() / 2),
        );
      } else {
        refused(new QuickdrawError(error.code, error.message));
      }
    },
    lost: () => {
      if (current()) {
        feed.pending = [];
      }
    },
  });
}

/** Sends `qd:stream:sub` for `feed` through the connection's lane, and settles the feed by its answer. */
function subscribe(feeds: Feeds, feed: Feed): void {
  if (feed.hosted) {
    subscribeHost(feeds, feed);
    return;
  }
  const { host } = feeds;
  clearTimeout(feed.retry);
  feed.retry = undefined;
  feed.attempt += 1;
  const { attempt } = feed;
  feed.pending = [];
  request(host, CLIENT_EVENTS.streamSub, feed.frame, (outcome) => {
    if (feed.attempt !== attempt || feeds.registry.get(feed.key) !== feed) {
      return;
    }
    if (outcome.kind === "ok") {
      answered(feeds, feed, outcome.reply);
    } else if (outcome.kind === "refused") {
      feed.pending = undefined;
      setState(feeds, feed, Object.freeze({ items: [], isLoading: false, error: outcome.error }));
    } else if (outcome.kind === "retry") {
      feed.retry = setTimeout(() => {
        subscribe(feeds, feed);
      }, outcome.delayMs);
    } else {
      // Offline: the next connect, or the hello, subscribes again.
      feed.pending = undefined;
    }
  });
  feed.sent ||= host.connection.getState().hello !== null && host.connection.socket.connected;
}

/** The feed's last holder let go a tick ago: unsubscribe, unless it was never sent. */
function closeFeed(feeds: Feeds, feed: Feed): void {
  const { socket } = feeds.host.connection;
  clearTimeout(feed.retry);
  feed.attempt += 1;
  if (feed.hosted) {
    feed.release?.();
    feed.release = undefined;
    setState(feeds, feed, PENDING_STREAM);
    return;
  }
  if (feed.sent && socket.connected) {
    socket.emit(CLIENT_EVENTS.streamUnsub, feed.frame);
  }
  setState(feeds, feed, PENDING_STREAM);
}

function openFeed(target: StreamTarget, scope: string | undefined, key: string): Feed {
  const { host } = target;
  const frame =
    scope === undefined
      ? { s: target.service, stream: target.stream }
      : { s: target.service, stream: target.stream, scope };
  return {
    key,
    frame: Object.freeze(frame),
    state: PENDING_STREAM,
    maxes: new Map(),
    pending: undefined,
    sent: false,
    attempt: 0,
    retry: undefined,
    hosted: host !== undefined,
    room: host?.(scope ?? ""),
    release: undefined,
  };
}

function hold(
  feeds: Feeds,
  target: StreamTarget,
  scope: string | undefined,
  max: number,
): () => void {
  const key = feedKey(target.service, target.stream, scope);
  const holding = feeds.registry.acquire(key, () => openFeed(target, scope, key));
  const feed = holding.entry;
  const token = {};
  feed.maxes.set(token, max);
  if (holding.isNew) {
    subscribe(feeds, feed);
  }
  return () => {
    feed.maxes.delete(token);
    holding.release();
  };
}

/** A `qd:stream` frame: appended to its feed, or kept until the feed's seed arrives. */
function receive(feeds: Feeds, value: unknown): void {
  const frame = readStreamFrame(value);
  if (frame === undefined) {
    return;
  }
  const feed = feeds.registry.get(feedKey(frame.s, frame.stream, frame.scope));
  if (feed === undefined) {
    return;
  }
  if (feed.pending !== undefined) {
    feed.pending = [...latest(feed.pending, capOf(feed) - 1), frame.item];
    return;
  }
  if (!feed.state.isLoading && feed.state.error === null) {
    const items = latest([...feed.state.items, frame.item], capOf(feed));
    setState(feeds, feed, Object.freeze({ ...feed.state, items }));
  }
}

/** The server revoked the feed's subscription: its socket left the room. */
function revoked(feeds: Feeds, key: string): void {
  const feed = feeds.registry.get(key);
  if (feed === undefined) {
    return;
  }
  clearTimeout(feed.retry);
  feed.retry = undefined;
  feed.attempt += 1;
  feed.pending = undefined;
  feed.sent = false;
  const error = new QuickdrawError("FORBIDDEN", "Access to the stream was revoked");
  setState(feeds, feed, Object.freeze({ items: [], isLoading: false, error }));
}

function listen(feeds: Feeds, key: string, listener: () => void): () => void {
  const set = feeds.listeners.get(key) ?? new Set<() => void>();
  feeds.listeners.set(key, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && feeds.listeners.get(key) === set) {
      feeds.listeners.delete(key);
    }
  };
}

/** Creates the streams of `host`'s connection. */
export function createStreamStore(host: LiveHost): StreamStore {
  // Hears `qd:host` from now on, before the socket joins a room whose host serves a feed, and
  // loads the peer links once the server announces them, before a feed or a channel needs one.
  hostLinksOf(host.connection);
  const feeds: Feeds = {
    host,
    registry: createRegistry<Feed>((feed) => {
      closeFeed(feeds, feed);
    }),
    listeners: new Map(),
  };
  return Object.freeze({
    hold: (target: StreamTarget, scope: string | undefined, max: number) =>
      hold(feeds, target, scope, max),
    state: (key: string) => feeds.registry.get(key)?.state ?? PENDING_STREAM,
    listen: (key: string, listener: () => void) => listen(feeds, key, listener),
    receive: (frame: unknown) => {
      receive(feeds, frame);
    },
    revoked: (service: string, stream: string, scope: string | undefined) => {
      revoked(feeds, feedKey(service, stream, scope));
    },
    resume(): void {
      for (const feed of feeds.registry.held()) {
        // A host-served feed keeps its hold across a reconnect, and subscribes
        // again when a way to its host opens; after `stop` it holds none.
        if (!feed.hosted || feed.release === undefined) {
          subscribe(feeds, feed);
        }
      }
    },
    forget(): void {
      for (const feed of feeds.registry.held()) {
        setState(feeds, feed, PENDING_STREAM);
        subscribe(feeds, feed);
      }
    },
    stop(): void {
      for (const feed of feeds.registry.held()) {
        clearTimeout(feed.retry);
        feed.retry = undefined;
        feed.attempt += 1;
        feed.pending = undefined;
        if (feed.hosted) {
          feed.release?.();
          feed.release = undefined;
        }
      }
    },
  });
}
