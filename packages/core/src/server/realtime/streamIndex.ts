// The stream feeds this process's sockets subscribe to (RFC 0003 sections
// 4.4 and 12.5), beside the collection scopes of `collections/scopes.ts`. Each
// socket keeps its own on `socket.data.streams`, by room: the feed, and the
// rows its access is derived from (its anchors). The index finds the
// subscriptions an access change can concern by anchor, so revocation
// (`streamRevocation.ts`) authorizes only those again. Rooms stay the source
// of truth for who receives `qd:stream` frames: a subscribe still settling
// its races is recorded but out of the room (`hold`, then `join`).

import { streamRoom } from "../../contract/names";
import type { AccessChange } from "../access/changes";
import { anchorKey } from "../access/tools";
import { count, emptyRecords, ownRecord, serviceOf, type Counts } from "../emit/subscriptions";
import type { QuickdrawServerSocket } from "../transports/types";
import type { StreamSubscription } from "./types";

/** The room of a stream subscription. */
export function streamRoomOf(subscription: StreamSubscription): string {
  return streamRoom(subscription.s, subscription.stream, subscription.scope);
}

/** The record of a subscription to `target`'s feed, with the rows its access is derived from. */
export function subscriptionOf(
  target: {
    readonly service: { readonly name: string };
    readonly stream: { readonly name: string };
    readonly scope: string | undefined;
  },
  anchors: readonly string[],
): StreamSubscription {
  const { service, stream, scope } = target;
  return scope === undefined
    ? { s: service.name, stream: stream.name, anchors }
    : { s: service.name, stream: stream.name, scope, anchors };
}

/** This process's stream subscriptions, indexed by anchor. */
export class StreamIndex {
  readonly #byAnchor = new Map<string, Counts>();
  readonly #byService = new Map<string, Counts>();
  /** Per socket, the rooms of subscriptions recorded by `hold` and not joined yet. */
  readonly #held = new WeakMap<QuickdrawServerSocket, Set<string>>();

  #index(socket: QuickdrawServerSocket, subscription: StreamSubscription, by: 1 | -1): void {
    for (const anchor of subscription.anchors) {
      count(this.#byAnchor, anchor, socket, by);
      count(this.#byService, serviceOf(anchor), socket, by);
    }
  }

  /** The socket's subscription to a feed, by room, or `undefined`. */
  get(socket: QuickdrawServerSocket, room: string): StreamSubscription | undefined {
    return ownRecord(socket.data.streams, room);
  }

  /** Every stream subscription of the socket. */
  entries(socket: QuickdrawServerSocket): StreamSubscription[] {
    return Object.values(socket.data.streams ?? {});
  }

  /** How many feeds the socket subscribes to. */
  size(socket: QuickdrawServerSocket): number {
    return Object.keys(socket.data.streams ?? {}).length;
  }

  #record(socket: QuickdrawServerSocket, room: string, subscription: StreamSubscription): void {
    const previous = this.get(socket, room);
    socket.data.streams ??= emptyRecords();
    socket.data.streams[room] = subscription;
    this.#index(socket, subscription, 1);
    if (previous !== undefined) {
      this.#index(socket, previous, -1);
    }
  }

  /**
   * Records a subscription and puts the socket in the feed's room, replacing
   * any earlier one; one `hold` recorded stays out of the room until `join`.
   */
  set(socket: QuickdrawServerSocket, subscription: StreamSubscription): void {
    const room = streamRoomOf(subscription);
    this.#record(socket, room, subscription);
    if (this.#held.get(socket)?.has(room) !== true) {
      void socket.join(room);
    }
  }

  /**
   * Records a subscription still settling its races, replacing any earlier
   * one: revocation finds it, but the socket is not put in the feed's room
   * (it stays there if an earlier subscription put it there) until `join`.
   */
  hold(socket: QuickdrawServerSocket, subscription: StreamSubscription): void {
    const room = streamRoomOf(subscription);
    this.#record(socket, room, subscription);
    const held = this.#held.get(socket) ?? new Set<string>();
    held.add(room);
    this.#held.set(socket, held);
  }

  /**
   * Puts the socket in the room of a subscription `hold` recorded: what it
   * holds there, or `undefined` when nothing (an unsubscribe, a revocation
   * or a disconnect ended it), and the socket stays out.
   */
  join(socket: QuickdrawServerSocket, room: string): StreamSubscription | undefined {
    this.#held.get(socket)?.delete(room);
    const subscription = this.get(socket, room);
    if (subscription !== undefined) {
      void socket.join(room);
    }
    return subscription;
  }

  /** Ends a subscription: the socket leaves the feed's room. Returns what it was. */
  delete(socket: QuickdrawServerSocket, room: string): StreamSubscription | undefined {
    const previous = this.get(socket, room);
    if (previous !== undefined && socket.data.streams !== undefined) {
      delete socket.data.streams[room];
      this.#index(socket, previous, -1);
    }
    this.#held.get(socket)?.delete(room);
    void socket.leave(room);
    return previous;
  }

  /** A socket disconnected: Socket.IO has emptied its rooms; drop it from the index. */
  drop(socket: QuickdrawServerSocket): void {
    for (const subscription of this.entries(socket)) {
      this.#index(socket, subscription, -1);
    }
    socket.data.streams = emptyRecords();
    this.#held.delete(socket);
  }

  /**
   * The subscriptions an access change can concern: those anchored on the
   * changed row (any row of the service when `id` is absent), of the changed
   * user's sockets (every user's when `userId` is absent).
   */
  matching(change: AccessChange): Map<QuickdrawServerSocket, StreamSubscription[]> {
    const key = change.id === undefined ? undefined : anchorKey(change.service, change.id);
    const sockets =
      key === undefined ? this.#byService.get(change.service) : this.#byAnchor.get(key);
    const found = new Map<QuickdrawServerSocket, StreamSubscription[]>();
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
