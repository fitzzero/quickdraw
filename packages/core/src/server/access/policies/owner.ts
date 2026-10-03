// `owner(field)` (RFC 0003 section 4.2): the user named in a column of the
// row has `Admin` on it, and nobody else has anything.

import { checkName, definePolicy, levelsById, type AccessPolicy } from "../policy";

/**
 * The user whose id is in `field` has `Admin` on the row; everyone else has
 * no level. One query reads `id` and `field` of every row asked about.
 *
 * @example
 * qd.defineService(project, { model: "project", access: owner("ownerId"), methods });
 */
export function owner<const Field extends string>(field: Field): AccessPolicy<Field, never> {
  checkName("owner(field)", "field", field);
  return definePolicy({
    kind: "owner",
    field,
    reads: { columns: [field], memberships: [], inherits: [], storage: true },
    async levelsFor(principal, ids, tools) {
      const rows = await tools.rows(ids);
      return levelsById(ids, (id) => (rows.get(id)?.[field] === principal.userId ? "Admin" : null));
    },
    accessWhere: (principal) => Promise.resolve({ [field]: principal.userId }),
  });
}
