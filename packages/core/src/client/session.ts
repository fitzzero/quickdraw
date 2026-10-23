// The cache session of a `QueryClient` (RFC 0003 sections 6, 8.1, 11.1 and
// 11.5): which user the client's cache holds data for, and what each
// `qd:hello` does to it, by the rules of `cacheSession.ts`. Emptying the
// cache removes every quickdraw query (method results, entity and collection
// entries, held or not, and the versions that come with them) and drops the
// optimistic overlays; the same user on new credentials refetches every
// quickdraw query, as them.
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
import { awaitingHelloOf, cacheSessionOf, type CacheSession } from "./cacheSession";
import type { QuickdrawConnection } from "./connection";
import type { InvalidationCoordinator } from "./coordinator";
import { KEY_ROOT, serviceKeyPrefix } from "./keys";
import { resetOverlays } from "./optimistic";

export { userOf, type CacheSession, type HelloChange } from "./cacheSession";

/**
 * True while new credentials await their hello on a connection whose cache
 * was loaded under the last ones (a hello settled it): the hooks then show
 * nothing of what is cached, since it may be another user's, until the hello
 * settles it (removed for another user, kept for the same one). False before
 * the connection's first hello, so data a server render prefetched shows.
 */
export function awaitingHello(connection: QuickdrawConnection, queryClient: QueryClient): boolean {
  return awaitingHelloOf(connection, queryClient);
}

/**
 * The session of `connection` and `queryClient`, made on first use and kept
 * as long as the connection: from then on, every `qd:hello` settles the
 * cache for the user it names. The provider makes it when it mounts; code
 * without React that caches through `queryClient` makes it before the
 * connection opens.
 */
export function sessionOf(connection: QuickdrawConnection, queryClient: QueryClient): CacheSession {
  return cacheSessionOf(connection, queryClient, {
    empty: () => {
      queryClient.removeQueries({ queryKey: [KEY_ROOT] });
      resetOverlays(queryClient);
    },
    refresh: () => {
      void queryClient.invalidateQueries({ queryKey: [KEY_ROOT] });
    },
  });
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
