// A subscriber's level on rows, and what it is derived from (RFC 0003
// sections 4.3 and 4.4): the service's policy through the dispatcher's
// engine, counted as `dispatcher.access.levelsFor` counts it, with the rows
// each level is anchored on. A service without a policy has no row levels:
// only a service-wide `Admin` grant (with `adminBypass`) reaches its rows.

import type { AccessLevel } from "../../contract/access";
import type { ResolvedAccess } from "../access/api";
import { meetsLevel, serviceGrant } from "../access/levels";
import { anchorKey } from "../access/tools";
import type { AnyService } from "../service";
import type { Principal } from "../types";
import type { Hub } from "./hub";
import { SUBSCRIBE_LEVEL } from "./tiers";

/** The principal's levels on `ids` of `service` and their anchors, in one engine call. */
export async function resolveAccess(
  hub: Hub,
  service: AnyService,
  principal: Principal,
  ids: readonly string[],
): Promise<ResolvedAccess> {
  if (service.access !== undefined && service.model !== undefined) {
    return await hub.policies.resolve(service.name, principal, ids);
  }
  const bypass = service.adminBypass && serviceGrant(principal, service.name) === "Admin";
  return {
    levels: new Map(ids.map((id) => [id, bypass ? "Admin" : null])),
    anchors: new Map(ids.map((id) => [id, [anchorKey(service.name, id)]])),
  };
}

/** The level a subscription to the row holds, or `undefined` when the level is too low to subscribe. */
export function subscriberLevel(access: ResolvedAccess, id: string): AccessLevel | undefined {
  const level = access.levels.get(id) ?? null;
  return level !== null && meetsLevel(level, SUBSCRIBE_LEVEL) ? level : undefined;
}

/** The anchors of the row's level; the row itself when the engine named none. */
export function anchorsOf(access: ResolvedAccess, service: string, id: string): readonly string[] {
  return access.anchors.get(id) ?? [anchorKey(service, id)];
}
