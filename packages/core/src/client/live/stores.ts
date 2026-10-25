// The stores of one set of live data (RFC 0003 sections 6, 7 and 11.5), over
// the cache and overlays of a `LiveHost` (`host.ts`): the entity store, the
// collection hub, the stream feeds, the typed event handlers and the
// presence of app rooms, and what the connection's life does to them.
//
// - Every connect resumes what is held: rows are asked for again with the
//   revisions held, and scopes resume from the revision they hold. State is
//   kept across a disconnect (4.1 cleared it,
//   4.1 `src/client/QuickdrawProvider.tsx:326-330`).
// - Nothing is asked for before the server's hello on the connection's
//   current credentials has named the user (`host.ts`): on new credentials
//   the resume waits for it. When it names another user than the cache was
//   loaded for, the cache was emptied (`../cacheSession.ts`), and the state
//   held is dropped and loaded again from scratch: rows and items are shown
//   at the subscriber's access tier, and a "not modified" answer would keep
//   the last user's. A session the server ends is dropped the same way at
//   once, and loaded again once a hello names a user.
// - Closing the connection stops every timer they run (retries, reloads,
//   checks); the next connect resumes what is still held.
//
// React-free, and TanStack-free: `liveData.ts` makes them over a
// `QueryClient`.

import type { CacheSession } from "../cacheSession";
import type { QuickdrawConnection } from "../connection";
import { createCollectionHub, type CollectionHub } from "./collections";
import { createEntityStore, type EntityStore } from "./entityStore";
import { createEventBus, type EventBus } from "./events";
import type { LiveHost } from "./host";
import { createPresenceStore, type PresenceStore } from "./presence";
import { createStreamStore, type StreamStore } from "./streams";

/**
 * The live data of one connection and one cache (the hooks': a
 * `QueryClient`): entities, collections, stream feeds, typed event handlers,
 * and the presence of the app rooms its socket is in.
 */
export interface LiveData {
  readonly entities: EntityStore;
  readonly collections: CollectionHub;
  readonly streams: StreamStore;
  readonly events: EventBus;
  readonly presence: PresenceStore;
}

/** The stores of `host`; `presence` for the presence of app rooms, else a store of their own. */
export function createStores(host: LiveHost, presence?: PresenceStore): LiveData {
  return Object.freeze({
    entities: createEntityStore(host),
    collections: createCollectionHub(host),
    streams: createStreamStore(host),
    events: createEventBus(),
    presence: presence ?? createPresenceStore(),
  });
}

/**
 * Resumes what `live` holds on each connect, once the user is known; reloads
 * it all for another user; stops its timers when the connection closes.
 * `session` gives the session of the cache `live` keeps its state in: it is
 * called once, after the socket listeners here are on, so a session it makes
 * listens to the socket after them.
 */
export function followConnection(
  connection: QuickdrawConnection,
  session: () => CacheSession,
  live: LiveData,
): void {
  const resume = (): void => {
    live.entities.resume();
    live.collections.resume("connect");
    live.streams.resume();
  };
  connection.socket.on("connect", () => {
    // A hello held now is from the same credentials: the state was loaded for its user.
    if (connection.getState().hello !== null) {
      resume();
    }
  });
  connection.socket.on("disconnect", () => {
    // The server took the socket out of every app room with it.
    live.presence.clear();
  });
  session().onHello(({ switched, first }) => {
    if (switched) {
      live.entities.forget();
      live.collections.forget();
      live.streams.forget();
    } else if (first) {
      resume();
    }
  });
  connection.subscribe(() => {
    // Closed by the app: no retry, reload or check waits for a socket that is gone.
    if (connection.getState().status === "idle") {
      live.entities.stop();
      live.collections.stop();
      live.streams.stop();
    }
  });
}
