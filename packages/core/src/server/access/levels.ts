// Access level ordering, ported from 4.1's `isLevelSufficient`
// (4.1 `src/server/BaseService.ts:554-562`): Public < Read < Moderate < Admin.

import { ACCESS_LEVELS, isAccessLevel, type AccessLevel } from "../../contract/access";
import type { Principal } from "../types";

const RANK: Readonly<Record<AccessLevel, number>> = Object.freeze({
  Public: 0,
  Read: 1,
  Moderate: 2,
  Admin: 3,
});

/**
 * True when `level` is at least `required`. A missing level (no grant) meets
 * nothing, not even `"Public"`: a grant has to exist to count.
 */
export function meetsLevel(level: AccessLevel | null | undefined, required: AccessLevel): boolean {
  if (level === null || level === undefined) {
    return false;
  }
  return (RANK[level] ?? -1) >= RANK[required];
}

/**
 * The higher of two levels; `null` (no level) is below every level. A value
 * that is not an access level counts as `null`, so it never raises a level.
 */
export function maxLevel(
  a: AccessLevel | null | undefined,
  b: AccessLevel | null | undefined,
): AccessLevel | null {
  const left = isAccessLevel(a) ? a : null;
  const right = isAccessLevel(b) ? b : null;
  if (left === null || right === null) {
    return left ?? right;
  }
  return RANK[right] > RANK[left] ? right : left;
}

/** Every level that meets `required`, lowest first: `levelsAtLeast("Moderate")` is `["Moderate", "Admin"]`. */
export function levelsAtLeast(required: AccessLevel): readonly AccessLevel[] {
  return ACCESS_LEVELS.filter((level) => RANK[level] >= RANK[required]);
}

/** The principal's service-wide grant on `service`, from `serviceAccess`. */
export function serviceGrant(principal: Principal, service: string): AccessLevel | undefined {
  const grants = principal.serviceAccess;
  if (grants === null || grants === undefined || !Object.hasOwn(grants, service)) {
    return undefined;
  }
  return grants[service];
}
