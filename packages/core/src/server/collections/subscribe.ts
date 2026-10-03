// One `qd:col:sub` (RFC 0003 sections 4.3 and 7.3), in the order entity
// subscriptions go (`emit/subscribe.ts`). 4.1 joined the scope's room before
// reading (`legacy-src/server/collections.ts:155-158`) and answered an
// unknown collection and a denied scope alike. Here:
//
// 1. authorize the scope (`access.ts`): a denied scope is `FORBIDDEN`, and
//    nothing is read;
// 2. take the revision before any read: the last one taken (`currentRev`),
//    or a new one when the last is below the scope's resume floor (just
//    after a reset), so the client can resume from the page it gets;
// 3. with a cursor, read that page and answer it: paging never joins;
// 4. with `since`, when this process sees every change (no cluster adapter,
//    the change log on): join the scope's room, then answer the buffered
//    deltas since `since` when the buffer covers it. Joining first means a
//    change recorded after the buffer is read reaches the socket as a frame;
// 5. otherwise read the first page, then join;
// 6. settle two races: an access change while the subscribe ran authorizes
//    again (a denied scope leaves its room), and a flush that changed the
//    scope after the revision (its frame may have gone out before the join)
//    reads the page again, at a newer revision.

import type { CollectionSubscribeReply, Revision } from "../../protocol/envelope";
import { QuickdrawError } from "../../protocol/errors";
import { usableChangeLog } from "../emit/hub";
import { currentRev, nextRev } from "../rev";
import type { QuickdrawServerSocket } from "../transports/types";
import { authorizeScopes } from "./access";
import type { BoundCollection, CollectionHub } from "./bind";
import { groupOf, roomOf } from "./scopes";
import { readPage, type PageRequest } from "./snapshot";

/** A `qd:col:sub` frame, read. */
export interface ScopeRequest extends PageRequest {
  readonly s: string;
  readonly c: string;
  /** The revision the client holds the scope at. */
  readonly since?: Revision;
}

interface Attempt {
  readonly hub: CollectionHub;
  readonly storage: NonNullable<CollectionHub["storage"]>;
  readonly socket: QuickdrawServerSocket;
  readonly collection: BoundCollection;
  readonly principal: NonNullable<QuickdrawServerSocket["data"]["principal"]>;
  readonly request: ScopeRequest;
  readonly room: string;
  /** The access changes the process had seen when the subscribe began. */
  readonly accessChanges: number;
  /** How often the socket had unsubscribed from the scope when the subscribe began. */
  readonly unsubscribes: number;
  /** Whether this subscribe put the socket in the scope's room. */
  joined: boolean;
}

function forbidden(): QuickdrawError {
  return new QuickdrawError("FORBIDDEN", "Insufficient permissions");
}

/** The anchors of the scope, or `undefined` when the principal may not subscribe to it. */
async function anchorsOf(attempt: Attempt): Promise<readonly string[] | undefined> {
  const { hub, collection, principal, request } = attempt;
  const allowed = await authorizeScopes(hub, collection, principal, [request.scope]);
  return allowed.get(request.scope);
}

/** Joins the scope's room, unless the socket has gone or the client unsubscribed meanwhile. */
function join(attempt: Attempt, anchors: readonly string[]): void {
  const { hub, socket, request, room } = attempt;
  if (
    !socket.connected ||
    hub.collections.scopes.unsubscribes(socket, room) !== attempt.unsubscribes
  ) {
    return;
  }
  hub.collections.scopes.set(socket, { s: request.s, c: request.c, scope: request.scope, anchors });
  attempt.joined = true;
}

/** Step 6, first race: access changed while the subscribe ran, so the scope is authorized again. */
async function recheckAccess(attempt: Attempt): Promise<void> {
  const { hub, socket, room } = attempt;
  if (hub.subscriptions.accessChanges === attempt.accessChanges) {
    return;
  }
  const anchors = await anchorsOf(attempt);
  const current = hub.collections.scopes.get(socket, room);
  if (anchors === undefined) {
    hub.collections.scopes.delete(socket, room);
    attempt.joined = false;
    throw forbidden();
  }
  if (attempt.joined && current !== undefined) {
    hub.collections.scopes.set(socket, { ...current, anchors });
  }
}

/**
 * Step 2: the revision a page is read at. The last one taken, unless it is
 * below the scope's resume floor (a reset or a change nobody here received
 * was the last thing to happen): then a new one, so a client resuming from
 * the page is covered.
 */
function pageRev(attempt: Attempt): Revision {
  const { hub, request, room } = attempt;
  const rev = currentRev();
  const floor = hub.collections.buffer.floor(room, groupOf(request.s, request.c));
  return rev < floor ? nextRev() : rev;
}

/** Steps 4 to 6. */
async function answer(
  attempt: Attempt,
  anchors: readonly string[],
): Promise<CollectionSubscribeReply> {
  const { hub, storage, collection, request, room } = attempt;
  const group = groupOf(request.s, request.c);
  if (request.since !== undefined && usableChangeLog(hub) !== undefined) {
    join(attempt, anchors);
    const replay = hub.collections.buffer.since(room, request.since, group);
    if (replay !== undefined) {
      await recheckAccess(attempt);
      return { ok: true, resumed: true, rev: replay.rev, deltas: replay.deltas };
    }
  }
  const rev = pageRev(attempt);
  const page = await readPage(storage, collection, request, rev);
  join(attempt, anchors);
  await recheckAccess(attempt);
  if (attempt.joined && hub.collections.buffer.lastChange(room, group) > rev) {
    return await readPage(storage, collection, request, pageRev(attempt));
  }
  return page;
}

/**
 * Answers one `qd:col:sub` of a socket with a principal: a page, or the
 * deltas since `since`. Throws `FORBIDDEN` for a scope the principal may not
 * subscribe to, `VALIDATION` for a cursor of another collection, and the
 * error of a lookup or read that failed; a room the subscribe joined is then
 * left.
 */
export async function subscribeScope(
  hub: CollectionHub,
  socket: QuickdrawServerSocket,
  collection: BoundCollection,
  request: ScopeRequest,
): Promise<CollectionSubscribeReply> {
  const { principal } = socket.data;
  const { storage } = hub;
  if (principal === null || storage === undefined) {
    throw new TypeError("subscribeScope: the socket has no principal, or the hub no storage");
  }
  const room = roomOf(request);
  const attempt: Attempt = {
    hub,
    storage,
    socket,
    collection,
    principal,
    request,
    room,
    accessChanges: hub.subscriptions.accessChanges,
    unsubscribes: hub.collections.scopes.unsubscribes(socket, room),
    joined: false,
  };
  const anchors = await anchorsOf(attempt);
  if (anchors === undefined) {
    throw forbidden();
  }
  if (request.cursor !== undefined) {
    return await readPage(storage, collection, request, pageRev(attempt));
  }
  try {
    return await answer(attempt, anchors);
  } catch (error) {
    if (attempt.joined) {
      hub.collections.scopes.delete(socket, room);
    }
    throw error;
  }
}
