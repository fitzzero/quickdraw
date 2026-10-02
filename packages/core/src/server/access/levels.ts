// Access level ordering, ported from 4.1's `isLevelSufficient`
// (`legacy-src/server/BaseService.ts:554-562`): Public < Read < Moderate < Admin.

import type { AccessLevel } from "../../contract/access";
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

/** The principal's service-wide grant on `service`, from `serviceAccess`. */
export function serviceGrant(principal: Principal, service: string): AccessLevel | undefined {
  const grants = principal.serviceAccess;
  if (grants === null || grants === undefined || !Object.hasOwn(grants, service)) {
    return undefined;
  }
  return grants[service];
}
