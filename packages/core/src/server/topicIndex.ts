// The change topics this process's sockets watch (RFC 0003 section 11.3). A
// query whose contract declares `watch` makes the client join that topic
// with `qd:watch { s, topic }`: `{collection}:{scope}` for one scope of a
// collection, or `service` for the whole service. Each socket keeps its own
// watches on `socket.data.topics`, by room; the index counts them per scope
// and per service, so a flush computes only the topics someone here watches,
// and finds the watches an access change can concern by the rows a scope's
// access is derived from (its anchors), as `collections/scopes.ts` does.
// Rooms stay the source of truth for who receives `qd:changed`.

import { SERVICE_TOPIC, topicRoom } from "../contract/names";
import { MAX_SCOPE_LENGTH } from "../protocol/version";
import type { AccessChange } from "./access/changes";
import { anchorKey } from "./access/tools";
import { PendingKeys } from "./emit/pending";
import { count, emptyRecords, ownRecord, serviceOf, type Counts } from "./emit/subscriptions";
import { unreadable } from "./transports/ack";
import type { QuickdrawServerSocket } from "./transports/types";

/** One watched topic, as `socket.data.topics[room]` records it. */
export interface TopicWatch {
  /** The service name. */
  readonly s: string;
  /** The topic as the frame names it: `service`, or `{collection}:{scope}`. */
  readonly topic: string;
  /** The collection of a collection scope's topic; absent for the service topic. */
  readonly c?: string;
  /** The scope of a collection scope's topic; absent for the service topic. */
  readonly scope?: string;
  /**
   * The rows a collection scope's watch is authorized through (`anchorKey`s):
   * the anchor row, then its `inherit` parents. None for the service topic
   * or a `"self"` scope.
   */
  readonly anchors?: readonly string[];
}

/**
 * `socket.data.topics`: a socket's watched topics, by room. Plain data, in an
 * object without a prototype, read by own keys only.
 */
export type TopicWatches = Record<string, TopicWatch>;

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Reads a `qd:watch` or `qd:unwatch` frame, `{ s, topic }`, or throws
 * `VALIDATION`. A topic other than `service` is `{collection}:{scope}`,
 * split at its first colon: the collection name holds none, the scope may.
 */
export function readWatch(value: unknown, event: string): TopicWatch {
  const frame =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : {};
  const { s, topic } = frame;
  if (!isName(s) || !isName(topic)) {
    throw unreadable(`A ${event} frame needs { s, topic } with each a non-empty string`);
  }
  if (topic.length > MAX_SCOPE_LENGTH) {
    throw unreadable(`topic must be at most ${MAX_SCOPE_LENGTH} characters`, ["topic"]);
  }
  if (topic === SERVICE_TOPIC) {
    return { s, topic };
  }
  const colon = topic.indexOf(":");
  if (colon <= 0 || colon === topic.length - 1) {
    throw unreadable(`topic must be "${SERVICE_TOPIC}" or {collection}:{scope}`, ["topic"]);
  }
  return { s, topic, c: topic.slice(0, colon), scope: topic.slice(colon + 1) };
}

function groupOf(service: string, collection: string): string {
  return `${service}\u0000${collection}`;
}

const NONE: ReadonlySet<string> = Object.freeze(new Set<string>());

/** The topics sockets of this process watch, counted per service and per collection scope. */
export class TopicIndex {
  /** Per service, how many sockets here watch its service topic. */
  readonly #services = new Map<string, number>();
  /** Per collection (`service\0collection`), how many sockets here watch each scope's topic. */
  readonly #scopes = new Map<string, Map<string, number>>();
  /** The topics each socket has a `qd:watch` in flight for, by room. */
  readonly #pending = new PendingKeys();
  readonly #byAnchor = new Map<string, Counts>();
  readonly #byAnchorService = new Map<string, Counts>();

  #index(socket: QuickdrawServerSocket, watch: TopicWatch, by: 1 | -1): void {
    for (const anchor of watch.anchors ?? []) {
      count(this.#byAnchor, anchor, socket, by);
      count(this.#byAnchorService, serviceOf(anchor), socket, by);
    }
  }

  #count(watch: TopicWatch, by: 1 | -1): void {
    const { c, scope } = watch;
    if (c === undefined || scope === undefined) {
      const next = (this.#services.get(watch.s) ?? 0) + by;
      if (next > 0) {
        this.#services.set(watch.s, next);
      } else {
        this.#services.delete(watch.s);
      }
      return;
    }
    const key = groupOf(watch.s, c);
    const scopes = this.#scopes.get(key) ?? new Map<string, number>();
    const next = (scopes.get(scope) ?? 0) + by;
    if (next > 0) {
      scopes.set(scope, next);
      this.#scopes.set(key, scopes);
      return;
    }
    scopes.delete(scope);
    if (scopes.size === 0) {
      this.#scopes.delete(key);
    }
  }

  /** Records a watch and puts the socket in the topic's room; watching a topic again records its anchors anew. */
  watch(socket: QuickdrawServerSocket, watch: TopicWatch): void {
    const room = topicRoom(watch.s, watch.topic);
    const watches = (socket.data.topics ??= emptyRecords());
    const previous = ownRecord(watches, room);
    watches[room] = watch;
    this.#index(socket, watch, 1);
    if (previous === undefined) {
      this.#count(watch, 1);
    } else {
      this.#index(socket, previous, -1);
    }
    void socket.join(room);
  }

  /** The socket's watch of a topic, by room, or `undefined`. */
  get(socket: QuickdrawServerSocket, room: string): TopicWatch | undefined {
    return ownRecord(socket.data.topics, room);
  }

  /** Every topic the socket watches. */
  entries(socket: QuickdrawServerSocket): TopicWatch[] {
    return Object.values(socket.data.topics ?? {});
  }

  /** Ends a watch the socket may no longer hold: it leaves the topic's room. */
  leave(socket: QuickdrawServerSocket, room: string): void {
    const watches = socket.data.topics;
    const watch = ownRecord(watches, room);
    if (watches !== undefined && watch !== undefined) {
      delete watches[room];
      this.#count(watch, -1);
      this.#index(socket, watch, -1);
    }
    void socket.leave(room);
  }

  /** A `qd:watch` of the topic begins; returns how often it was unwatched so far. */
  begin(socket: QuickdrawServerSocket, room: string): number {
    return this.#pending.begin(socket, [room]).get(room) ?? 0;
  }

  /** The watch `begin` started has ended. */
  end(socket: QuickdrawServerSocket, room: string): void {
    this.#pending.end(socket, [room]);
  }

  /** A client unwatched: the socket leaves the topic's room, and a watch still being authorized will not join it. */
  unwatch(socket: QuickdrawServerSocket, room: string): void {
    this.#pending.unsubscribed(socket, room);
    this.leave(socket, room);
  }

  /** How often the client unwatched the topic while a watch of it ran; it joins only if that did not move. */
  unwatches(socket: QuickdrawServerSocket, room: string): number {
    return this.#pending.count(socket, room);
  }

  /** A socket disconnected: Socket.IO has emptied its rooms; drop its watches from the counts. */
  drop(socket: QuickdrawServerSocket): void {
    for (const watch of this.entries(socket)) {
      this.#count(watch, -1);
      this.#index(socket, watch, -1);
    }
    socket.data.topics = emptyRecords();
  }

  /**
   * The watches an access change can concern: those of collection scopes
   * anchored on the changed row (any row of the service when `id` is
   * absent), of the changed user's sockets (every user's when `userId` is
   * absent).
   */
  matching(change: AccessChange): Map<QuickdrawServerSocket, TopicWatch[]> {
    const key = change.id === undefined ? undefined : anchorKey(change.service, change.id);
    const sockets =
      key === undefined ? this.#byAnchorService.get(change.service) : this.#byAnchor.get(key);
    const found = new Map<QuickdrawServerSocket, TopicWatch[]>();
    for (const socket of sockets?.keys() ?? []) {
      if (change.userId !== undefined && socket.data.principal?.userId !== change.userId) {
        continue;
      }
      const watches = this.entries(socket).filter(({ anchors = [] }) =>
        anchors.some((anchor) =>
          key === undefined ? serviceOf(anchor) === change.service : anchor === key,
        ),
      );
      if (watches.length > 0) {
        found.set(socket, watches);
      }
    }
    return found;
  }

  /** True when a socket of this process watches the service's topic. */
  watchesService(service: string): boolean {
    return this.#services.has(service);
  }

  /** The scopes of a collection whose topics sockets of this process watch. */
  scopes(service: string, collection: string): ReadonlySet<string> {
    const scopes = this.#scopes.get(groupOf(service, collection));
    return scopes === undefined ? NONE : new Set(scopes.keys());
  }

  /** True when a socket of this process watches the topic of one scope of a collection. */
  watchesScope(service: string, collection: string, scope: string): boolean {
    return this.#scopes.get(groupOf(service, collection))?.has(scope) ?? false;
  }
}
