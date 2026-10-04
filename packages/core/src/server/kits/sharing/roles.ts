// The roles of the membership table a `members` policy reads (RFC 0003
// section 4.2), as the sharing kit gives and reports them. With the policy's
// `levels` (`{ owner: "Admin", editor: "Moderate", viewer: "Read" }`) the
// roles are its keys; without it a stored role is a level name, and the kit
// gives `Read`, `Moderate` or `Admin`. A role the policy cannot read is
// refused (`VALIDATION`), since it would grant nothing. `invite` without a
// role gives the lowest role that still lets the member read the row.

import { ACCESS_LEVELS, isAccessLevel, type AccessLevel } from "../../../contract/access";
import type { Member } from "../../../contract/kits/sharingSchemas";
import { QuickdrawError } from "../../../protocol/errors";
import { maxLevel, meetsLevel } from "../../access/levels";
import type { MembershipRead } from "../../access/policy";
import type { Row } from "../crud/runtime";

/** The level-named roles of a table without `levels`. */
const LEVEL_ROLES: readonly string[] = Object.freeze(["Read", "Moderate", "Admin"]);

/** The roles a call may give. */
export function rolesOf(read: MembershipRead): readonly string[] {
  return read.levels === undefined ? LEVEL_ROLES : Object.keys(read.levels);
}

/** The level a stored role gives, as the policy reads it; `null` for a role it cannot read. */
export function levelOfRole(read: MembershipRead, role: unknown): AccessLevel | null {
  if (read.levels === undefined) {
    return isAccessLevel(role) ? role : null;
  }
  return typeof role === "string" && Object.hasOwn(read.levels, role)
    ? (read.levels[role] ?? null)
    : null;
}

/** The stored roles that give `Admin`. */
export function adminRolesOf(read: MembershipRead): string[] {
  return rolesOf(read).filter((role) => levelOfRole(read, role) === "Admin");
}

/** The role `invite` gives without one: the first role giving the lowest level from `Read` up. */
function defaultRoleOf(read: MembershipRead): string | undefined {
  const rank = (role: string): number => ACCESS_LEVELS.indexOf(levelOfRole(read, role) ?? "Public");
  const readable = rolesOf(read).filter((role) => meetsLevel(levelOfRole(read, role), "Read"));
  return [...readable].sort((a, b) => rank(a) - rank(b))[0];
}

function invalidRole(message: string): QuickdrawError {
  return new QuickdrawError("VALIDATION", message, { issues: [{ path: ["role"], message }] });
}

/** The role a call gives: `role`, or the default; `VALIDATION` for one the policy cannot read. */
export function checkRole(read: MembershipRead, role: string | undefined): string {
  const chosen = role ?? defaultRoleOf(read);
  if (chosen === undefined) {
    throw invalidRole(`Give a role: no role of ${read.model} lets a member read the row`);
  }
  const roles = rolesOf(read);
  if (!roles.includes(chosen)) {
    const known = roles.map((name) => `"${name}"`).join(", ");
    throw invalidRole(`"${chosen}" is not a role of ${read.model}; the roles are ${known}`);
  }
  return chosen;
}

function textOf(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value) ?? "");
}

/** A member as the kit returns it: their user id, their stored role, and the level it gives. */
export function memberOf(read: MembershipRead, userId: unknown, role: unknown): Member {
  return { userId: textOf(userId), role: textOf(role), level: levelOfRole(read, role) };
}

/** A member's role and level, from their rows: the row giving the highest level, as the policy reads it. */
export function currentRole(
  read: MembershipRead,
  rows: readonly Row[],
): { readonly role: string; readonly level: AccessLevel | null } {
  let best: { role: string; level: AccessLevel | null } | undefined;
  for (const row of rows) {
    const level = levelOfRole(read, row[read.level]);
    if (best === undefined || (level !== null && maxLevel(best.level, level) !== best.level)) {
      best = { role: textOf(row[read.level]), level };
    }
  }
  return best ?? { role: "", level: null };
}
