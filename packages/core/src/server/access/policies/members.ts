// `members({ model, entry, user, level, levels? })` (RFC 0003 section 4.2):
// the level comes from a membership table, one row per user and entry
// (`projectMember { projectId, userId, role }`).

import { isAccessLevel, type AccessLevel } from "../../../contract/access";
import { levelsAtLeast } from "../levels";
import {
  checkName,
  definePolicy,
  idFilter,
  type AccessPolicy,
  type MembershipRead,
} from "../policy";

/** Options of {@link members}. */
export interface MembersOptions<
  Model extends string = string,
  Entry extends string = string,
  User extends string = string,
  Level extends string = string,
> {
  /** The membership model, named as the client names it: `"projectMember"`. */
  readonly model: Model;
  /** The column holding the id of the row the membership is on: `"projectId"`. */
  readonly entry: Entry;
  /** The column holding the member's user id: `"userId"`. */
  readonly user: User;
  /** The column holding the member's role. */
  readonly level: Level;
  /**
   * Maps stored roles to access levels: `{ owner: "Admin", editor: "Moderate", viewer: "Read" }`.
   * Without it a stored role must be a level name. A role that maps to no
   * level grants nothing.
   */
  readonly levels?: Readonly<Record<string, AccessLevel>>;
}

function checkLevels(levels: unknown): Readonly<Record<string, AccessLevel>> | undefined {
  if (levels === undefined) {
    return undefined;
  }
  const valid =
    typeof levels === "object" &&
    levels !== null &&
    !Array.isArray(levels) &&
    Object.values(levels).every(isAccessLevel);
  if (!valid) {
    throw new TypeError(
      'members({ levels }): levels must map stored roles to access levels, as in { editor: "Moderate" }',
    );
  }
  return Object.freeze({ ...(levels as Record<string, AccessLevel>) });
}

/** The stored roles that give at least `level`. */
function rolesAtLeast(read: MembershipRead, level: AccessLevel): string[] {
  const enough = new Set<string>(levelsAtLeast(level));
  if (read.levels === undefined) {
    return [...enough];
  }
  return Object.entries(read.levels)
    .filter(([, mapped]) => enough.has(mapped))
    .map(([role]) => role);
}

/**
 * The level comes from the principal's row in a membership table: one query
 * per lookup, filtered by the entry ids and the user id. Several rows for one
 * user and entry give the highest level among them.
 *
 * @example
 * access: members({ model: "projectMember", entry: "projectId", user: "userId", level: "role" }),
 */
export function members<
  const Model extends string,
  const Entry extends string,
  const User extends string,
  const Level extends string,
>(
  options: MembersOptions<Model, Entry, User, Level>,
): AccessPolicy<never, { readonly model: Model; readonly columns: Entry | User | Level }> {
  if (typeof options !== "object" || options === null) {
    throw new TypeError("members(options): options must be { model, entry, user, level }");
  }
  const read: MembershipRead = Object.freeze({
    model: checkName("members({ model })", "model", options.model),
    entry: checkName("members({ entry })", "entry", options.entry),
    user: checkName("members({ user })", "user", options.user),
    level: checkName("members({ level })", "level", options.level),
    levels: checkLevels(options.levels),
  });
  return definePolicy({
    kind: "members",
    membership: read,
    reads: { columns: [], memberships: [read], inherits: [], storage: true },
    levelsFor: (principal, ids, tools) => tools.memberships(read, principal.userId, ids),
    async accessWhere(principal, level, tools) {
      const roles = rolesAtLeast(read, level);
      if (roles.length === 0) {
        return "none";
      }
      const rows = await tools.storage.findMany(read.model, {
        where: { [read.user]: principal.userId, [read.level]: { in: roles } },
        select: { [read.entry]: true },
      });
      const entries = rows.map((row) => row[read.entry]);
      return idFilter(entries.filter((entry): entry is string => typeof entry === "string"));
    },
  });
}
