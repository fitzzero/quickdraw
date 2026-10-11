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
// 6. settle the races: an access change while the subscribe ran (or a
//    replaced principal: new grants) authorizes again, with the socket's
//    principal as it is then, never the one the subscribe began with (the
//    5.1 audit's LIVE-1); another identity, or none, is denied, and a denied
//    scope leaves its room. A flush that changed the scope after the
//    revision (its frame may have gone out before the join) reads the page
//    again, at a newer revision. So does any access change in a self scope
//    whose items follow its service's policy (`selfAccess.ts`): the page was
//    filtered before the change, which found no subscription to re-check,
//    and is read again for the principal last authorized. Then, while access
//    keeps changing, the scope is authorized again, at most `MAX_RECHECKS`
//    times, and refused when its anchors were still moving. A subscription
//    the subscribe recorded and revocation ended meanwhile is `FORBIDDEN`.
//
// Every page of a self scope on a service with a policy, cursor pages too,
// is filtered by that policy for the subscriber (`selfAccess.ts`).
//
// A socket holds at most `MAX_SCOPES_PER_SOCKET` scopes (the 5.1 audit's
// COLL-4): one more is `CONFLICT`, checked before step 1 (no read) and again
// at the join, so subscribes running at once in the socket's lane cannot
// overshoot. A scope held already never counts again, and a cursor page,
// which joins nothing, is not checked.

import type {
  CollectionSnapshot,
  CollectionSubscribeReply,
  Revision,
} from "../../protocol/envelope";
import { QuickdrawError } from "../../protocol/errors";
import { usableChangeLog } from "../emit/hub";
import { MAX_RECHECKS } from "../emit/subscribe";
import { currentRev, nextRev } from "../rev";
import type { QuickdrawServerSocket } from "../transports/types";
import { authorizeScopes, followsPolicy, itemsWhere } from "./access";
import type { BoundCollection, CollectionHub } from "./bind";
import { groupOf, roomOf, type ScopeRequest, type ScopeSubscription } from "./scopes";
import { readPage } from "./snapshot";

export type { ScopeRequest } from "./scopes";

interface Attempt {
  readonly hub: CollectionHub;
  readonly storage: NonNullable<CollectionHub["storage"]>;
  readonly socket: QuickdrawServerSocket;
  readonly collection: BoundCollection;
  /** The principal the subscribe began with. */
  readonly principal: NonNullable<QuickdrawServerSocket["data"]["principal"]>;
  /** The socket's principal when the subscribe last authorized the scope: pages are filtered for it. */
  resolvedWith: NonNullable<QuickdrawServerSocket["data"]["principal"]>;
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

/** The anchors of the scope, or `undefined` when `principal` may not subscribe to it. */
async function anchorsOf(
  attempt: Attempt,
  principal: Attempt["principal"],
): Promise<readonly string[] | undefined> {
  const { hub, collection, request } = attempt;
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
  // Again at the join, so subscribes running at once cannot overshoot.
  hub.collections.scopes.checkRoom(socket, room);
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

/** True when access changed, or the socket's principal was replaced, since the subscribe last authorized the scope. */
function accessMoved(attempt: Attempt): boolean {
  return (
    attempt.hub.subscriptions.accessChanges !== attempt.checkedAt ||
    attempt.socket.data.principal !== attempt.resolvedWith
  );
}

/**
 * Step 6: access changed since the subscribe last authorized the scope, so
 * it is authorized again, with the socket's principal as it is now: the
 * same user's current grants; another identity, or none, is `FORBIDDEN`.
 */
async function recheckAccess(attempt: Attempt): Promise<void> {
  if (!accessMoved(attempt)) {
    return;
  }
  attempt.checkedAt = attempt.hub.subscriptions.accessChanges;
  attempt.moving = false;
  const now = attempt.socket.data.principal;
  if (now === null || now.userId !== attempt.principal.userId) {
    leave(attempt);
    throw forbidden();
  }
  attempt.resolvedWith = now;
  const anchors = await anchorsOf(attempt, now);
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

/**
 * A page of the scope at `rev`, filtered by the item service's policy in a
 * self scope that follows it, for the principal the scope was last
 * authorized with.
 */
async function pageOf(attempt: Attempt, rev: Revision): Promise<CollectionSnapshot> {
  const { hub, storage, collection, request, resolvedWith } = attempt;
  return await readPage(
    storage,
    collection,
    request,
    rev,
    await itemsWhere(hub, collection, resolvedWith),
  );
}

/** What the first page was read under: the access changes seen, and the principal it was filtered for. */
interface ReadUnder {
  readonly changes: number;
  readonly principal: Attempt["resolvedWith"];
}

/**
 * Step 6: the revision to read the page again at, or `undefined`: a flush
 * changed the scope after `rev` (`changedSince`), or, in a self scope that
 * follows its service's policy, access changed (or the principal the page
 * is filtered for) since the page was read.
 */
async function rereadAt(
  attempt: Attempt,
  rev: Revision,
  under: ReadUnder,
): Promise<Revision | undefined> {
  const changed = await changedSince(attempt, rev);
  if (changed !== undefined) {
    return changed;
  }
  const moved =
    attempt.hub.subscriptions.accessChanges !== under.changes ||
    attempt.resolvedWith !== under.principal;
  return moved && followsPolicy(attempt.collection) ? await pageRev(attempt) : undefined;
}

/** Steps 4 to 6. */
async function answer(
  attempt: Attempt,
  anchors: readonly string[],
): Promise<CollectionSubscribeReply> {
  const { hub, request, room } = attempt;
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
  const under: ReadUnder = {
    changes: hub.subscriptions.accessChanges,
    principal: attempt.resolvedWith,
  };
  const claimed = pageRev(attempt);
  const rev = typeof claimed === "number" ? claimed : await claimed;
  let page = await pageOf(attempt, rev);
  join(attempt, anchors);
  await recheckAccess(attempt);
  const again = attempt.record === undefined ? undefined : await rereadAt(attempt, rev, under);
  if (again !== undefined) {
    page = await pageOf(attempt, again);
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
  if (request.cursor === undefined) {
    // At most MAX_SCOPES_PER_SOCKET scopes a socket (paging joins none): refused before any read.
    hub.collections.scopes.checkRoom(socket, room);
  }
  const attempt: Attempt = {
    hub,
    storage,
    socket,
    collection,
    principal,
    resolvedWith: principal,
    request,
    room,
    checkedAt: hub.subscriptions.accessChanges,
    unsubscribes: hub.collections.scopes.begin(socket, room),
    record: undefined,
    moving: false,
  };
  try {
    const anchors = await anchorsOf(attempt, principal);
    if (anchors === undefined) {
      throw forbidden();
    }
    if (request.cursor !== undefined) {
      return await pageOf(attempt, await pageRev(attempt));
    }
    return await answer(attempt, anchors);
  } catch (error) {
    leave(attempt);
    throw error;
  } finally {
    hub.collections.scopes.end(socket, room);
  }
}
