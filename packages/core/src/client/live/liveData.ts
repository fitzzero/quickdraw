// The live data of one connection and one `QueryClient` (RFC 0003 sections 6,
// 7 and 11.5): the entity store and the collection hub, the frame listeners
// that feed them (`demux.ts`), and what the connection's life does to them.
//
// - Every connect resumes what is held: rows are asked for again with the
//   revisions held, and scopes resume from the revision they hold. State is
//   kept across a disconnect (4.1 cleared it,
//   `legacy-src/client/QuickdrawProvider.tsx:326-330`).
// - Nothing is asked for before the server's hello on the connection's
//   current credentials has named the user (`host.ts`): on new credentials
//   the resume waits for it. When it names another user than the cache was
//   loaded for, the cache was emptied (`../session.ts`), and the state held
//   is dropped and loaded again from scratch: rows and items are shown at
//   the subscriber's access tier, and a "not modified" answer would keep the
//   last user's.
//
// Made for a connection and `QueryClient` pair when the provider mounts
// (before its socket connects, so no `qd:presence` frame is missed), or on
// first use by code without React, and kept as long as the connection: it
// holds nothing once its hooks are gone, and its listeners live on the
// connection's socket. Closing the connection stops every timer it runs
// (retries, reloads, checks); the next connect resumes what is still held.
//
// React-free.

import type { QueryClient } from "@tanstack/react-query";
import type { QuickdrawConnection } from "../connection";
import { overlaysOf } from "../optimistic";
import { sessionOf } from "../session";
import { createCollectionHub, type CollectionHub } from "./collections";
import { listenToFrames } from "./demux";
import { createEntityStore, type EntityStore } from "./entityStore";
import { createEventBus, type EventBus } from "./events";
import { createPresenceStore, type PresenceStore } from "./presence";
import { createStreamStore, type StreamStore } from "./streams";

/**
 * The live data of one connection and `QueryClient`: entities, collections,
 * stream feeds, typed event handlers, and the presence of the app rooms its
 * socket is in.
 */
export interface LiveData {
  readonly entities: EntityStore;
  readonly collections: CollectionHub;
  readonly streams: StreamStore;
  readonly events: EventBus;
  readonly presence: PresenceStore;
}

const lives = new WeakMap<QuickdrawConnection, WeakMap<QueryClient, LiveData>>();

/** Resumes what is held on each connect, once the user is known; reloads it all for another user. */
function followConnection(
  connection: QuickdrawConnection,
  queryClient: QueryClient,
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
  sessionOf(connection, queryClient).onHello(({ switched, first }) => {
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

function createLiveData(connection: QuickdrawConnection, queryClient: QueryClient): LiveData {
  const host = { connection, queryClient, overlays: overlaysOf(queryClient) };
  const live: LiveData = Object.freeze({
    entities: createEntityStore(host),
    collections: createCollectionHub(host),
    streams: createStreamStore(host),
    events: createEventBus(),
    presence: createPresenceStore(),
  });
  listenToFrames(connection.socket, live);
  followConnection(connection, queryClient, live);
  return live;
}

function livesOf(connection: QuickdrawConnection): WeakMap<QueryClient, LiveData> {
  let byClient = lives.get(connection);
  if (byClient === undefined) {
    byClient = new WeakMap();
    lives.set(connection, byClient);
  }
  return byClient;
}

/**
 * The live data of `connection` and `queryClient`, made on first use. The
 * hooks use it; code without React can too, holding rows and scopes through
 * its `entities` and `collections`.
 */
export function liveDataOf(connection: QuickdrawConnection, queryClient: QueryClient): LiveData {
  const byClient = livesOf(connection);
  let live = byClient.get(queryClient);
  if (live === undefined) {
    live = createLiveData(connection, queryClient);
    byClient.set(queryClient, live);
  }
  return live;
}

/**
 * The live data of a connection that never opens (a mock client's,
 * `../../testing/mockSession.tsx`): its stores, with no frame listener and
 * nothing following the connection, and `presence` in place of the store
 * frames feed, so `usePresence` shows what a test sets. It becomes what
 * `liveDataOf(connection, queryClient)` returns, so call it before anything
 * asks for that.
 */
export function inertLiveData(
  connection: QuickdrawConnection,
  queryClient: QueryClient,
  presence: PresenceStore,
): LiveData {
  const host = { connection, queryClient, overlays: overlaysOf(queryClient) };
  const live: LiveData = Object.freeze({
    entities: createEntityStore(host),
    collections: createCollectionHub(host),
    streams: createStreamStore(host),
    events: createEventBus(),
    presence,
  });
  livesOf(connection).set(queryClient, live);
  return live;
}
