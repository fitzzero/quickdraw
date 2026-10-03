// The change topics a client connection watches (RFC 0003 sections 8.2 and
// 11.3). A query whose contract declares `watch` joins the topic of the
// collection scope it reads; the server then sends `qd:changed { s, topic,
// rev }` once per flush that changed the topic, with no data, and the query
// is invalidated (`hooks.ts`, through the coordinator). This replaces 4.1's
// `invalidateOn`, which listened for hand-written event names on every hook
// (`legacy-src/client/useServiceQuery.ts:139-166`).
//
// - Watches are counted per topic across everything that watches it: the
//   first sends `qd:watch`, and the topic is left (`qd:unwatch`) a tick
//   after the last ends unless another starts first, so two components
//   reading one topic join it once, and a remount joins it once too.
// - The server forgets a socket's topics when it disconnects, so every
//   connect sends `qd:watch` again for each topic still watched.
// - `qd:watch` runs in the socket's subscription lane on the server, and goes
//   through the connection's lane here (`lane.ts`). A `RATE_LIMITED` answer
//   starts the connection's `subscription` backoff, and the topic is joined
//   again once it ends; no topic is joined while it lasts. Any other refusal
//   (`FORBIDDEN`, `NOT_FOUND`, ...) stands until the next connect: the query
//   still works, it is just not told of changes.
// - One `qd:changed` listener serves every topic and routes by topic.
//   Watches that share a `key` are told once per frame between them.
// - A read can wait for its topic's join (`waitForJoin`): while the socket
//   is connected and the topic's `qd:watch` is unanswered, the query hooks
//   hold a read until the server answers it, joined or refused, so the read
//   sees every change made before the join and a watched query is read once
//   on its first mount (RFC 0003 section 17).
// - A watch is told once (`onJoined`) when its topic is first joined after
//   the watch started, unless its key's read waited for that join: a read
//   sent before then (on a socket that was not connected yet, or a result
//   prefetched before the watch) may have missed a change made before the
//   join, so the query hooks read once more. A topic is not joined from the
//   moment the socket drops: a read of a key sent while it is not joined (it
//   waited in Socket.IO's buffer through an outage, or went out while the
//   join waited out a backoff) reaches the server before the join, so the
//   watches of that key are told again when the join is acknowledged.
//   Otherwise joining again after a reconnect tells no one: the
//   coordinator's reconnect refetch covers the queries read before it.
//
// React-free: the connection owns one (`connection.watch`).

import { CLIENT_EVENTS, SERVER_EVENTS } from "../contract/names";
import type { ChangedFrame } from "../protocol/envelope";
import { fromWire } from "../protocol/errors";
import { isRecord } from "../protocol/guards";
import { DEFAULT_BACKOFF_MS, retryAfterOf, type BackoffKind } from "./backoff";
import type { QuickdrawSocket } from "./connection";
import type { SubscriptionLane } from "./lane";

/** One watch of a change topic, as `connection.watch` takes it. */
export interface TopicWatch {
  /** The service's name on the wire: the contract's `name`. */
  readonly service: string;
  /**
   * The topic: `{collection}:{scope}` for one scope of a collection
   * (`collectionTopic`), or `"service"` for the service-wide topic, which the
   * server opens only to services that declare `watchAccess`.
   */
  readonly topic: string;
  /** Called with each `qd:changed` frame of the topic while the watch lasts. */
  readonly onChanged: (frame: ChangedFrame) => void;
  /**
   * Called when the server first acknowledges `qd:watch` for the topic after
   * this watch started, and again when a later join (after a reconnect) is
   * acknowledged after a read of this watch's `key` went out while the topic
   * was not joined: that read may have missed a change made before the join.
   * Not called when the topic was joined already, nor when a read of the
   * `key` waited for that acknowledgement (`waitForJoin`).
   */
  readonly onJoined?: () => void;
  /**
   * Watches of one topic that share a key are told of each frame once
   * between them. The query hooks pass their query key's hash, so two
   * components reading one query cause one invalidation.
   */
  readonly key?: string;
}

/** What the topics need of their connection. */
export interface TopicHost {
  readonly socket: QuickdrawSocket;
  /** The connection's lane, which `qd:watch` goes through. */
  readonly lane: SubscriptionLane;
  backoffRemaining(kind: BackoffKind): number;
  reportRateLimited(kind: BackoffKind, retryAfterMs?: number): void;
}

/** A topic a read waits for, as `waitForJoin` takes it. */
export type JoinWait = Pick<TopicWatch, "service" | "topic" | "key">;

/** The topics of one connection. */
export interface Topics {
  /** Starts a watch; returns the function that ends it. Ending it twice does nothing. */
  watch(watch: TopicWatch): () => void;
  /**
   * While the socket is connected and the topic's `qd:watch` is unanswered,
   * a promise that resolves once it is answered (joined or refused), fails,
   * or the topic is left or the connection closes; `undefined` otherwise,
   * when there is nothing to wait for. The watches with `key` are not told
   * `onJoined` for that join: the read that waited is sent after it.
   */
  waitForJoin(wait: JoinWait): Promise<void> | undefined;
  /** Joins every watched topic again: the socket has just connected. */
  rejoin(): void;
  /** Stops waiting to retry joins: the connection closed. The next connect joins again. */
  stop(): void;
}

/**
 * Where a topic stands with the server: `waiting` to be sent (not connected,
 * or backing off), `joining` until `qd:watch` is answered, `joined`, or
 * `refused` until the next connect.
 */
type JoinState = "waiting" | "joining" | "joined" | "refused";

/** One `watch` call: the watch, and whether it was told its topic was joined. */
interface WatchRecord {
  readonly watch: TopicWatch;
  told: boolean;
}

/** One read waiting for a topic's join (`waitForJoin`): its key, and what lets it go. */
interface Hold {
  readonly key: string | undefined;
  readonly release: () => void;
}

interface Topic {
  readonly id: string;
  readonly frame: { readonly s: string; readonly topic: string };
  /** One record per `watch` call, so the same watch object may be started twice. */
  readonly watches: Set<WatchRecord>;
  /** The reads waiting for the `qd:watch` in flight to be answered. */
  readonly holds: Set<Hold>;
  /** The keys whose reads went out while the topic was not joined, owed a telling at the next join. */
  readonly unjoinedReads: Set<string>;
  state: JoinState;
  retry: ReturnType<typeof setTimeout> | undefined;
  /**
   * Set when the last watch ended: the topic is left on the next tick
   * unless a watch starts first, so a component that remounts (React's
   * strict mode) or changes its input within one scope keeps its topic
   * instead of leaving and joining it again.
   */
  leaving: ReturnType<typeof setTimeout> | undefined;
  /** Raised by every join and by leaving, so the answer to an earlier `qd:watch` is ignored. */
  attempt: number;
}

/** The topics of one connection, by `topicId`. */
interface Registry {
  readonly host: TopicHost;
  readonly topics: Map<string, Topic>;
}

function topicId(service: string, topic: string): string {
  return `${service}\u0000${topic}`;
}

/** Throws `error` from a microtask of its own, where it is reported without unwinding the caller. */
function rethrowLater(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

/** Runs `notify` for each listener, so one that throws neither stops the others nor the socket. */
export function notifyEach<T>(listeners: Iterable<T>, notify: (listener: T) => void): void {
  for (const listener of [...listeners]) {
    try {
      notify(listener);
    } catch (error) {
      rethrowLater(error);
    }
  }
}

/** `records` with one per key: a watch without a key is always kept. */
function oncePerKey(records: Iterable<WatchRecord>): WatchRecord[] {
  const keys = new Set<string>();
  return [...records].filter(({ watch }) => {
    if (watch.key === undefined) {
      return true;
    }
    const first = !keys.has(watch.key);
    keys.add(watch.key);
    return first;
  });
}

/** Tells each watch of `topic` of `frame`, once per key. */
function tell(topic: Topic, frame: ChangedFrame): void {
  notifyEach(oncePerKey(topic.watches), ({ watch }) => {
    watch.onChanged(frame);
  });
}

/**
 * Tells the watches of `topic` that it is joined, once per key: those not
 * told yet, and those whose key's read went out while it was not joined;
 * except those whose key's read waited for this join, which is sent after
 * it.
 */
function tellJoined(topic: Topic): void {
  const waited = new Set([...topic.holds].map((hold) => hold.key));
  const unjoined = new Set(topic.unjoinedReads);
  topic.unjoinedReads.clear();
  const owed = [...topic.watches].filter(
    ({ watch, told }) => !told || (watch.key !== undefined && unjoined.has(watch.key)),
  );
  for (const record of owed) {
    record.told = true;
  }
  const toTell = owed.filter(({ watch }) => watch.key === undefined || !waited.has(watch.key));
  notifyEach(oncePerKey(toTell), ({ watch }) => {
    watch.onJoined?.();
  });
}

/**
 * Lets every read waiting for `topic`'s join go: it was answered, failed, or
 * will not be sent. Unless the topic is joined now, those reads go out
 * before its join.
 */
function releaseHolds(topic: Topic): void {
  const holds = [...topic.holds];
  topic.holds.clear();
  for (const hold of holds) {
    if (topic.state !== "joined" && hold.key !== undefined) {
      topic.unjoinedReads.add(hold.key);
    }
    hold.release();
  }
}

function isChangedFrame(value: unknown): value is ChangedFrame {
  return isRecord(value) && typeof value.s === "string" && typeof value.topic === "string";
}

/** Joins `topic` again after `delayMs`, unless it is left first. */
function retryIn(registry: Registry, topic: Topic, delayMs: number): void {
  clearTimeout(topic.retry);
  topic.state = "waiting";
  topic.retry = setTimeout(() => {
    topic.retry = undefined;
    if (registry.topics.get(topic.id) === topic) {
      join(registry, topic);
    }
  }, delayMs);
}

/** Settles a topic by a refusal of its `qd:watch`: waits out `RATE_LIMITED`, else stands refused. */
function refused(registry: Registry, topic: Topic, reply: unknown): void {
  const { host } = registry;
  const failure = fromWire(isRecord(reply) ? reply.e : undefined);
  if (failure.code === "RATE_LIMITED") {
    host.reportRateLimited("subscription", retryAfterOf(failure));
    retryIn(registry, topic, host.backoffRemaining("subscription"));
  } else {
    topic.state = "refused";
  }
}

/**
 * Settles a topic by the answer to its `qd:watch`, or by the error that came
 * instead, and lets the reads that waited for it go: joined, they see every
 * change made before the join; otherwise they read anyway.
 */
function answered(registry: Registry, topic: Topic, error: Error | null, reply: unknown): void {
  if (error !== null) {
    // No answer: a dropped connection joins again on its next connect.
    if (registry.host.socket.connected) {
      retryIn(registry, topic, DEFAULT_BACKOFF_MS);
    } else {
      topic.state = "waiting";
    }
  } else if (isRecord(reply) && reply.ok === true) {
    topic.state = "joined";
    tellJoined(topic);
  } else {
    refused(registry, topic, reply);
  }
  releaseHolds(topic);
}

/**
 * Sends `qd:watch` for `topic` when the socket is connected and
 * subscriptions are not backing off. Reads waiting for an earlier attempt
 * wait for this one; when none is sent, they go.
 */
function join(registry: Registry, topic: Topic): void {
  const { host } = registry;
  clearTimeout(topic.retry);
  topic.retry = undefined;
  topic.attempt += 1;
  const wait = host.backoffRemaining("subscription");
  if (!host.socket.connected) {
    topic.state = "waiting";
    releaseHolds(topic);
  } else if (wait > 0) {
    retryIn(registry, topic, wait);
    releaseHolds(topic);
  } else {
    topic.state = "joining";
    const { attempt } = topic;
    host.lane.send(CLIENT_EVENTS.watch, topic.frame, (error, reply) => {
      if (registry.topics.get(topic.id) === topic && topic.attempt === attempt) {
        answered(registry, topic, error, reply);
      }
    });
  }
}

/** Forgets `topic`, and sends `qd:unwatch` when the server may have joined it. */
function leave(registry: Registry, topic: Topic): void {
  registry.topics.delete(topic.id);
  clearTimeout(topic.retry);
  clearTimeout(topic.leaving);
  topic.leaving = undefined;
  topic.attempt += 1;
  releaseHolds(topic);
  const sent = topic.state === "joining" || topic.state === "joined";
  if (sent && registry.host.socket.connected) {
    registry.host.socket.emit(CLIENT_EVENTS.unwatch, topic.frame);
  }
}

/**
 * A promise that resolves once `topic`'s `qd:watch` in flight is answered;
 * see `Topics.waitForJoin`. A read that does not wait while the topic is not
 * joined goes out before its join, and is remembered for that join.
 */
function waitForJoin(registry: Registry, wait: JoinWait): Promise<void> | undefined {
  const topic = registry.topics.get(topicId(wait.service, wait.topic));
  if (topic === undefined) {
    return undefined;
  }
  if (topic.state === "joining" && registry.host.socket.connected) {
    return new Promise<void>((resolve) => {
      topic.holds.add({ key: wait.key, release: resolve });
    });
  }
  if (topic.state !== "joined" && wait.key !== undefined) {
    topic.unjoinedReads.add(wait.key);
  }
  return undefined;
}

function startWatch(registry: Registry, watch: TopicWatch): () => void {
  const id = topicId(watch.service, watch.topic);
  const topic = registry.topics.get(id) ?? {
    id,
    frame: Object.freeze({ s: watch.service, topic: watch.topic }),
    watches: new Set(),
    holds: new Set(),
    unjoinedReads: new Set(),
    state: "waiting",
    retry: undefined,
    leaving: undefined,
    attempt: 0,
  };
  registry.topics.set(id, topic);
  const kept = topic.leaving !== undefined;
  clearTimeout(topic.leaving);
  topic.leaving = undefined;
  // A topic joined already needs no telling: this watch's reads come after the join.
  const record: WatchRecord = { watch, told: topic.state === "joined" };
  topic.watches.add(record);
  if (topic.watches.size === 1 && !kept) {
    join(registry, topic);
  }
  return () => {
    if (topic.watches.delete(record) && topic.watches.size === 0) {
      topic.leaving = setTimeout(() => {
        if (topic.watches.size === 0 && registry.topics.get(topic.id) === topic) {
          leave(registry, topic);
        }
      }, 0);
    }
  };
}

/** Creates the topics of a connection and listens for `qd:changed` on its socket. */
export function createTopics(host: TopicHost): Topics {
  const registry: Registry = { host, topics: new Map() };
  host.socket.on(SERVER_EVENTS.changed, (frame: unknown) => {
    const topic = isChangedFrame(frame)
      ? registry.topics.get(topicId(frame.s, frame.topic))
      : undefined;
    if (topic !== undefined) {
      tell(topic, frame as ChangedFrame);
    }
  });
  host.socket.on("disconnect", () => {
    // The server forgot the socket's topics with it.
    for (const topic of registry.topics.values()) {
      if (topic.state === "joined") {
        topic.state = "waiting";
      }
    }
  });
  return Object.freeze({
    watch: (watch: TopicWatch) => startWatch(registry, watch),
    waitForJoin: (wait: JoinWait) => waitForJoin(registry, wait),
    rejoin(): void {
      for (const topic of [...registry.topics.values()]) {
        if (topic.watches.size === 0) {
          leave(registry, topic);
        } else {
          join(registry, topic);
        }
      }
    },
    stop(): void {
      for (const topic of [...registry.topics.values()]) {
        if (topic.watches.size === 0) {
          leave(registry, topic);
        } else {
          clearTimeout(topic.retry);
          topic.retry = undefined;
          topic.attempt += 1;
          topic.state = "waiting";
          releaseHolds(topic);
        }
      }
    },
  });
}
