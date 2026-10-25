// A script's live data (RFC 0003 section 11.5), on `./client/core`: the live
// stores of one connection (`stores.ts`), over a cache of their own
// (`memoryCache.ts`) instead of a TanStack `QueryClient`, for code that has
// neither React nor TanStack Query: a Node script, a CLI, a worker. It holds
// rows, collection scopes and stream feeds as the hooks do, and a script
// reads them through the holdings (`holdCollection.ts`, `holdEntity.ts`,
// `holdStream.ts`).
//
// - One per connection (`liveStoreOf`), as `liveDataOf` keeps one per
//   connection and `QueryClient`: two on one socket would unsubscribe each
//   other's rows and scopes. For the same reason a connection whose live
//   data a `QueryClient` holds (a provider's) takes no live store, and the
//   other way round (`owner.ts`).
// - It follows the connection as the hooks' live data does
//   (`followConnection`): what it holds is resumed on each connect once the
//   user is known, loaded again from scratch for another user, and its
//   timers stop when the connection closes. Make it before `open()`, so it
//   follows the first hello.
// - The session is the connection's cache session (`../cacheSession.ts`)
//   over this cache: another user's hello, or a session the server ended,
//   removes every entry, held or not, before the stores load what they hold
//   again, and while new credentials await their hello the holdings show
//   nothing of what is cached. The same user's new credentials read nothing
//   again; the stores resume what they hold on the connect.
// - No optimistic layer opens here: those open only through a mutation on a
//   `QueryClient` (`../optimisticCall.ts`), so the stores tell
//   `NO_LIVE_OVERLAYS`.
//
// React-free, and TanStack-free.

import { cacheSessionOf } from "../cacheSession";
import type { QuickdrawConnection } from "../connection";
import { listenToFrames } from "./demux";
import { NO_LIVE_OVERLAYS } from "./host";
import { createMemoryCache, type MemoryCache } from "./memoryCache";
import { claimLive } from "./owner";
import { createStores, followConnection, type LiveData } from "./stores";

/** A script's live data: the stores of `connection`, over a cache of their own. */
export interface LiveStore extends LiveData {
  /** The connection the store follows. */
  readonly connection: QuickdrawConnection;
}

const stores = new WeakMap<QuickdrawConnection, LiveStore>();
const caches = new WeakMap<LiveStore, MemoryCache>();

function createLiveStore(connection: QuickdrawConnection): LiveStore {
  const cache = createMemoryCache();
  const live = createStores({ connection, cache, overlays: NO_LIVE_OVERLAYS });
  listenToFrames(connection.socket, live);
  followConnection(
    connection,
    () =>
      cacheSessionOf(connection, cache, {
        empty: () => {
          cache.clear();
        },
        refresh: () => undefined,
      }),
    live,
  );
  const store: LiveStore = Object.freeze({ ...live, connection });
  caches.set(store, cache);
  return store;
}

/**
 * The live store of `connection`, made on first use and kept as long as the
 * connection: its rows, collection scopes and stream feeds, held through
 * `holdCollection`, `holdEntity` and `holdStream`. Make it before
 * `connection.open()`. Throws for a connection whose live data a
 * `QueryClient` holds (a `QuickdrawProvider`'s): the two would unsubscribe
 * each other's rows and scopes on the one socket.
 *
 * @example
 * const connection = createQuickdrawConnection({ url, auth: token });
 * const live = liveStoreOf(connection);
 * connection.open();
 */
export function liveStoreOf(connection: QuickdrawConnection): LiveStore {
  const made = stores.get(connection);
  if (made !== undefined) {
    return made;
  }
  claimLive(connection, "store");
  const store = createLiveStore(connection);
  stores.set(connection, store);
  return store;
}

/** The cache of `store`: what its holdings read and listen to. Not on `./client/core`. */
export function liveCacheOf(store: LiveStore): MemoryCache {
  const cache = caches.get(store);
  if (cache === undefined) {
    throw new TypeError("not a live store: make one with liveStoreOf(connection)");
  }
  return cache;
}
