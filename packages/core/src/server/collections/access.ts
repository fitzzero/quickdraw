// Who may subscribe to a collection scope (RFC 0003 sections 4.3 and 7.1),
// decided as the `{ scope: access, of: anchor, id: scope }` method form is
// decided (`access/engine.ts`): a service-wide `Admin` grant on the
// collection's own service passes while it keeps `adminBypass`; otherwise
// the anchor's policy must give the principal at least the collection's
// `access` level (default `Read`) on the anchor row, and grants on the
// anchor's service do not count, as they do not flow through `inherit`. A
// missing anchor row has no level, so it is `FORBIDDEN` unless the grant
// passes. A `"self"` scope passes when it is the principal's own user id.
// 4.1 asked each collection's `checkScopeAccess` (`legacy-src/server/collections.ts:45-49`).

import { meetsLevel, serviceGrant } from "../access/levels";
import { anchorKey } from "../access/tools";
import type { Principal } from "../types";
import type { BoundCollection, CollectionHub } from "./bind";

/**
 * The scopes of `scopes` the principal may subscribe to, each with the rows
 * its access is derived from (its anchors): the anchor row and its `inherit`
 * parents, none for a `"self"` scope. One engine call; a lookup that fails
 * rejects.
 */
export async function authorizeScopes(
  hub: CollectionHub,
  collection: BoundCollection,
  principal: Principal,
  scopes: readonly string[],
): Promise<Map<string, readonly string[]>> {
  const allowed = new Map<string, readonly string[]>();
  const { anchorService, service } = collection;
  const anchorRow = (scope: string): readonly string[] =>
    anchorService === undefined ? [] : [anchorKey(anchorService.name, scope)];
  if (service.adminBypass && serviceGrant(principal, service.name) === "Admin") {
    for (const scope of scopes) {
      allowed.set(scope, anchorRow(scope));
    }
    return allowed;
  }
  if (anchorService === undefined) {
    for (const scope of scopes.filter((candidate) => candidate === principal.userId)) {
      allowed.set(scope, []);
    }
    return allowed;
  }
  const access = await hub.policies.resolve(anchorService.name, principal, scopes, {
    grants: false,
  });
  for (const scope of scopes) {
    if (meetsLevel(access.levels.get(scope), collection.access)) {
      allowed.set(scope, access.anchors.get(scope) ?? anchorRow(scope));
    }
  }
  return allowed;
}
