// The live entity subscriptions of this process's sockets (RFC 0003 sections
// 4.4 and 6). Each socket keeps its own on `socket.data.entities`: the level
// it joined the row's tier room at, and the rows that level is derived from
// (its anchors). The index here finds the sockets an access change can
// concern by anchor, so revocation re-resolves only theirs. Rooms stay the
// source of truth for who receives frames: nothing here is read to emit, and
// 4.1's per-entity `subscribers` map (4.1 `src/server/BaseService.ts:86-89`)
// is not kept.
//
// Services and ids come from client frames, so the records are kept in
// objects without a prototype and read only through their own keys: a frame
// naming `__proto__` or `constructor` finds nothing (`ownRecord`).

import type { AccessLevel } from "../../contract/access";
import { entityRoom } from "../../contract/names";
import type { AccessChange } from "../access/changes";
import { anchorKey } from "../access/tools";
import type { QuickdrawServerSocket } from "../transports/types";
import { PendingKeys } from "./pending";

/**
 * `records[key]` when `records` holds `key` itself, never through its
 * prototype: client frames name the keys of per-socket records, and a key
 * like `__proto__`, `constructor` or `toString` must find nothing.
 */
export function ownRecord<T>(
  records: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  return records !== undefined && Object.hasOwn(records, key) ? records[key] : undefined;
}

/** An empty record map without a prototype, so no key a client names is found on it. */
export function emptyRecords<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

/** One live subscription, as `socket.data.entities[service][id]` records it. */
export interface EntitySubscription {
  /** The level the socket holds on the row: it is in the row's room for this level. */
  readonly level: AccessLevel;
  /** The rows the level is derived from (`anchorKey`s): the row, then its `inherit` parents. */
  readonly anchors: readonly string[];
}

/**
 * `socket.data.entities`: a socket's subscriptions, by service, then row id.
 * Plain data, in objects without a prototype; read it with `ownRecord`.
 */
export type EntitySubscriptions = Record<string, Record<string, EntitySubscription>>;

/** One subscription of a socket, with the row it is on. */
export interface SubscriptionEntry {
  readonly service: string;
  readonly id: string;
  readonly subscription: EntitySubscription;
}

/** How many of a socket's records each socket has under one key of an index. */
export type Counts = Map<QuickdrawServerSocket, number>;

/** The service an `anchorKey` names. */
export function serviceOf(anchor: string): string {
  return anchor.slice(0, anchor.indexOf("\u0000"));
}

/** Counts one more (`1`) or one fewer (`-1`) record of the socket under `key`; drops what reaches zero. */
export function count(
  index: Map<string, Counts>,
  key: string,
  socket: QuickdrawServerSocket,
  by: 1 | -1,
): void {
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

/** This process's entity subscriptions, indexed by anchor. */
export class SubscriptionIndex {
  /** Moves on every access change this process handles; a subscribe that saw it move checks again. */
  accessChanges = 0;
  readonly #byAnchor = new Map<string, Counts>();
  readonly #byService = new Map<string, Counts>();
  /** The rows each socket has a `qd:sub` batch in flight for, by `anchorKey`. */
  readonly pending = new PendingKeys();

  #index(socket: QuickdrawServerSocket, anchors: readonly string[], by: 1 | -1): void {
    for (const anchor of anchors) {
      count(this.#byAnchor, anchor, socket, by);
      count(this.#byService, serviceOf(anchor), socket, by);
    }
  }

  /** The socket's subscription to a row, or `undefined`. */
  get(socket: QuickdrawServerSocket, service: string, id: string): EntitySubscription | undefined {
    return ownRecord(ownRecord(socket.data.entities, service), id);
  }

  /** Every subscription of the socket. */
  *entries(socket: QuickdrawServerSocket): Generator<SubscriptionEntry> {
    for (const [service, rows] of Object.entries(socket.data.entities ?? {})) {
      for (const [id, subscription] of Object.entries(rows)) {
        yield { service, id, subscription };
      }
    }
  }

  /** Records a subscription and puts the socket in the row's room for its level, replacing any earlier one. */
  set(
    socket: QuickdrawServerSocket,
    service: string,
    id: string,
    subscription: EntitySubscription,
  ): void {
    const previous = this.get(socket, service, id);
    if (previous !== undefined) {
      this.#index(socket, previous.anchors, -1);
      if (previous.level !== subscription.level) {
        void socket.leave(entityRoom(service, id, previous.level));
      }
    }
    const services = (socket.data.entities ??= emptyRecords());
    const rows = ownRecord(services, service) ?? emptyRecords<EntitySubscription>();
    services[service] = rows;
    rows[id] = subscription;
    this.#index(socket, subscription.anchors, 1);
    void socket.join(entityRoom(service, id, subscription.level));
  }

  /** Ends a subscription: the socket leaves the row's room. Returns what it was. */
  delete(
    socket: QuickdrawServerSocket,
    service: string,
    id: string,
  ): EntitySubscription | undefined {
    const previous = this.get(socket, service, id);
    if (previous === undefined) {
      return undefined;
    }
    this.#index(socket, previous.anchors, -1);
    void socket.leave(entityRoom(service, id, previous.level));
    const rows = ownRecord(socket.data.entities, service);
    if (rows !== undefined) {
      delete rows[id];
    }
    return previous;
  }

  /** A `qd:sub` batch of these rows begins; returns how often each was unsubscribed from so far. */
  begin(
    socket: QuickdrawServerSocket,
    service: string,
    ids: readonly string[],
  ): Map<string, number> {
    const counts = this.pending.begin(
      socket,
      ids.map((id) => anchorKey(service, id)),
    );
    return new Map(ids.map((id) => [id, counts.get(anchorKey(service, id)) ?? 0]));
  }

  /** The batch `begin` started has ended. */
  end(socket: QuickdrawServerSocket, service: string, ids: readonly string[]): void {
    this.pending.end(
      socket,
      ids.map((id) => anchorKey(service, id)),
    );
  }

  /** A client unsubscribed: forget its subscription, and stop one still being made from joining. */
  unsubscribe(socket: QuickdrawServerSocket, service: string, id: string): void {
    this.pending.unsubscribed(socket, anchorKey(service, id));
    this.delete(socket, service, id);
  }

  /** How often the client unsubscribed from the row while a batch of it ran; a batch joins only if that did not move. */
  unsubscribes(socket: QuickdrawServerSocket, service: string, id: string): number {
    return this.pending.count(socket, anchorKey(service, id));
  }

  /** A socket disconnected: Socket.IO has emptied its rooms; drop it from the index. */
  drop(socket: QuickdrawServerSocket): void {
    for (const { subscription } of this.entries(socket)) {
      this.#index(socket, subscription.anchors, -1);
    }
    socket.data.entities = emptyRecords();
  }

  /**
   * The subscriptions an access change can concern: those anchored on the
   * changed row (any row of the service when `id` is absent), of the changed
   * user's sockets (every user's when `userId` is absent).
   */
  matching(change: AccessChange): Map<QuickdrawServerSocket, SubscriptionEntry[]> {
    const key = change.id === undefined ? undefined : anchorKey(change.service, change.id);
    const sockets =
      key === undefined ? this.#byService.get(change.service) : this.#byAnchor.get(key);
    const found = new Map<QuickdrawServerSocket, SubscriptionEntry[]>();
    for (const socket of sockets?.keys() ?? []) {
      if (change.userId !== undefined && socket.data.principal?.userId !== change.userId) {
        continue;
      }
      const entries = [...this.entries(socket)].filter(({ subscription }) =>
        subscription.anchors.some((anchor) =>
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
