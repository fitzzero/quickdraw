// `everyone(level)` (finding F2.7 of the quickdraw-chat migration): every
// signed-in user has `level` on every row of the service, for rows anyone
// may read (public profiles, public posts). It reads nothing: a principal is
// all it needs, so a row id that does not exist is allowed too and answers
// `NOT_FOUND` where the row would be read (whether a row exists is no secret
// when everyone may read every row). It covers every surface a policy does,
// method calls on a row, entity subscriptions and list filters, where
// `rowless: true` on a method covers that method alone. In `anyOf` it gives
// the floor the other policies raise: `anyOf(owner("id"), everyone("Read"))`
// is Admin on one's own row and Read on everyone else's.

import { isAccessLevel, type AccessLevel } from "../../../contract/access";
import { meetsLevel } from "../levels";
import { definePolicy, levelsById, type AccessPolicy } from "../policy";

/**
 * Every signed-in user has `level` on every row. Anonymous callers have no
 * principal and so no level: a `"public"` method is what serves them.
 *
 * @example
 * // public profiles: everyone reads them, each user edits their own
 * qd.defineService(user, { model: "user", access: anyOf(owner("id"), everyone("Read")), methods });
 */
export function everyone(level: AccessLevel): AccessPolicy<never, never> {
  if (!isAccessLevel(level) || level === "Public") {
    throw new TypeError('everyone(level): level is "Read", "Moderate" or "Admin"');
  }
  return definePolicy({
    kind: "everyone",
    level,
    reads: { columns: [], memberships: [], inherits: [], storage: false },
    levelsFor: (_principal, ids) => Promise.resolve(levelsById(ids, () => level)),
    accessWhere: (_principal, wanted) => Promise.resolve(meetsLevel(level, wanted) ? {} : "none"),
  });
}
