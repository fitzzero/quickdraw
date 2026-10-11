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
// - each flush checks the deltas it sends a self scope against its user's
//   level (`denyUnreadable`, here): a row below `access` goes out
//   `removed`, marked `denied`, so a cluster's read-time decision never
//   turns it back into an item (`deltas.ts`);
// - an access change re-checks the self scopes subscribed on this process,
//   and makes a resume of the others read a page (`selfRecheck.ts`).
//
// A flush decides for the scope's user: each distinct principal the user's
// sockets of this process in the scope's room carry (a row any of them may
// not read is removed for all), else `{ userId: scope }`, a principal that
// holds the user id only: no grants, kind, claims or app fields. Behind a
// cluster adapter the user's sockets may all be on other nodes, so a node
// often decides with that one. On one server a removal reveals nothing and
// reads nothing, so only the rows a frame carries are checked; behind a
// cluster a removal may be decided back into an item at the read, so it is
// checked too. At most 16 scopes are checked at once. A self scope on a
// service without a policy is unchanged: nothing decides its rows but the
// scope.

import { meetsLevel } from "../access/levels";
import type { Principal } from "../types";
import { followsPolicy } from "./access";
import type { BoundCollection, CollectionHub } from "./bind";
import type { ScopePlan } from "./deltas";

type Io = NonNullable<CollectionHub["io"]>;

/** How many self scopes one flush checks at once. */
const CONCURRENT_CHECKS = 16;

/** Two principals with the same data (functions left out) decide alike; one that cannot be written is its own. */
function principalKey(principal: Principal): string | Principal {
  try {
    const data = JSON.stringify(principal, (_key, value: unknown) =>
      typeof value === "function" ? undefined : value,
    );
    return data ?? principal;
  } catch {
    return principal;
  }
}

/**
 * The principals a flush decides a self scope's rows for: each distinct one
 * the scope's user's sockets of this process in its room carry, else
 * `{ userId: scope }`, which holds the user id only.
 */
export function ownersOf(io: Io, room: string, scope: string): Principal[] {
  const owners = new Map<string | Principal, Principal>();
  for (const socketId of io.sockets.adapter.rooms.get(room) ?? []) {
    const principal = io.sockets.sockets.get(socketId)?.data.principal;
    if (principal !== null && principal !== undefined && principal.userId === scope) {
      owners.set(principalKey(principal), principal);
    }
  }
  return owners.size === 0 ? [{ userId: scope }] : [...owners.values()];
}

/** Marks the deltas of one plan whose row some owner of the scope may not read. */
async function denyPlan(
  hub: Pick<CollectionHub, "policies">,
  io: Io,
  collection: BoundCollection,
  plan: ScopePlan,
  cluster: boolean,
): Promise<void> {
  const checked = (delta: ScopePlan["deltas"][number]): boolean => cluster || delta.t !== "removed";
  const ids = [...new Set(plan.deltas.filter(checked).map((delta) => delta.id))];
  const service = collection.service.name;
  const levels = await Promise.all(
    ownersOf(io, plan.room, plan.scope).map(
      async (owner) => await hub.policies.levelsFor(service, owner, ids),
    ),
  );
  for (const [index, delta] of plan.deltas.entries()) {
    const readable = levels.every((of) => meetsLevel(of.get(delta.id), collection.access));
    if (readable || !checked(delta)) {
      continue;
    }
    plan.deltas[index] =
      delta.t === "removed"
        ? { ...delta, denied: true }
        : { t: "removed", id: delta.id, denied: true };
  }
}

/**
 * Checks the deltas each plan sends a self scope against its user's level,
 * one batched `levelsFor` per scope and owner principal, 16 scopes at a
 * time: a row below the collection's `access` becomes `removed`, marked
 * `denied`. On one server (`cluster` false) a plan of removals alone is not
 * checked. Nothing for a collection that does not follow a policy
 * (`followsPolicy`). A plan that resets is left alone: its clients load the
 * scope again, filtered. A lookup that fails rejects, and the flush resets
 * the scopes it touched.
 */
export async function denyUnreadable(
  hub: Pick<CollectionHub, "policies">,
  io: Io,
  collection: BoundCollection,
  plans: readonly ScopePlan[],
  cluster = false,
): Promise<void> {
  if (!followsPolicy(collection)) {
    return;
  }
  const checked = plans.filter(
    (plan) => !plan.reset && plan.deltas.some((delta) => cluster || delta.t !== "removed"),
  );
  for (let start = 0; start < checked.length; start += CONCURRENT_CHECKS) {
    const batch = checked.slice(start, start + CONCURRENT_CHECKS);
    await Promise.all(
      batch.map(async (plan) => await denyPlan(hub, io, collection, plan, cluster)),
    );
  }
}
