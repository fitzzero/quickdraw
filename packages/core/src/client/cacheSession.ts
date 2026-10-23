// Which user a cache holds data for, and what each `qd:hello` of a
// connection does to that cache (RFC 0003 sections 6, 8.1, 11.1 and 11.5).
// Method results, rows and items are cached as the user who read them was
// allowed to see them (fields above that user's tier included), and the
// server answers a version or revision the client holds "not modified" for
// anyone who may read the row. So the cache of one user is never shown to,
// nor sent on behalf of, another:
//
// - a hello naming another user than the cache was loaded for (`null`, an
//   anonymous socket, counts as a user) empties the cache (`empty`; for a
//   `QueryClient`, `session.ts`: every quickdraw query is removed and the
//   optimistic overlays are dropped), and the live data drops what it holds
//   and loads it again from scratch (`live/stores.ts`);
// - the first hello on new credentials naming the same user (a refreshed
//   token) keeps the cache and reads it again, as the new credentials
//   (`refresh`);
// - a hello after a reconnect with the same credentials changes nothing;
// - a session the server ends (its disconnect, or a connect or reconnect
//   refused with `UNAUTHENTICATED` or `FORBIDDEN`; the 5.1 audit's CLIENT-1),
//   data a server render prefetched included, empties the
//   cache as another user's hello does, and the cache is then loaded for
//   nobody: the hooks show nothing of what was cached, and the live data
//   loads from scratch once a hello names a user again. The session listens
//   to the socket's own events for this, so new credentials (`setAuth`),
//   which also clear the hello, still await the hello to decide. A connect
//   or reconnect refused `INTERNAL` (the server could not check the
//   credentials) does not end the session: the cache stays.
//
// The hooks and the live stores read nothing before the hello on the current
// credentials has arrived (`context.ts`, `query.ts`, `live/host.ts`), so no
// version or revision of the last user's data leaves the client first, and
// while new credentials await their hello the hooks show nothing of what is
// cached (`awaitingHelloOf`): no cache is removed until the hello decides, and
// a hello naming the same user shows it again. 4.1
// cleared nothing on a token change; 5.0's first cut refetched with the
// versions held, which the server answered "not modified" for the new user.
//
// A cache is named by an owner object (a `QueryClient`, `session.ts`): the
// user it was loaded for is kept per owner, and it has one session per
// connection.
//
// React-free, and TanStack-free.

import { isRecord } from "../protocol/guards";
import type { HelloFrame } from "../protocol/version";
import { isServerDisconnect, isSessionRefusal, type QuickdrawConnection } from "./connection";
import { notifyEach } from "./watch";

/** What a new `qd:hello`, or the end of the session, meant for the cache. */
export interface HelloChange {
  /**
   * It names another user than the cache was loaded for, or the server ended
   * the session: the cache was emptied.
   */
  readonly switched: boolean;
  /** No hello was held before it: the connection's first, or the first on new credentials. */
  readonly first: boolean;
}

/** The hellos of one connection, as they concern one cache. */
export interface CacheSession {
  /**
   * Calls `listener` after each new hello, once the cache is settled for the
   * user it names; returns the unsubscribe function.
   */
  onHello(listener: (change: HelloChange) => void): () => void;
}

/** What a session does to its cache. */
export interface SessionCache {
  /** Removes everything cached: a hello named another user, or the server ended the session. */
  empty(): void;
  /** Reads everything cached again: the first hello on new credentials named the same user. */
  refresh(): void;
}

/** The user each cache was loaded for (`null`: anonymous), by owner; absent before its first hello. */
const loadedFor = new WeakMap<object, { readonly userId: string | null }>();

const sessions = new WeakMap<QuickdrawConnection, WeakMap<object, CacheSession>>();

/**
 * True while new credentials await their hello on a connection whose cache
 * (named by `owner`) was loaded under the last ones (a hello settled it): the
 * hooks then show nothing of what is cached, since it may be another user's,
 * until the hello settles it (removed for another user, kept for the same
 * one). False before the connection's first hello, so data a server render
 * prefetched shows.
 */
export function awaitingHelloOf(connection: QuickdrawConnection, owner: object): boolean {
  return connection.getState().hello === null && loadedFor.has(owner);
}

/** The user a hello names: its `userId`, or `null` for an anonymous socket. */
export function userOf(hello: unknown): string | null {
  return isRecord(hello) && typeof hello.userId === "string" ? hello.userId : null;
}

/** Settles the cache `owner` names for the user `hello` names. */
function settle(
  owner: object,
  cache: SessionCache,
  hello: HelloFrame,
  first: boolean,
): HelloChange {
  const user = userOf(hello);
  const loaded = loadedFor.get(owner);
  loadedFor.set(owner, { userId: user });
  if (loaded !== undefined && loaded.userId !== user) {
    cache.empty();
    return { switched: true, first };
  }
  if (loaded !== undefined && first) {
    // The same user on new credentials: what is cached may stay, read again as them.
    cache.refresh();
  }
  return { switched: false, first };
}

function createSession(
  connection: QuickdrawConnection,
  owner: object,
  cache: SessionCache,
): CacheSession {
  const listeners = new Set<(change: HelloChange) => void>();
  let held = connection.getState().hello;
  if (held !== null) {
    settle(owner, cache, held, false);
  }
  connection.subscribe(() => {
    const next = connection.getState().hello;
    if (next === held) {
      return;
    }
    const first = held === null;
    held = next;
    if (next !== null) {
      const change = settle(owner, cache, next, first);
      notifyEach(listeners, (listener) => {
        listener(change);
      });
    }
  });
  // The server ended the session: nothing cached is anyone's any more.
  const end = (): void => {
    cache.empty();
    loadedFor.set(owner, { userId: null });
    notifyEach(listeners, (listener) => {
      listener({ switched: true, first: false });
    });
  };
  const { socket } = connection;
  socket.on("disconnect", (reason: unknown) => {
    if (isServerDisconnect(reason)) {
      end();
    }
  });
  socket.on("connect_error", (error: unknown) => {
    if (!socket.active && isRecord(error) && isSessionRefusal(error.data)) {
      end();
    }
  });
  return Object.freeze({
    onHello(listener: (change: HelloChange) => void): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  });
}

/**
 * The session of `connection` and the cache `owner` names, made on first use
 * and kept as long as the connection: from then on, every `qd:hello`
 * settles that cache for the user it names, through `cache`. Only the first
 * call's `cache` is kept: an owner has one cache.
 */
export function cacheSessionOf(
  connection: QuickdrawConnection,
  owner: object,
  cache: SessionCache,
): CacheSession {
  let byOwner = sessions.get(connection);
  if (byOwner === undefined) {
    byOwner = new WeakMap();
    sessions.set(connection, byOwner);
  }
  let session = byOwner.get(owner);
  if (session === undefined) {
    session = createSession(connection, owner, cache);
    byOwner.set(owner, session);
  }
  return session;
}
