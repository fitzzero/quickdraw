// One `qd:col:sub` (RFC 0003 sections 4.3 and 7.3), in the order entity
// subscriptions go (`emit/subscribe.ts`). 4.1 joined the scope's room before
// reading (4.1 `src/server/collections.ts:155-158`) and answered an
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
// 6. settle the races: an access change while the subscribe ran authorizes
//    again (a denied scope leaves its room), and a flush that changed the
//    scope after the revision (its frame may have gone out before the join)
//    reads the page again, at a newer revision. Then, while access keeps
//    changing, the scope is authorized again, at most `MAX_RECHECKS` times,
//    and refused when its anchors were still moving. A subscription the
//    subscribe recorded and revocation ended meanwhile is `FORBIDDEN`.

import type { CollectionSubscribeReply, Revision } from "../../protocol/envelope";
import { QuickdrawError } from "../../protocol/errors";
import { usableChangeLog } from "../emit/hub";
import { MAX_RECHECKS } from "../emit/subscribe";
import { currentRev, nextRev } from "../rev";
import type { QuickdrawServerSocket } from "../transports/types";
import { authorizeScopes } from "./access";
import type { BoundCollection, CollectionHub } from "./bind";
import { groupOf, roomOf, type ScopeSubscription } from "./scopes";
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
  /** The access changes the process had seen when the subscribe last authorized the scope. */
  checkedAt: number;
  /** How often the socket had unsubscribed from the scope when the subscribe began. */
  readonly unsubscribes: number;
  /** The subscription this subscribe recorded, while it manages it. */
  record: ScopeSubscription | undefined;
  /** Whether the last recheck gave the scope new anchors. */
  moving: boolean;
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

/** True while the socket's subscription to the scope is still the one this subscribe recorded. */
function isOwn(attempt: Attempt): boolean {
  const { hub, socket, room, record } = attempt;
  return record !== undefined && hub.collections.scopes.get(socket, room) === record;
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
  const record: ScopeSubscription = { s: request.s, c: request.c, scope: request.scope, anchors };
  hub.collections.scopes.set(socket, record);
  attempt.record = record;
}

/** Ends the subscription this subscribe made; another's is left alone. */
function leave(attempt: Attempt): void {
  if (isOwn(attempt)) {
    attempt.hub.collections.scopes.delete(attempt.socket, attempt.room);
  }
  attempt.record = undefined;
}

/**
 * The subscription this subscribe recorded is no longer the socket's: ended
 * by revocation (or a disconnect), which is `FORBIDDEN` unless the client
 * unsubscribed, or replaced by a newer authorization, which stands.
 */
function releaseTaken(attempt: Attempt): void {
  if (attempt.record === undefined || isOwn(attempt)) {
    return;
  }
  const { hub, socket, room } = attempt;
  attempt.record = undefined;
  const ended = hub.collections.scopes.get(socket, room) === undefined;
  if (ended && hub.collections.scopes.unsubscribes(socket, room) === attempt.unsubscribes) {
    throw forbidden();
  }
}

function sameAnchors(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((anchor, index) => anchor === b[index]);
}

/** True when access changed since the subscribe last authorized the scope. */
function accessMoved(attempt: Attempt): boolean {
  return attempt.hub.subscriptions.accessChanges !== attempt.checkedAt;
}

/** Step 6: access changed since the subscribe last authorized the scope, so it is authorized again. */
async function recheckAccess(attempt: Attempt): Promise<void> {
  if (!accessMoved(attempt)) {
    return;
  }
  attempt.checkedAt = attempt.hub.subscriptions.accessChanges;
  attempt.moving = false;
  const anchors = await anchorsOf(attempt);
  if (anchors === undefined) {
    leave(attempt);
    throw forbidden();
  }
  releaseTaken(attempt);
  const { record } = attempt;
  if (record !== undefined && !sameAnchors(record.anchors, anchors)) {
    const moved: ScopeSubscription = { ...record, anchors };
    attempt.hub.collections.scopes.set(attempt.socket, moved);
    attempt.record = moved;
    attempt.moving = true;
  }
}

/** Step 6, once the reads are done: authorize again while access keeps changing, at most `MAX_RECHECKS` times. */
async function settleRaces(attempt: Attempt): Promise<void> {
  for (let round = 0; round < MAX_RECHECKS && accessMoved(attempt); round += 1) {
    await recheckAccess(attempt);
  }
  if (accessMoved(attempt) && attempt.moving) {
    // Access changed during the last check too, and the scope's anchors moved: they may have missed it.
    leave(attempt);
    throw forbidden();
  }
  releaseTaken(attempt);
}

/**
 * Step 2: the revision a page is read at. The last one taken, unless it is
 * below the scope's resume floor (a reset or a change nobody here received
 * was the last thing to happen): then a new one, so a client resuming from
 * the page is covered. Behind a cluster's counter, the counter's last one:
 * a resume there always reads a page, and the floor is this process's.
 */
function pageRev(attempt: Attempt): Revision | Promise<Revision> {
  const { hub, request, room } = attempt;
  if (hub.revisions.shared()) {
    return hub.revisions.claim();
  }
  const rev = currentRev();
  const floor = hub.collections.buffer.floor(room, groupOf(request.s, request.c));
  return rev < floor ? nextRev() : rev;
}

/**
 * Step 6: the revision to read the page again at when a flush changed the
 * scope after `rev` (its frame may have gone out before the join), or
 * `undefined`. This process's buffer knows its own flushes only, so behind
 * a cluster's counter any revision any node took after `rev` counts.
 */
async function changedSince(attempt: Attempt, rev: Revision): Promise<Revision | undefined> {
  const { hub, request, room } = attempt;
  if (hub.revisions.shared()) {
    return await hub.revisions.movedPast(rev);
  }
  return hub.collections.buffer.lastChange(room, groupOf(request.s, request.c)) > rev
    ? pageRev(attempt)
    : undefined;
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
      await settleRaces(attempt);
      return { ok: true, resumed: true, rev: replay.rev, deltas: replay.deltas };
    }
  }
  const claimed = pageRev(attempt);
  const rev = typeof claimed === "number" ? claimed : await claimed;
  let page = await readPage(storage, collection, request, rev);
  join(attempt, anchors);
  await recheckAccess(attempt);
  const again = attempt.record === undefined ? undefined : await changedSince(attempt, rev);
  if (again !== undefined) {
    page = await readPage(storage, collection, request, again);
  }
  await settleRaces(attempt);
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
    checkedAt: hub.subscriptions.accessChanges,
    unsubscribes: hub.collections.scopes.begin(socket, room),
    record: undefined,
    moving: false,
  };
  try {
    const anchors = await anchorsOf(attempt);
    if (anchors === undefined) {
      throw forbidden();
    }
    if (request.cursor !== undefined) {
      return await readPage(storage, collection, request, await pageRev(attempt));
    }
    return await answer(attempt, anchors);
  } catch (error) {
    leave(attempt);
    throw error;
  } finally {
    hub.collections.scopes.end(socket, room);
  }
}
