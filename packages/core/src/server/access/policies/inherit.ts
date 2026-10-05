// `inherit({ from, via })` (RFC 0003 section 4.2): a row's level is the
// principal's level on its parent row in another service (a task inherits
// from its project). The parent service must be served by the same
// dispatcher and declare a policy of its own; `createDispatcher` checks both,
// and refuses a cycle.

import type { AnyContract } from "../../../contract/defineContract";
import { checkName, definePolicy, levelsById, type AccessPolicy } from "../policy";

/** Options of {@link inherit}. */
export interface InheritOptions<Via extends string = string> {
  /** The parent service's contract. */
  readonly from: AnyContract;
  /** The column holding the parent row's id: `"projectId"`. */
  readonly via: Via;
}

function isContract(value: unknown): value is AnyContract {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly name?: unknown }).name === "string" &&
    Object.isFrozen(value)
  );
}

/**
 * The level on the parent row, from the parent service's policy: one query
 * reads `via` of every row asked about, then one batched lookup asks the
 * parent's policy about the parents found. A row that does not exist, or has
 * no parent, has no level; its id is never taken for a parent id. Service
 * grants on the parent service do not count here, only its policy. A list's
 * filter names the parents the principal reaches (`{ via: { in: ids } }`),
 * or, when the parent's policy lets every row through, any row with a parent
 * (`{ via: { not: null } }`), without reading the parent table.
 *
 * @example
 * qd.defineService(task, { model: "task", access: inherit({ from: project, via: "projectId" }), methods });
 */
export function inherit<const Via extends string>(
  options: InheritOptions<Via>,
): AccessPolicy<Via, never> {
  if (typeof options !== "object" || options === null || !isContract(options.from)) {
    throw new TypeError("inherit({ from, via }): from must be the parent service's contract");
  }
  const { from } = options;
  const via = checkName("inherit({ via })", "via", options.via);
  return definePolicy({
    kind: "inherit",
    from,
    via,
    reads: {
      columns: [via],
      memberships: [],
      inherits: [from],
      parents: [{ from, via }],
      storage: true,
    },
    async levelsFor(principal, ids, tools) {
      const rows = await tools.rows(ids);
      const parentOf = new Map<string, string>();
      for (const id of ids) {
        const parent = rows.get(id)?.[via];
        if (typeof parent === "string" && parent.length > 0) {
          parentOf.set(id, parent);
        }
      }
      const parents = await tools.levelsOf(from, principal, [...new Set(parentOf.values())]);
      return levelsById(ids, (id) => {
        const parent = parentOf.get(id);
        return parent === undefined ? null : (parents.get(parent) ?? null);
      });
    },
    async accessWhere(principal, level, tools) {
      // A parent whose every row passes (`everyone(level)`, alone or in `anyOf`): any row
      // that has a parent, without listing every parent id (the final review's E1).
      const parentFilter = await tools.whereOf(from, principal, level);
      if (parentFilter !== "none" && Object.keys(parentFilter).length === 0) {
        return { [via]: { not: null } };
      }
      const parents = await tools.idsWhere(from, principal, level);
      return parents.length === 0 ? "none" : { [via]: { in: parents } };
    },
  });
}
