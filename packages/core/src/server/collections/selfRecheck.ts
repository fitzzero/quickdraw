// What access changes do to self scopes whose items follow their service's
// policy (RFC 0003 section 4.4; the 5.1 audit's COLL-1, `selfAccess.ts`). A
// self scope records no anchors, so revocation cannot find it by row: it is
// found by service instead. S is the item service, P an `inherit` ancestor
// of S:
//
// | Change                       | What happens to self scopes of S                                 |
// |------------------------------|------------------------------------------------------------------|
// | `{ service: S, id }`         | nothing more: the same flush's deltas reach every self scope     |
// |                              | holding the row, and are checked                                 |
// | `{ service: S, id, userId }` | scope `userId`: `levelsFor` the row; below `access`, `removed`   |
// |                              | (a `via` scope that no longer links the row, or links it below   |
// |                              | its role rule, is left to the flush that removed or demoted the  |
// |                              | link, which sends the removal itself)                            |
// | `{ service: S }`             | every self scope of S: `reset`                                   |
// | `{ service: P, id, userId }` | scope `userId`: `reset`; the client loads it again, filtered     |
// | `{ service: P }`             | every self scope of S: `reset`                                   |
// | `{ service: P, id }`         | not checked again: its rows leave at their next write or at the  |
// |                              | list's next load, and no new data reaches the user meanwhile     |
// | grants reloaded              | that user's self scopes: `reset`                                 |
//
// Every change the table re-checks also raises the resume floor of the
// scopes it concerns (the user's scope, or every scope of the collection)
// past every revision taken so far, whether or not anyone subscribes to
// them here: a client that closed the list, or was offline, and resumes it
// later then reads a filtered page instead of keeping the rows it lost. A
// reload of grants raises it before it authorizes the user's scopes again.
// Frames go to this process's sockets only: a broadcast change reaches
// every node, and each re-checks its own. None of it throws: a lookup that
// fails is logged and its scope reset.

import type { AccessChange } from "../access/changes";
import { meetsLevel } from "../access/levels";
import { describeError } from "../pipeline/metrics";
import { currentRev, nextRev } from "../rev";
import type { QuickdrawServerSocket } from "../transports/types";
import { followsPolicy } from "./access";
import type { BoundCollection, CollectionHub } from "./bind";
import { groupOf, roomOf } from "./scopes";
import { ownersOf, stillLinked } from "./selfAccess";
import { sendFrame } from "./send";

type Io = NonNullable<CollectionHub["io"]>;

const SELF_COLLECTIONS = new WeakMap<CollectionHub, readonly BoundCollection[]>();

/** The served collections that follow a policy (`followsPolicy`), found once per hub. */
function selfCollections(hub: CollectionHub): readonly BoundCollection[] {
  let found = SELF_COLLECTIONS.get(hub);
  if (found === undefined) {
    found = [...hub.registry.services.values()].flatMap((service) =>
      [...service.collections.keys()].flatMap((name) => {
        const collection = hub.collections.routes.find(service.name, name);
        return collection !== undefined && followsPolicy(collection) ? [collection] : [];
      }),
    );
    SELF_COLLECTIONS.set(hub, found);
  }
  return found;
}

const POLICY_SERVICES = new WeakMap<CollectionHub, Map<string, ReadonlySet<string>>>();

/**
 * The names of `service` and of every service its policy asks through
 * `inherit`, transitively: an access change on any of them can change a
 * level on its rows. Found once per hub and service.
 */
function policyServices(
  hub: CollectionHub,
  service: BoundCollection["service"],
): ReadonlySet<string> {
  const known = POLICY_SERVICES.get(hub) ?? new Map<string, ReadonlySet<string>>();
  POLICY_SERVICES.set(hub, known);
  const kept = known.get(service.name);
  if (kept !== undefined) {
    return kept;
  }
  const names = new Set<string>();
  const pending = [service.name];
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (!names.has(name)) {
      names.add(name);
      const inherits = hub.registry.services.get(name)?.access?.reads.inherits ?? [];
      pending.push(...inherits.map((contract) => contract.name));
    }
  }
  known.set(service.name, names);
  return names;
}

/**
 * Makes a resume of the scopes a change concerns read a page: the scope of
 * `userId`, or every scope of the collection. Either floor goes past every
 * revision taken so far, so a client whose page is at the current one
 * (nothing written since) reads again too. A scope nobody here subscribes
 * to gets no frame of the change.
 */
function raiseFloor(hub: CollectionHub, collection: BoundCollection, userId?: string): void {
  const s = collection.service.name;
  if (userId === undefined) {
    hub.collections.buffer.skipAll(groupOf(s, collection.name));
    return;
  }
  // `reset`, not `skip`: the floor goes one past, and no revision nobody took is recorded.
  hub.collections.buffer.reset(roomOf({ s, c: collection.name, scope: userId }), currentRev());
}

function logFailure(hub: CollectionHub, collection: BoundCollection, error: unknown): void {
  hub.logger.error("Checking a self scope's rows again failed; the scope is reset", {
    category: "quickdraw.access",
    service: collection.service.name,
    collection: collection.name,
    error: describeError(error),
  });
}

/**
 * Sends `reset` to one self scope's sockets on this process, at a revision
 * claimed as reads claim one (this process's next when the cluster's
 * counter does not answer). Never throws.
 */
async function resetScope(
  hub: CollectionHub,
  io: Io,
  collection: BoundCollection,
  scope: string,
): Promise<void> {
  try {
    let rev: number;
    try {
      rev = await hub.revisions.claim();
    } catch (error) {
      logFailure(hub, collection, error);
      rev = nextRev();
    }
    sendFrame(hub, io, collection, scope, rev, [{ t: "reset" }], { local: true });
  } catch (error) {
    logFailure(hub, collection, error);
  }
}

/**
 * Sends `removed` for row `id` to one self scope when any of its owner's
 * principals here is below `access` on it, unless a `via` scope no longer
 * links it. Never throws: a failure resets the scope.
 */
async function removeUnreadable(
  hub: CollectionHub,
  io: Io,
  collection: BoundCollection,
  scope: string,
  id: string,
): Promise<void> {
  const s = collection.service.name;
  try {
    if (!(await stillLinked(hub, collection, scope, id))) {
      return;
    }
    const owners = ownersOf(io, roomOf({ s, c: collection.name, scope }), scope);
    const levels = await Promise.all(
      owners.map(async (owner) => await hub.policies.levelsFor(s, owner, [id])),
    );
    if (levels.some((of) => !meetsLevel(of.get(id), collection.access))) {
      const rev = await hub.revisions.claim();
      sendFrame(hub, io, collection, scope, rev, [{ t: "removed", id }], { local: true });
    }
  } catch (error) {
    logFailure(hub, collection, error);
    await resetScope(hub, io, collection, scope);
  }
}

/** The re-checks of one collection's self scopes subscribed here that `change` concerns. */
function recheckScopes(
  hub: CollectionHub,
  io: Io,
  collection: BoundCollection,
  change: AccessChange,
): Promise<void>[] {
  const own = change.service === collection.service.name ? change.id : undefined;
  return hub.collections.scopes
    .scopes(collection.service.name, collection.name)
    .filter((scope) => change.userId === undefined || scope === change.userId)
    .map((scope) =>
      own === undefined
        ? resetScope(hub, io, collection, scope)
        : removeUnreadable(hub, io, collection, scope, own),
    );
}

/**
 * What an access change does to self scopes (the table above): raises the
 * resume floor of those it concerns, and re-checks those subscribed on this
 * process. Never throws.
 */
export async function recheckSelf(hub: CollectionHub, change: AccessChange): Promise<void> {
  // A row's own access columns: the flush's deltas are checked (S), or a documented gap (P).
  if (change.id !== undefined && change.userId === undefined) {
    return;
  }
  const { io } = hub;
  const work: Promise<void>[] = [];
  for (const collection of selfCollections(hub)) {
    if (!policyServices(hub, collection.service).has(change.service)) {
      continue;
    }
    raiseFloor(hub, collection, change.userId);
    if (io !== undefined) {
      work.push(...recheckScopes(hub, io, collection, change));
    }
  }
  await Promise.all(work);
}

/** Makes a resume of every self scope of `userId` read a page: their grants are reloading. */
export function raiseSelfFloors(hub: CollectionHub, userId: string): void {
  for (const collection of selfCollections(hub)) {
    raiseFloor(hub, collection, userId);
  }
}

/**
 * A reload of `userId`'s grants: raises the resume floor of every self
 * scope of that user, and sends `reset` to the self scopes the user's
 * `sockets` here subscribe to, once per room. Never throws.
 */
export async function resetSelf(
  hub: CollectionHub,
  sockets: readonly QuickdrawServerSocket[],
  userId?: string,
): Promise<void> {
  if (userId !== undefined) {
    raiseSelfFloors(hub, userId);
  }
  const { io } = hub;
  if (io === undefined) {
    return;
  }
  const rooms = new Map<string, readonly [BoundCollection, string]>();
  for (const socket of sockets) {
    for (const subscription of hub.collections.scopes.entries(socket)) {
      const collection = hub.collections.routes.find(subscription.s, subscription.c);
      if (collection !== undefined && followsPolicy(collection)) {
        rooms.set(roomOf(subscription), [collection, subscription.scope]);
      }
    }
  }
  await Promise.all(
    [...rooms.values()].map(
      async ([collection, scope]) => await resetScope(hub, io, collection, scope),
    ),
  );
}
