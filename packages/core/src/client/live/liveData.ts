// The live data of one connection and one `QueryClient` (RFC 0003 sections 6,
// 7 and 11.5): the entity store and the collection hub, the frame listeners
// that feed them (`demux.ts`), and what the connection's life does to them.
//
// - Every connect resumes what is held: rows are asked for again with the
//   revisions held, and scopes resume from the revision they hold. State is
//   kept across a disconnect (4.1 cleared it,
//   `legacy-src/client/QuickdrawProvider.tsx:326-330`).
// - When a `qd:hello` names another user than the one the state was loaded
//   for (new credentials), the state is dropped and loaded again from
//   scratch: rows and items are shown at the subscriber's access tier, and a
//   "not modified" answer would keep the last user's.
//
// Made on first use for a connection and `QueryClient` pair, by the hooks,
// and kept as long as the connection: it holds nothing once its hooks are
// gone, and its listeners live on the connection's socket.
//
// React-free.

import type { QueryClient } from "@tanstack/react-query";
import { isRecord } from "../../protocol/guards";
import type { QuickdrawConnection } from "../connection";
import { overlaysOf } from "../optimistic";
import { createCollectionHub, type CollectionHub } from "./collections";
import { listenToFrames } from "./demux";
import { createEntityStore, type EntityStore } from "./entityStore";

/** The live entities and collections of one connection and `QueryClient`. */
export interface LiveData {
  readonly entities: EntityStore;
  readonly collections: CollectionHub;
}

const lives = new WeakMap<QuickdrawConnection, WeakMap<QueryClient, LiveData>>();

/** The user a hello names: its `userId`, or `null` for an anonymous socket. */
function userOf(hello: unknown): string | null {
  return isRecord(hello) && typeof hello.userId === "string" ? hello.userId : null;
}

/** Drops and reloads everything when a hello names another user than the state was loaded for. */
function followUsers(connection: QuickdrawConnection, live: LiveData): void {
  let hello = connection.getState().hello;
  let loadedFor = hello === null ? undefined : userOf(hello);
  connection.subscribe(() => {
    const next = connection.getState().hello;
    if (next === hello) {
      return;
    }
    hello = next;
    if (next === null) {
      return;
    }
    const user = userOf(next);
    if (loadedFor !== undefined && user !== loadedFor) {
      live.entities.forget();
      live.collections.forget();
    }
    loadedFor = user;
  });
}

function createLiveData(connection: QuickdrawConnection, queryClient: QueryClient): LiveData {
  const host = { connection, queryClient, overlays: overlaysOf(queryClient) };
  const live: LiveData = Object.freeze({
    entities: createEntityStore(host),
    collections: createCollectionHub(host),
  });
  listenToFrames(connection.socket, live);
  connection.socket.on("connect", () => {
    live.entities.resume();
    live.collections.resume("connect");
  });
  followUsers(connection, live);
  return live;
}

/**
 * The live data of `connection` and `queryClient`, made on first use. The
 * hooks use it; code without React can too, holding rows and scopes through
 * its `entities` and `collections`.
 */
export function liveDataOf(connection: QuickdrawConnection, queryClient: QueryClient): LiveData {
  let byClient = lives.get(connection);
  if (byClient === undefined) {
    byClient = new WeakMap();
    lives.set(connection, byClient);
  }
  let live = byClient.get(queryClient);
  if (live === undefined) {
    live = createLiveData(connection, queryClient);
    byClient.set(queryClient, live);
  }
  return live;
}
