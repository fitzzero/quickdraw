// `anyOf(...policies)` (RFC 0003 section 4.2): the highest level any of the
// policies grants. Policies that read the service's own rows share one read
// of them (`PolicyTools.rows`), so `anyOf(owner("ownerId"), jsonAcl("acl"))`
// costs one query.

import { maxLevel } from "../levels";
import {
  definePolicy,
  isAccessPolicy,
  type AccessFilter,
  type AccessPolicy,
  type AnyAccessPolicy,
  type MembershipRead,
  type PolicyColumns,
  type PolicyForeign,
  type PolicyReads,
  type RowLevel,
} from "../policy";
import type { StorageWhere } from "../../storage";

function unionReads(policies: readonly AnyAccessPolicy[]): PolicyReads {
  const memberships = new Set<MembershipRead>();
  for (const policy of policies) {
    for (const read of policy.reads.memberships) {
      memberships.add(read);
    }
  }
  return {
    columns: [...new Set(policies.flatMap((policy) => policy.reads.columns))],
    memberships: [...memberships],
    inherits: [...new Set(policies.flatMap((policy) => policy.reads.inherits))],
    parents: policies.flatMap((policy) => policy.reads.parents ?? []),
    storage: policies.some((policy) => policy.reads.storage),
  };
}

/**
 * The highest level any of `policies` grants on each row. List filters match
 * a row any of them lets through.
 *
 * @example
 * access: anyOf(owner("ownerId"), members({ model: "projectMember", entry: "projectId", user: "userId", level: "role" })),
 */
export function anyOf<const P extends readonly AnyAccessPolicy[]>(
  ...policies: P
): AccessPolicy<PolicyColumns<P[number]>, PolicyForeign<P[number]>> {
  if (policies.length === 0 || !policies.every(isAccessPolicy)) {
    throw new TypeError("anyOf(...policies): pass one or more access policies");
  }
  const all: readonly AnyAccessPolicy[] = Object.freeze([...policies]);
  return definePolicy({
    kind: "anyOf",
    policies: all,
    reads: unionReads(all),
    async levelsFor(principal, ids, tools) {
      const each = await Promise.all(all.map((policy) => policy.levelsFor(principal, ids, tools)));
      const levels = new Map<string, RowLevel>();
      for (const id of ids) {
        levels.set(
          id,
          each.reduce<RowLevel>((level, granted) => maxLevel(level, granted.get(id)), null),
        );
      }
      return levels;
    },
    async accessWhere(principal, level, tools) {
      const filters = await Promise.all(
        all.map((policy) => policy.accessWhere(principal, level, tools)),
      );
      const matching = filters.filter((filter): filter is StorageWhere => filter !== "none");
      if (matching.length <= 1) {
        return matching[0] ?? ("none" satisfies AccessFilter);
      }
      return { OR: matching };
    },
  });
}
