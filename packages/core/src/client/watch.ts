// The change topics a client connection watches (RFC 0003 sections 8.2 and
// 11.3). A query whose contract declares `watch` joins the topic of the
// collection scope it reads; the server then sends `qd:changed { s, topic,
// rev }` once per flush that changed the topic, with no data, and the query
// is invalidated (`hooks.ts`, through the coordinator). This replaces 4.1's
// `invalidateOn`, which listened for hand-written event names on every hook
// (`legacy-src/client/useServiceQuery.ts:139-166`).
//
// - Watches are counted per topic across everything that watches it: the
//   first sends `qd:watch`, the last to leave sends `qd:unwatch`, so two
//   components reading one topic join it once.
// - The server forgets a socket's topics when it disconnects, so every
//   connect sends `qd:watch` again for each topic still watched.
// - `qd:watch` runs in the socket's subscription lane on the server. A
//   `RATE_LIMITED` answer starts the connection's `subscription` backoff, and
//   the topic is joined again once it ends; no topic is joined while it
//   lasts. Any other refusal (`FORBIDDEN`, `NOT_FOUND`, ...) stands until
//   the next connect: the query still works, it is just not told of changes.
// - One `qd:changed` listener serves every topic and routes by topic.
//   Watches that share a `key` are told once per frame between them.
//
// React-free: the connection owns one (`connection.watch`).

import { CLIENT_EVENTS, SERVER_EVENTS } from "../contract/names";
import type { ChangedFrame } from "../protocol/envelope";
import { fromWire } from "../protocol/errors";
import { isRecord } from "../protocol/guards";
import { DEFAULT_BACKOFF_MS, retryAfterOf, type BackoffKind } from "./backoff";
import type { QuickdrawSocket } from "./connection";

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
   * Watches of one topic that share a key are told of each frame once
   * between them. The query hooks pass their query key's hash, so two
   * components reading one query cause one invalidation.
   */
  readonly key?: string;
}

/** What the topics need of their connection. */
export interface TopicHost {
  readonly socket: QuickdrawSocket;
  /** How long to wait for the answer to `qd:watch`. */
  timeoutMs(): number;
  backoffRemaining(kind: BackoffKind): number;
  reportRateLimited(kind: BackoffKind, retryAfterMs?: number): void;
}

/** The topics of one connection. */
export interface Topics {
  /** Starts a watch; returns the function that ends it. Ending it twice does nothing. */
  watch(watch: TopicWatch): () => void;
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

interface Topic {
  readonly id: string;
  readonly frame: { readonly s: string; readonly topic: string };
  /** One record per `watch` call, so the same watch object may be started twice. */
  readonly watches: Set<{ readonly watch: TopicWatch }>;
  state: JoinState;
  retry: ReturnType<typeof setTimeout> | undefined;
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

/** Tells each watch of `topic` of `frame`, once per key. */
function tell(topic: Topic, frame: ChangedFrame): void {
  const told = new Set<string>();
  const watches = [...topic.watches].filter(({ watch }) => {
    if (watch.key === undefined) {
      return true;
    }
    const first = !told.has(watch.key);
    told.add(watch.key);
    return first;
  });
  notifyEach(watches, ({ watch }) => {
    watch.onChanged(frame);
  });
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

/** Settles a topic by the answer to its `qd:watch`, or by the error that came instead. */
function answered(registry: Registry, topic: Topic, error: Error | null, reply: unknown): void {
  const { host } = registry;
  if (error !== null) {
    // No answer: a dropped connection joins again on its next connect.
    if (host.socket.connected) {
      retryIn(registry, topic, DEFAULT_BACKOFF_MS);
    } else {
      topic.state = "waiting";
    }
    return;
  }
  if (isRecord(reply) && reply.ok === true) {
    topic.state = "joined";
    return;
  }
  const failure = fromWire(isRecord(reply) ? reply.e : undefined);
  if (failure.code === "RATE_LIMITED") {
    host.reportRateLimited("subscription", retryAfterOf(failure));
    retryIn(registry, topic, host.backoffRemaining("subscription"));
  } else {
    topic.state = "refused";
  }
}

/** Sends `qd:watch` for `topic` when the socket is connected and subscriptions are not backing off. */
function join(registry: Registry, topic: Topic): void {
  const { host } = registry;
  clearTimeout(topic.retry);
  topic.retry = undefined;
  topic.attempt += 1;
  const wait = host.backoffRemaining("subscription");
  if (!host.socket.connected) {
    topic.state = "waiting";
  } else if (wait > 0) {
    retryIn(registry, topic, wait);
  } else {
    topic.state = "joining";
    const { attempt } = topic;
    host.socket
      .timeout(host.timeoutMs())
      .emit(CLIENT_EVENTS.watch, topic.frame, (error: Error | null, reply: unknown) => {
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
  topic.attempt += 1;
  const sent = topic.state === "joining" || topic.state === "joined";
  if (sent && registry.host.socket.connected) {
    registry.host.socket.emit(CLIENT_EVENTS.unwatch, topic.frame);
  }
}

function startWatch(registry: Registry, watch: TopicWatch): () => void {
  const id = topicId(watch.service, watch.topic);
  const topic = registry.topics.get(id) ?? {
    id,
    frame: Object.freeze({ s: watch.service, topic: watch.topic }),
    watches: new Set(),
    state: "waiting",
    retry: undefined,
    attempt: 0,
  };
  registry.topics.set(id, topic);
  const record = { watch };
  topic.watches.add(record);
  if (topic.watches.size === 1) {
    join(registry, topic);
  }
  return () => {
    if (topic.watches.delete(record) && topic.watches.size === 0) {
      leave(registry, topic);
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
  return Object.freeze({
    watch: (watch: TopicWatch) => startWatch(registry, watch),
    rejoin(): void {
      for (const topic of registry.topics.values()) {
        join(registry, topic);
      }
    },
    stop(): void {
      for (const topic of registry.topics.values()) {
        clearTimeout(topic.retry);
        topic.retry = undefined;
        topic.attempt += 1;
        topic.state = "waiting";
      }
    },
  });
}
