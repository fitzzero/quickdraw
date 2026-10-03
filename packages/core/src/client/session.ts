// Which user a `QueryClient`'s cache holds data for, and what each
// `qd:hello` does to that cache (RFC 0003 sections 6, 8.1, 11.1 and 11.5).
// Method results, rows and items are cached as the user who read them was
// allowed to see them (fields above that user's tier included), and the
// server answers a version or revision the client holds "not modified" for
// anyone who may read the row. So the cache of one user is never shown to,
// nor sent on behalf of, another:
//
// - a hello naming another user than the cache was loaded for (`null`, an
//   anonymous socket, counts as a user) empties the cache: every quickdraw
//   query is removed (method results, entity and collection entries, held or
//   not, and the versions that come with them), the optimistic overlays are
//   dropped, and the live data drops what it holds and loads it again from
//   scratch (`live/liveData.ts`);
// - the first hello on new credentials naming the same user (a refreshed
//   token) keeps the cache and refetches it, as the new credentials;
// - a hello after a reconnect with the same credentials changes nothing.
//
// The hooks and the live stores read nothing before the hello on the current
// credentials has arrived (`context.ts`, `query.ts`, `live/host.ts`), so no
// version or revision of the last user's data leaves the client first, and
// while new credentials await their hello the hooks show nothing of what is
// cached (`awaitingHello`): no cache is removed until the hello decides, and
// a hello naming the same user shows it again. 4.1
// cleared nothing on a token change; 5.0's first cut refetched with the
// versions held, which the server answered "not modified" for the new user.
//
// Pushes that say the user's access changed refetch what it may have
// changed, through the invalidation coordinator (`refetchOnAccessChanges`):
// new service grants (`qd:access`) every quickdraw query, and a revoked row
// or scope (`qd:revoked`) the method queries of its service.
//
// React-free: the provider makes the session of its connection and
// `QueryClient`, and the live data uses the same one.

import type { QueryClient } from "@tanstack/react-query";
import { SERVER_EVENTS } from "../contract/names";
import { isName, isRecord } from "../protocol/guards";
import type { HelloFrame } from "../protocol/version";
import type { QuickdrawConnection } from "./connection";
import type { InvalidationCoordinator } from "./coordinator";
import { KEY_ROOT, serviceKeyPrefix } from "./keys";
import { resetOverlays } from "./optimistic";
import { notifyEach } from "./watch";

/** What a new `qd:hello` meant for the cache. */
export interface HelloChange {
  /** It names another user than the cache was loaded for: the cache was emptied. */
  readonly switched: boolean;
  /** No hello was held before it: the connection's first, or the first on new credentials. */
  readonly first: boolean;
}

/** The hellos of one connection, as they concern the cache of one `QueryClient`. */
export interface CacheSession {
  /**
   * Calls `listener` after each new hello, once the cache is settled for the
   * user it names; returns the unsubscribe function.
   */
  onHello(listener: (change: HelloChange) => void): () => void;
}

/** The user each cache was loaded for (`null`: anonymous); absent before its first hello. */
const loadedFor = new WeakMap<QueryClient, { readonly userId: string | null }>();

const sessions = new WeakMap<QuickdrawConnection, WeakMap<QueryClient, CacheSession>>();

/**
 * True while new credentials await their hello on a connection whose cache
 * was loaded under the last ones (a hello settled it): the hooks then show
 * nothing of what is cached, since it may be another user's, until the hello
 * settles it (removed for another user, kept for the same one). False before
 * the connection's first hello, so data a server render prefetched shows.
 */
export function awaitingHello(connection: QuickdrawConnection, queryClient: QueryClient): boolean {
  return connection.getState().hello === null && loadedFor.has(queryClient);
}

/** The user a hello names: its `userId`, or `null` for an anonymous socket. */
export function userOf(hello: unknown): string | null {
  return isRecord(hello) && typeof hello.userId === "string" ? hello.userId : null;
}

/** Settles `queryClient`'s cache for the user `hello` names. */
function settle(queryClient: QueryClient, hello: HelloFrame, first: boolean): HelloChange {
  const user = userOf(hello);
  const loaded = loadedFor.get(queryClient);
  loadedFor.set(queryClient, { userId: user });
  if (loaded !== undefined && loaded.userId !== user) {
    queryClient.removeQueries({ queryKey: [KEY_ROOT] });
    resetOverlays(queryClient);
    return { switched: true, first };
  }
  if (loaded !== undefined && first) {
    // The same user on new credentials: what is cached may stay, read again as them.
    void queryClient.invalidateQueries({ queryKey: [KEY_ROOT] });
  }
  return { switched: false, first };
}

function createSession(connection: QuickdrawConnection, queryClient: QueryClient): CacheSession {
  const listeners = new Set<(change: HelloChange) => void>();
  let held = connection.getState().hello;
  if (held !== null) {
    settle(queryClient, held, false);
  }
  connection.subscribe(() => {
    const next = connection.getState().hello;
    if (next === held) {
      return;
    }
    const first = held === null;
    held = next;
    if (next !== null) {
      const change = settle(queryClient, next, first);
      notifyEach(listeners, (listener) => {
        listener(change);
      });
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
 * The session of `connection` and `queryClient`, made on first use and kept
 * as long as the connection: from then on, every `qd:hello` settles the
 * cache for the user it names. The provider makes it when it mounts; code
 * without React that caches through `queryClient` makes it before the
 * connection opens.
 */
export function sessionOf(connection: QuickdrawConnection, queryClient: QueryClient): CacheSession {
  let byClient = sessions.get(connection);
  if (byClient === undefined) {
    byClient = new WeakMap();
    sessions.set(connection, byClient);
  }
  let session = byClient.get(queryClient);
  if (session === undefined) {
    session = createSession(connection, queryClient);
    byClient.set(queryClient, session);
  }
  return session;
}

/**
 * Refetches, through `coordinator`, what a change of the user's access may
 * have changed: every quickdraw query when the server pushes new service
 * grants (`qd:access`), and the method queries of a service when it ends a
 * subscription of that service (`qd:revoked`: access to a row or a scope was
 * revoked, or its anchor deleted, so a method may refuse now what it served).
 * A query refused that way loses its cached result (`query.ts`). Returns the
 * function that stops; the provider runs it while it is mounted.
 */
export function refetchOnAccessChanges(
  connection: QuickdrawConnection,
  coordinator: InvalidationCoordinator,
): () => void {
  const { socket } = connection;
  const onAccess = (): void => {
    coordinator.invalidate([KEY_ROOT]);
  };
  const onRevoked = (frame: unknown): void => {
    if (isRecord(frame) && isName(frame.s)) {
      coordinator.invalidate([...serviceKeyPrefix(frame.s), "m"]);
    }
  };
  socket.on(SERVER_EVENTS.access, onAccess);
  socket.on(SERVER_EVENTS.revoked, onRevoked);
  return () => {
    socket.off(SERVER_EVENTS.access, onAccess);
    socket.off(SERVER_EVENTS.revoked, onRevoked);
  };
}
