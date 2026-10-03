// The live collection subscriptions of this process's sockets (RFC 0003
// sections 4.4 and 7), beside the entity subscriptions of
// `emit/subscriptions.ts`. Each socket keeps its own on
// `socket.data.collections`, by room: the scope, and the rows its access is
// derived from (its anchors). The index finds the sockets an access change
// can concern by anchor, and the scopes of a collection that have
// subscribers here. Rooms stay the source of truth for who receives frames.
// 4.1 kept nothing (`legacy-src/server/collections.ts:141-187`), so it could
// not revoke a scope a user lost access to.

import { collectionRoom } from "../../contract/names";
import type { AccessChange } from "../access/changes";
import { anchorKey } from "../access/tools";
import { PendingKeys } from "../emit/pending";
import { emptyRecords, ownRecord } from "../emit/subscriptions";
import type { QuickdrawServerSocket } from "../transports/types";

/** One live collection subscription, as `socket.data.collections[room]` records it. */
export interface ScopeSubscription {
  /** The service name. */
  readonly s: string;
  /** The collection name. */
  readonly c: string;
  readonly scope: string;
  /** The rows its access is derived from (`anchorKey`s): the anchor row, then its `inherit` parents. */
  readonly anchors: readonly string[];
}

/**
 * `socket.data.collections`: a socket's collection subscriptions, by room
 * name. Plain data, in an object without a prototype, read by own keys only.
 */
export type ScopeSubscriptions = Record<string, ScopeSubscription>;

/** Told when a scope gains its first subscriber here, and loses its last. */
export interface ScopeListener {
  pin(room: string): void;
  unpin(room: string): void;
}

type Counts = Map<QuickdrawServerSocket, number>;

function serviceOf(anchor: string): string {
  return anchor.slice(0, anchor.indexOf("\u0000"));
}

function count(index: Map<string, Counts>, key: string, socket: QuickdrawServerSocket, by: 1 | -1) {
  const counts = index.get(key) ?? new Map<QuickdrawServerSocket, number>();
  const next = (counts.get(socket) ?? 0) + by;
  if (next > 0) {
    counts.set(socket, next);
    index.set(key, counts);
    return;
  }
  counts.delete(socket);
  if (counts.size === 0) {
    index.delete(key);
  }
}

/** The room of a subscription. */
export function roomOf(subscription: Pick<ScopeSubscription, "s" | "c" | "scope">): string {
  return collectionRoom(subscription.s, subscription.c, subscription.scope);
}

/** The key of one collection of one service, among all of a process's collections. */
export function groupOf(service: string, collection: string): string {
  return `${service}\u0000${collection}`;
}

/** This process's collection subscriptions, indexed by anchor and by collection. */
export class ScopeIndex {
  readonly #byAnchor = new Map<string, Counts>();
  readonly #byService = new Map<string, Counts>();
  /** Per collection (`service\0collection`), how many sockets here subscribe to each scope. */
  readonly #scopes = new Map<string, Map<string, number>>();
  /** The scopes each socket has a `qd:col:sub` in flight for, by room. */
  readonly #pending = new PendingKeys();
  readonly #listener: ScopeListener | undefined;

  constructor(listener?: ScopeListener) {
    this.#listener = listener;
  }

  #index(socket: QuickdrawServerSocket, subscription: ScopeSubscription, by: 1 | -1): void {
    for (const anchor of subscription.anchors) {
      count(this.#byAnchor, anchor, socket, by);
      count(this.#byService, serviceOf(anchor), socket, by);
    }
    const key = groupOf(subscription.s, subscription.c);
    const scopes = this.#scopes.get(key) ?? new Map<string, number>();
    const next = (scopes.get(subscription.scope) ?? 0) + by;
    if (next > 0) {
      scopes.set(subscription.scope, next);
      this.#scopes.set(key, scopes);
    } else {
      scopes.delete(subscription.scope);
      if (scopes.size === 0) {
        this.#scopes.delete(key);
      }
    }
    if (next === 1 && by === 1) {
      this.#listener?.pin(roomOf(subscription));
    } else if (next === 0) {
      this.#listener?.unpin(roomOf(subscription));
    }
  }

  /** The socket's subscription to a scope, by room, or `undefined`. */
  get(socket: QuickdrawServerSocket, room: string): ScopeSubscription | undefined {
    return ownRecord(socket.data.collections, room);
  }

  /** Every collection subscription of the socket. */
  entries(socket: QuickdrawServerSocket): ScopeSubscription[] {
    return Object.values(socket.data.collections ?? {});
  }

  /** Records a subscription and puts the socket in the scope's room, replacing any earlier one. */
  set(socket: QuickdrawServerSocket, subscription: ScopeSubscription): void {
    const room = roomOf(subscription);
    const previous = this.get(socket, room);
    socket.data.collections ??= emptyRecords();
    socket.data.collections[room] = subscription;
    this.#index(socket, subscription, 1);
    if (previous !== undefined) {
      this.#index(socket, previous, -1);
    }
    void socket.join(room);
  }

  /** Ends a subscription: the socket leaves the scope's room. Returns what it was. */
  delete(socket: QuickdrawServerSocket, room: string): ScopeSubscription | undefined {
    const previous = this.get(socket, room);
    if (previous === undefined) {
      return undefined;
    }
    const subscriptions = socket.data.collections;
    if (subscriptions !== undefined) {
      delete subscriptions[room];
    }
    this.#index(socket, previous, -1);
    void socket.leave(room);
    return previous;
  }

  /** A `qd:col:sub` of the scope begins; returns how often it was unsubscribed from so far. */
  begin(socket: QuickdrawServerSocket, room: string): number {
    return this.#pending.begin(socket, [room]).get(room) ?? 0;
  }

  /** The subscribe `begin` started has ended. */
  end(socket: QuickdrawServerSocket, room: string): void {
    this.#pending.end(socket, [room]);
  }

  /** A client unsubscribed: forget its subscription, and stop one still being made from joining. */
  unsubscribe(socket: QuickdrawServerSocket, room: string): void {
    this.#pending.unsubscribed(socket, room);
    this.delete(socket, room);
  }

  /** How often the client unsubscribed from the scope while a subscribe of it ran; it joins only if that did not move. */
  unsubscribes(socket: QuickdrawServerSocket, room: string): number {
    return this.#pending.count(socket, room);
  }

  /** A socket disconnected: Socket.IO has emptied its rooms; drop it from the index. */
  drop(socket: QuickdrawServerSocket): void {
    for (const subscription of this.entries(socket)) {
      this.#index(socket, subscription, -1);
    }
    socket.data.collections = emptyRecords();
  }

  /** The scopes of a collection that sockets of this process subscribe to. */
  scopes(service: string, collection: string): string[] {
    return [...(this.#scopes.get(groupOf(service, collection))?.keys() ?? [])];
  }

  /**
   * The subscriptions an access change can concern: those anchored on the
   * changed row (any row of the service when `id` is absent), of the changed
   * user's sockets (every user's when `userId` is absent).
   */
  matching(change: AccessChange): Map<QuickdrawServerSocket, ScopeSubscription[]> {
    const key = change.id === undefined ? undefined : anchorKey(change.service, change.id);
    const sockets =
      key === undefined ? this.#byService.get(change.service) : this.#byAnchor.get(key);
    const found = new Map<QuickdrawServerSocket, ScopeSubscription[]>();
    for (const socket of sockets?.keys() ?? []) {
      if (change.userId !== undefined && socket.data.principal?.userId !== change.userId) {
        continue;
      }
      const entries = this.entries(socket).filter(({ anchors }) =>
        anchors.some((anchor) =>
          key === undefined ? serviceOf(anchor) === change.service : anchor === key,
        ),
      );
      if (entries.length > 0) {
        found.set(socket, entries);
      }
    }
    return found;
  }
}
