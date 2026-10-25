// The cache session of a `QueryClient` (RFC 0003 sections 6, 8.1, 11.1 and
// 11.5): which user the client's cache holds data for, and what each
// `qd:hello` does to it, by the rules of `cacheSession.ts`. Emptying the
// cache removes every quickdraw query (method results, entity and collection
// entries, held or not, and the versions that come with them), takes
// quickdraw's mutations out of TanStack's mutation cache, and drops the
// optimistic overlays; the same user on new credentials refetches every
// quickdraw query, as them, and keeps their mutations.
//
// Quickdraw's mutations are those its mutation hooks make (marked
// `meta.qd`, whatever key their options give) and any keyed under
// `["qd", …]`. Another user's hello takes them out of the mutation cache. A
// session the server ended leaves them to its next hello, which keeps them
// when it names the same user, whose calls may still go out as them
// (`issuer.ts`), and takes them out when it names anyone else: taking a
// call out at the end would reorder its scope or lose its retry if that user
// comes back (below). The queries and overlays still go at the end.
//
// A mutation leaves the mutation cache at once, but one TanStack holds
// paused (offline, or queued behind another of its scope), which leaves the
// moment it settles: TanStack resumes only the paused mutations its cache
// holds, and runs a scope's next call only from its cache. One taken out
// while it runs runs on, out of the cache, and settles, and its callbacks
// run for the user who made it (`mutation.ts`): the hello that empties the
// cache refuses a call held for it, and any later attempt is refused
// (`issuer.ts`). A paused one is refused once it resumes; until then
// TanStack's `useIsMutating` and `useMutationState` still see it. One taken
// out that pauses later (offline when its retry, or its first attempt after
// an async `onMutate`, comes) is never resumed, as after
// `queryClient.clear()`: never sent, its ticket let go (`untilDead`), its
// callbacks not run.
//
// Pushes that say the user's access changed refetch what it may have
// changed, through the invalidation coordinator (`refetchOnAccessChanges`):
// new service grants (`qd:access`) every quickdraw query, and a revoked row
// or scope (`qd:revoked`) the method queries of its service.
//
// React-free: the provider makes the session of its connection and
// `QueryClient`, and the live data uses the same one.

import type { Mutation, MutationCache, QueryClient } from "@tanstack/react-query";
import { SERVER_EVENTS } from "../contract/names";
import { isName, isRecord } from "../protocol/guards";
import { awaitingHelloOf, cacheSessionOf, userOf, type CacheSession } from "./cacheSession";
import { endedSessionOf, type QuickdrawConnection } from "./connection";
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

/** Takes `mutation` out of `cache` the moment it settles, once every listener heard it settle. */
function dropOnceSettled(cache: MutationCache, mutation: Mutation): void {
  const stop = cache.subscribe((event) => {
    if (event.mutation !== mutation) {
      return;
    }
    const settled =
      event.type === "updated" &&
      (event.action.type === "success" || event.action.type === "error");
    if (settled || event.type === "removed") {
      stop();
    }
    if (settled) {
      queueMicrotask(() => {
        cache.remove(mutation);
      });
    }
  });
}

/** True for a mutation of quickdraw's: a mutation hook's (`meta.qd`), or one keyed under `["qd", …]`. */
function isQuickdraw(mutation: Mutation): boolean {
  return mutation.meta?.[KEY_ROOT] === true || mutation.options.mutationKey?.[0] === KEY_ROOT;
}

/**
 * Takes quickdraw's mutations out of `queryClient`'s mutation cache at once,
 * but a paused one, which goes the moment it settles (see the top of this
 * file). The app's own mutations stay.
 */
function dropMutations(queryClient: QueryClient): void {
  const cache = queryClient.getMutationCache();
  for (const mutation of cache.findAll({ predicate: isQuickdraw })) {
    if (mutation.state.isPaused) {
      dropOnceSettled(cache, mutation);
    } else {
      cache.remove(mutation);
    }
  }
}

/**
 * The session of `connection` and `queryClient`, made on first use and kept
 * as long as the connection: from then on, every `qd:hello` settles the
 * cache for the user it names. The provider makes it when it mounts; code
 * without React that caches through `queryClient` makes it before the
 * connection opens.
 */
export function sessionOf(connection: QuickdrawConnection, queryClient: QueryClient): CacheSession {
  // The user whose session the server ended, until the next hello: their mutations wait for it.
  let ended: { readonly user: string | null } | undefined;
  /** A hello: drops quickdraw's mutations for another user (`switched`) unless a session just ended. */
  const settleMutations = (switched: boolean): void => {
    const user = userOf(connection.getState().hello);
    if (ended === undefined ? switched : ended.user !== user) {
      dropMutations(queryClient);
    }
    ended = undefined;
  };
  return cacheSessionOf(connection, queryClient, {
    empty: () => {
      queryClient.removeQueries({ queryKey: [KEY_ROOT] });
      if (connection.getState().hello === null) {
        // The server ended the session (`cacheSession.ts`): its user may come back, and send them.
        ended ??= { user: userOf(endedSessionOf(connection)?.hello) };
      } else {
        settleMutations(true);
      }
      resetOverlays(queryClient);
    },
    refresh: () => {
      settleMutations(false);
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
