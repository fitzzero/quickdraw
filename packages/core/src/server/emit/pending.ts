// The subscribes and watches a socket has in flight (RFC 0003 sections 6, 7.3
// and 11.3), and how often its client unsubscribed from each while one ran.
// A subscribe reads before it joins, so an unsubscribe that arrives while it
// runs must stop its join: the subscribe notes the count when it begins and
// joins only if the count did not move. The count matters only while a
// subscribe of the key is in flight, so nothing is kept for any other key:
// a client unsubscribing from keys it never subscribed to costs no memory.

import type { QuickdrawServerSocket } from "../transports/types";

interface Pending {
  /** Subscribes of the key in flight. */
  running: number;
  /** Unsubscribes from the key since the first of them began. */
  unsubscribes: number;
}

/** In-flight subscribes per socket and key: a row (`anchorKey`), a scope's room or a topic's room. */
export class PendingKeys {
  readonly #sockets = new WeakMap<QuickdrawServerSocket, Map<string, Pending>>();

  /** A subscribe of `keys` begins; returns how often each was unsubscribed from so far. */
  begin(socket: QuickdrawServerSocket, keys: Iterable<string>): Map<string, number> {
    const pending = this.#sockets.get(socket) ?? new Map<string, Pending>();
    this.#sockets.set(socket, pending);
    const counts = new Map<string, number>();
    for (const key of new Set(keys)) {
      const entry = pending.get(key) ?? { running: 0, unsubscribes: 0 };
      entry.running += 1;
      pending.set(key, entry);
      counts.set(key, entry.unsubscribes);
    }
    return counts;
  }

  /** The subscribe of `keys` that `begin` started has ended. */
  end(socket: QuickdrawServerSocket, keys: Iterable<string>): void {
    const pending = this.#sockets.get(socket);
    if (pending === undefined) {
      return;
    }
    for (const key of new Set(keys)) {
      const entry = pending.get(key);
      if (entry === undefined) {
        continue;
      }
      entry.running -= 1;
      if (entry.running === 0) {
        pending.delete(key);
      }
    }
    if (pending.size === 0) {
      this.#sockets.delete(socket);
    }
  }

  /** The client unsubscribed from `key`: counted only while a subscribe of it is in flight. */
  unsubscribed(socket: QuickdrawServerSocket, key: string): void {
    const entry = this.#sockets.get(socket)?.get(key);
    if (entry !== undefined) {
      entry.unsubscribes += 1;
    }
  }

  /** How often the client unsubscribed from `key` while a subscribe of it was in flight. */
  count(socket: QuickdrawServerSocket, key: string): number {
    return this.#sockets.get(socket)?.get(key)?.unsubscribes ?? 0;
  }

  /** How many keys the socket has a subscribe in flight for. */
  size(socket: QuickdrawServerSocket): number {
    return this.#sockets.get(socket)?.size ?? 0;
  }
}
