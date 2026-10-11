// A self scope's items follow the item service's row policy (RFC 0003
// sections 4.3, 4.4 and 7.1; the 5.1 audit's COLL-1). A `scopeAccess:
// "self"` scope is its user's to open (`access.ts`): its value is the
// subscriber's own user id. Its items were every row whose scope column (or
// junction) named that user, whatever the item service's policy said, so a
// task still assigned to a user removed from its project kept reaching them,
// title and all. On a service with an access policy, a self scope's items
// are the rows the policy gives its user at least the collection's `access`:
//
// - pages, the first page's index, cursor pages and `qd:col:items` AND the
//   service's `accessWhere(principal, access)` into their reads, for the
//   subscriber's principal (`itemsWhere` in `access.ts`, beside
//   `followsPolicy`, which says which collections this is);
// - each flush checks the deltas it sends a self scope with one batched
//   `levelsFor` for the scope's user (`denyUnreadable`): a row below
//   `access` goes out `removed`, marked `denied`, so a cluster's read-time
//   decision never turns it back into an item (`deltas.ts`);
// - an access change reaches the self scopes subscribed on this process (S
//   is the item service, P an `inherit` ancestor of S):
//
// | Change                       | What happens to self scopes of S                                 |
// |------------------------------|------------------------------------------------------------------|
// | `{ service: S, id }`         | nothing more: the same flush's deltas reach every self scope     |
// |                              | holding the row, and are checked                                 |
// | `{ service: S, id, userId }` | scope `userId`: `levelsFor` the row; below `access`, `removed`   |
// |                              | (a `via` scope that no longer links the row is left to the flush |
// |                              | that removed the link, which sends the removal itself)           |
// | `{ service: S }`             | every self scope of S: `reset`                                   |
// | `{ service: P, id, userId }` | scope `userId`: `reset`; the client loads it again, filtered     |
// | `{ service: P }`             | every self scope of S: `reset`                                   |
// | `{ service: P, id }`         | not checked again: its rows leave at their next write or at the  |
// |                              | list's next load, and no new data reaches the user meanwhile     |
// | grants reloaded              | that user's self scopes: `reset`                                 |
//
// A flush decides for the scope's user: the principal of a socket of this
// process in the scope's room whose user is the scope, else `{ userId:
// scope }`, which carries no grants (behind a cluster adapter the user's
// sockets may all be on other nodes). The frames of re-checks go to this
// process's sockets only: a broadcast change reaches every node, and each
// re-checks its own. A self scope on a service without a policy is
// unchanged: nothing decides its rows but the scope.

import type { AccessChange } from "../access/changes";
import { meetsLevel } from "../access/levels";
import { describeError } from "../pipeline/metrics";
import type { QuickdrawServerSocket } from "../transports/types";
import type { Principal } from "../types";
import { followsPolicy } from "./access";
import type { BoundCollection, CollectionHub } from "./bind";
import type { ScopePlan } from "./deltas";
import { roomOf } from "./scopes";
import { sendFrame } from "./send";

type Io = NonNullable<CollectionHub["io"]>;

/**
 * The principal a flush decides a self scope's rows for: the scope's user,
 * as a socket of this process in the scope's room carries it, else
 * `{ userId: scope }`, without grants.
 */
export function ownerOf(io: Io, room: string, scope: string): Principal {
  for (const socketId of io.sockets.adapter.rooms.get(room) ?? []) {
    const principal = io.sockets.sockets.get(socketId)?.data.principal;
    if (principal !== null && principal !== undefined && principal.userId === scope) {
      return principal;
    }
  }
  return { userId: scope };
}

/**
 * Checks the deltas each plan sends a self scope against its user's level,
 * one `levelsFor` per scope, in parallel: a row below the collection's
 * `access` becomes `removed`, marked `denied`. Nothing for a collection that
 * does not follow a policy (`followsPolicy`). A plan that resets is left
 * alone: its clients load the scope again, filtered. A lookup that fails
 * rejects, and the flush resets the scopes it touched.
 */
export async function denyUnreadable(
  hub: Pick<CollectionHub, "policies">,
  io: Io,
  collection: BoundCollection,
  plans: readonly ScopePlan[],
): Promise<void> {
  if (!followsPolicy(collection)) {
    return;
  }
  const checked = plans.filter((plan) => !plan.reset && plan.deltas.length > 0);
  await Promise.all(
    checked.map(async (plan) => {
      const ids = [...new Set(plan.deltas.map((delta) => delta.id))];
      const owner = ownerOf(io, plan.room, plan.scope);
      const levels = await hub.policies.levelsFor(collection.service.name, owner, ids);
      for (const [index, delta] of plan.deltas.entries()) {
        if (!meetsLevel(levels.get(delta.id), collection.access)) {
          plan.deltas[index] =
            delta.t === "removed"
              ? { ...delta, denied: true }
              : { t: "removed", id: delta.id, denied: true };
        }
      }
    }),
  );
}

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

function logFailure(hub: CollectionHub, collection: BoundCollection, error: unknown): void {
  hub.logger.error("Checking a self scope's rows again failed; the scope is reset", {
    category: "quickdraw.access",
    service: collection.service.name,
    collection: collection.name,
    error: describeError(error),
  });
}

/** Sends `reset` to one self scope's sockets on this process. Never throws. */
async function resetScope(
  hub: CollectionHub,
  io: Io,
  collection: BoundCollection,
  scope: string,
): Promise<void> {
  try {
    const rev = await hub.revisions.claim();
    sendFrame(hub, io, collection, scope, rev, [{ t: "reset" }], { local: true });
  } catch (error) {
    logFailure(hub, collection, error);
  }
}

/**
 * False when a `via` scope's junction no longer links row `id` to `scope`:
 * the flush that removed the link sends the row's removal itself (a member
 * removed from a project, in a list of their projects through the very
 * membership table). True for a column scope, whose row is not read.
 */
async function stillLinked(
  hub: CollectionHub,
  collection: BoundCollection,
  scope: string,
  id: string,
): Promise<boolean> {
  if (collection.scope.kind !== "via" || hub.storage === undefined) {
    return true;
  }
  const { model, entry, scope: column } = collection.scope;
  const links = await hub.storage.findMany(model, {
    where: { [column]: scope, [entry]: id },
    select: { [entry]: true },
    take: 1,
  });
  return links.length > 0;
}

/**
 * Sends `removed` for row `id` to one self scope when its user is below
 * `access` on it, unless a `via` scope no longer links it. Never throws.
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
    const owner = ownerOf(io, roomOf({ s, c: collection.name, scope }), scope);
    const levels = await hub.policies.levelsFor(s, owner, [id]);
    if (!meetsLevel(levels.get(id), collection.access)) {
      const rev = await hub.revisions.claim();
      sendFrame(hub, io, collection, scope, rev, [{ t: "removed", id }], { local: true });
    }
  } catch (error) {
    logFailure(hub, collection, error);
    await resetScope(hub, io, collection, scope);
  }
}

/**
 * What an access change does to the self scopes subscribed on this process
 * (the table above). Never throws: a lookup that fails is logged, and its
 * scope reset.
 */
export async function recheckSelf(hub: CollectionHub, change: AccessChange): Promise<void> {
  const { io } = hub;
  // A row's own access columns: the flush's deltas are checked (S), or a documented gap (P).
  if (io === undefined || (change.id !== undefined && change.userId === undefined)) {
    return;
  }
  const work: Promise<void>[] = [];
  for (const collection of selfCollections(hub)) {
    if (!policyServices(hub, collection.service).has(change.service)) {
      continue;
    }
    const own = change.service === collection.service.name ? change.id : undefined;
    const scopes = hub.collections.scopes
      .scopes(collection.service.name, collection.name)
      .filter((scope) => change.userId === undefined || scope === change.userId);
    for (const scope of scopes) {
      work.push(
        own === undefined
          ? resetScope(hub, io, collection, scope)
          : removeUnreadable(hub, io, collection, scope, own),
      );
    }
  }
  await Promise.all(work);
}

/**
 * Sends `reset` to the self scopes these sockets subscribe to, once per
 * room: their user's grants were reloaded. Never throws.
 */
export async function resetSelf(
  hub: CollectionHub,
  sockets: readonly QuickdrawServerSocket[],
): Promise<void> {
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
