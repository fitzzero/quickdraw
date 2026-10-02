// Room and event names for protocol v5 (RFC 0003 sections 6, 7 and 8). Ported
// from the 4.1 room helpers (`legacy-src/shared/types.ts:364-405`), which were
// plain template strings so shared code could name a room without holding a
// service instance. The 5.0 rooms live under a `qd:` prefix so they never
// collide with an app's own rooms; the per-user room keeps its 4.1 name.

import type { AccessLevel } from "./access";

/**
 * The room for one entity at one access tier: `qd:e:{service}:{id}@{level}`.
 * A subscriber joins the room for its own level, so a frame is built once and
 * stripped once per occupied tier.
 */
export function entityRoom(service: string, id: string, level: AccessLevel): string {
  return `qd:e:${service}:${id}@${level}`;
}

/** The room for one scope of a collection: `qd:c:{service}:{collection}:{scope}`. */
export function collectionRoom(service: string, collection: string, scope: string): string {
  return `qd:c:${service}:${collection}:${scope}`;
}

/** The room for a watched topic of a service: `qd:t:{service}:{topic}`. */
export function topicRoom(service: string, topic: string): string {
  return `qd:t:${service}:${topic}`;
}

/** The room every authenticated socket of a user joins: `user:{userId}`, as in 4.1. */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

/** Events a client sends to the server (RFC 0003 section 8.2). */
export const CLIENT_EVENTS = Object.freeze({
  /** A method call: `{ id, s, m, i, v? }`, answered by ack. */
  call: "qd:call",
  /** Cancels an in-flight call: `{ id }`. */
  cancel: "qd:cancel",
  /** Subscribes to entities by id, with the revisions held. */
  sub: "qd:sub",
  /** Unsubscribes from entities. */
  unsub: "qd:unsub",
  /** Subscribes to a collection scope, or resumes it from a revision. */
  collectionSub: "qd:col:sub",
  /** Unsubscribes from a collection scope. */
  collectionUnsub: "qd:col:unsub",
  /** Loads collection items by id. */
  collectionItems: "qd:col:items",
  /** Joins a watched topic: `{ s, topic }`. */
  watch: "qd:watch",
  /** Leaves a watched topic. */
  unwatch: "qd:unwatch",
  /** Subscribes to a stream and receives its seed. */
  streamSub: "qd:stream:sub",
  /** Unsubscribes from a stream. */
  streamUnsub: "qd:stream:unsub",
  /** A fire-and-forget channel message, sent volatile: `[s, channel, payload]`. */
  channel: "qd:ch",
} as const);

/** Events the server sends to a client (RFC 0003 section 8.3). */
export const SERVER_EVENTS = Object.freeze({
  /** The handshake reply: `{ protocol, server, limits, features }`. */
  hello: "qd:hello",
  /** Entity frames: full update, patch or removal. */
  entity: "qd:e",
  /** Collection deltas, batched per flush. */
  collection: "qd:c",
  /** A watched topic changed; the client invalidates its queries. */
  changed: "qd:changed",
  /** Access to a subscription was revoked. */
  revoked: "qd:revoked",
  /** Stream items. */
  stream: "qd:stream",
  /** Typed custom room events declared in a contract's `events`. */
  event: "qd:event",
  /** Reconnect within a jitter window. */
  rotate: "qd:rotate",
  /** The user's service grants changed. */
  access: "qd:access",
} as const);

/** The name of an event a client sends. */
export type ClientEventName = (typeof CLIENT_EVENTS)[keyof typeof CLIENT_EVENTS];

/** The name of an event the server sends. */
export type ServerEventName = (typeof SERVER_EVENTS)[keyof typeof SERVER_EVENTS];
