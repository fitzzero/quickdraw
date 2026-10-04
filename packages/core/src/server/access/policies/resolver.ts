// `resolver({ levelsFor, where? })` (RFC 0003 section 4.2): a policy written
// in app code, for access rules the other builders cannot state.

import { isAccessLevel, type AccessLevel } from "../../../contract/access";
import type { MaybePromise, Principal } from "../../types";
import {
  definePolicy,
  levelsById,
  type AccessFilter,
  type AccessPolicy,
  type PolicyTools,
  type RowLevel,
} from "../policy";

/** Options of {@link resolver}. */
export interface ResolverOptions<P extends Principal = Principal> {
  /**
   * The principal's level on each of `ids`, as a map or a record by id. An id
   * left out, or given anything but an access level, has no level. Read
   * everything for one call in one query: `ids` holds every row the call asks
   * about. Results are memoized for the request, never kept across requests.
   */
  readonly levelsFor: (
    principal: P,
    ids: readonly string[],
    tools: PolicyTools,
  ) => MaybePromise<ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>>;
  /**
   * A filter matching exactly the rows on which the principal has at least
   * `level`, or `"none"`. Without it, list filters through this policy match
   * no row.
   */
  readonly where?: (
    principal: P,
    level: AccessLevel,
    tools: PolicyTools,
  ) => MaybePromise<AccessFilter>;
}

function levelIn(
  levels: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>,
  id: string,
): RowLevel {
  let level: unknown;
  if (levels instanceof Map) {
    level = levels.get(id);
  } else if (Object.hasOwn(levels, id)) {
    level = (levels as Readonly<Record<string, unknown>>)[id];
  }
  return isAccessLevel(level) ? level : null;
}

/**
 * A policy written in app code: `levelsFor` answers the level per row and
 * `where` the list filter. A resolver's own results are memoized for the
 * request and never cached across requests, because the framework cannot
 * know which writes change them; what it reads through `tools` is cached as
 * usual.
 *
 * @example
 * access: resolver({
 *   levelsFor: async (principal, ids) => levelsFromMyTable(principal.userId, ids),
 *   where: (principal) => ({ visibility: "public" }),
 * }),
 */
export function resolver<P extends Principal = Principal>(
  options: ResolverOptions<P>,
): AccessPolicy<never, never> {
  const valid =
    typeof options === "object" &&
    options !== null &&
    typeof options.levelsFor === "function" &&
    (options.where === undefined || typeof options.where === "function");
  if (!valid) {
    throw new TypeError("resolver({ levelsFor, where? }): levelsFor and where must be functions");
  }
  const { levelsFor, where } = options;
  return definePolicy({
    kind: "resolver",
    reads: { columns: [], memberships: [], inherits: [], storage: false },
    async levelsFor(principal, ids, tools) {
      const levels = await levelsFor(principal as P, ids, tools);
      if (typeof levels !== "object" || levels === null) {
        return levelsById(ids, () => null);
      }
      return levelsById(ids, (id) => levelIn(levels, id));
    },
    async accessWhere(principal, level, tools) {
      if (where === undefined) {
        return "none";
      }
      const filter: unknown = await where(principal as P, level, tools);
      const isFilter = typeof filter === "object" && filter !== null && !Array.isArray(filter);
      return isFilter ? (filter as AccessFilter) : "none";
    },
  });
}
