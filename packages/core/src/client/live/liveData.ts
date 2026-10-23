// The live data of one connection and one `QueryClient` (RFC 0003 sections 6,
// 7 and 11.5): its stores (`stores.ts`) over the client's cache
// (`queryCache.ts`) and optimistic overlays (`../optimistic.ts`), the frame
// listeners that feed them (`demux.ts`), and the cache session of the
// connection and client (`../session.ts`), which the stores follow.
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
import { storeOf } from "../optimistic";
import { sessionOf } from "../session";
import { listenToFrames } from "./demux";
import type { LiveHost } from "./host";
import type { PresenceStore } from "./presence";
import { queryCacheOf } from "./queryCache";
import { createStores, followConnection, type LiveData } from "./stores";

export type { LiveData } from "./stores";

const lives = new WeakMap<QuickdrawConnection, WeakMap<QueryClient, LiveData>>();

/** What the stores of `connection` and `queryClient` work with: the client's cache and overlays. */
function liveHostOf(connection: QuickdrawConnection, queryClient: QueryClient): LiveHost {
  return { connection, cache: queryCacheOf(queryClient), overlays: storeOf(queryClient) };
}

function createLiveData(connection: QuickdrawConnection, queryClient: QueryClient): LiveData {
  const live = createStores(liveHostOf(connection, queryClient));
  listenToFrames(connection.socket, live);
  followConnection(connection, () => sessionOf(connection, queryClient), live);
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
  const live = createStores(liveHostOf(connection, queryClient), presence);
  livesOf(connection).set(queryClient, live);
  return live;
}
