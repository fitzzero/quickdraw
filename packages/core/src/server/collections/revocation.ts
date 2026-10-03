// Revoking collection subscriptions (RFC 0003 section 4.4), beside the
// entity revocation of `emit/revocation.ts`, which calls this on every access
// change it handles. Each scope subscription records the rows its access is
// derived from (its anchors); when a flush may have changed someone's level
// on one, the scopes anchored there are authorized again (`access.ts`), for
// the user the change names or for everyone, one engine call per socket and
// collection:
//
// - no longer allowed: the socket leaves the scope's room and gets
//   `qd:revoked { kind: "collection", reason: "access", s, c, scope }`;
// - the flush deleted the anchor row: left alone, since the collection sink
//   closes that scope next with `reason: "anchor-deleted"`;
// - a lookup that fails denies, as everywhere else.
//
// A changed `serviceAccess` re-authorizes every scope of the user's sockets.
// 4.1 left this to a hand-written `kickFromCollection`
// (`legacy-src/server/collections.ts:305-318`).

import { SERVER_EVENTS } from "../../contract/names";
import type { RevocationHook } from "../emit/revocation";
import { describeError } from "../pipeline/metrics";
import type { QuickdrawServerSocket } from "../transports/types";
import { authorizeScopes } from "./access";
import type { BoundCollection, CollectionHub } from "./bind";
import { roomOf, type ScopeSubscription } from "./scopes";

type Found = ReadonlyMap<QuickdrawServerSocket, readonly ScopeSubscription[]>;

/** The scopes the principal may still subscribe to, or `undefined` when the lookup failed. */
async function allowedScopes(
  hub: CollectionHub,
  socket: QuickdrawServerSocket,
  collection: BoundCollection | undefined,
  scopes: readonly string[],
): Promise<Map<string, readonly string[]> | undefined> {
  const { principal } = socket.data;
  if (principal === null || collection === undefined) {
    return undefined;
  }
  try {
    return await authorizeScopes(hub, collection, principal, scopes);
  } catch (error) {
    hub.logger.error("Authorizing subscribers' collection scopes again failed; they are revoked", {
      category: "quickdraw.access",
      service: collection.service.name,
      collection: collection.name,
      error: describeError(error),
    });
    return undefined;
  }
}

/** True when the flush deleted the scope's anchor row, whose own revocation goes out next. */
function anchorDeleted(
  hub: CollectionHub,
  collection: BoundCollection | undefined,
  scope: string,
): boolean {
  const anchor = collection?.anchorService;
  return anchor !== undefined && hub.changeLog.removed(anchor.name, scope);
}

/** Authorizes one socket's subscriptions to one collection again, and applies the answer. */
async function reauthorize(
  hub: CollectionHub,
  socket: QuickdrawServerSocket,
  subscriptions: readonly ScopeSubscription[],
): Promise<void> {
  const [first] = subscriptions;
  if (first === undefined) {
    return;
  }
  const collection = hub.collections.routes.find(first.s, first.c);
  const scopes = subscriptions.map(({ scope }) => scope);
  const allowed = await allowedScopes(hub, socket, collection, scopes);
  for (const subscription of subscriptions) {
    const room = roomOf(subscription);
    // Unsubscribed, subscribed again or authorized again meanwhile: that is newer than this.
    const current = hub.collections.scopes.get(socket, room) === subscription;
    if (!socket.connected || !current || anchorDeleted(hub, collection, subscription.scope)) {
      continue;
    }
    const anchors = allowed?.get(subscription.scope);
    if (anchors !== undefined) {
      hub.collections.scopes.set(socket, { ...subscription, anchors });
      continue;
    }
    hub.collections.scopes.delete(socket, room);
    const { s, c, scope } = subscription;
    socket.emit(SERVER_EVENTS.revoked, { kind: "collection", reason: "access", s, c, scope });
  }
}

/** Authorizes the given subscriptions again, one engine call per socket and collection. */
async function reauthorizeAll(hub: CollectionHub, found: Found): Promise<void> {
  const work: Promise<void>[] = [];
  for (const [socket, subscriptions] of found) {
    const byCollection = new Map<string, ScopeSubscription[]>();
    for (const subscription of subscriptions) {
      const key = `${subscription.s}\u0000${subscription.c}`;
      byCollection.set(key, [...(byCollection.get(key) ?? []), subscription]);
    }
    for (const own of byCollection.values()) {
      work.push(reauthorize(hub, socket, own));
    }
  }
  await Promise.all(work);
}

/** The collection half of a dispatcher's revocation. */
export function createScopeRevocation(hub: CollectionHub): RevocationHook {
  return Object.freeze({
    changed: async (change) => await reauthorizeAll(hub, hub.collections.scopes.matching(change)),
    regranted: async (sockets) =>
      await reauthorizeAll(
        hub,
        new Map(sockets.map((socket) => [socket, hub.collections.scopes.entries(socket)])),
      ),
  } satisfies RevocationHook);
}
