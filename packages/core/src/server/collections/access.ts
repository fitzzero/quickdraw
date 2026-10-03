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
//
// A change topic (RFC 0003 section 11.3) is watched on the same terms: a
// collection scope's topic exactly as a subscribe to that scope, and a
// service's topic by the service's `watchAccess`, closed to everyone when
// the service declares none.

import { QuickdrawError } from "../../protocol/errors";
import { meetsLevel, serviceGrant } from "../access/levels";
import { anchorKey } from "../access/tools";
import type { Principal } from "../types";
import type { BoundCollection, CollectionHub } from "./bind";

/** What a `qd:watch` names: a service's topic, or the topic of one scope of a collection. */
export type WatchTarget =
  | { readonly kind: "service"; readonly service: BoundCollection["service"] }
  | {
      readonly kind: "collection";
      readonly collection: BoundCollection;
      readonly scope: string;
    };

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

/** True when the service's `watchAccess` lets the principal watch its topic; never without one. */
function mayWatchService(service: BoundCollection["service"], principal: Principal): boolean {
  const form = service.watchAccess;
  if (form === undefined) {
    return false;
  }
  if (form === "public" || form === "authenticated") {
    return true;
  }
  return meetsLevel(serviceGrant(principal, service.name), form.service);
}

/**
 * Authorizes a watch of `target` by `principal` (`null` when anonymous): a
 * collection scope's topic as a subscribe to that scope, and a service's
 * topic by its `watchAccess`. Resolves with the rows a scope's access is
 * derived from (its anchors; none for the service topic). Throws
 * `UNAUTHENTICATED` or `FORBIDDEN`; a lookup that fails rejects.
 */
export async function authorizeWatch(
  hub: CollectionHub,
  principal: Principal | null,
  target: WatchTarget,
): Promise<readonly string[]> {
  if (target.kind === "service" && target.service.watchAccess === undefined) {
    throw new QuickdrawError(
      "FORBIDDEN",
      `${target.service.name} keeps its service topic closed: it declares no watchAccess`,
    );
  }
  if (target.kind === "service" && target.service.watchAccess === "public") {
    return [];
  }
  if (principal === null) {
    throw new QuickdrawError("UNAUTHENTICATED", "Authentication required");
  }
  const anchors =
    target.kind === "service"
      ? mayWatchService(target.service, principal)
        ? []
        : undefined
      : (await authorizeScopes(hub, target.collection, principal, [target.scope])).get(
          target.scope,
        );
  if (anchors === undefined) {
    throw new QuickdrawError("FORBIDDEN", "Insufficient permissions");
  }
  return anchors;
}
