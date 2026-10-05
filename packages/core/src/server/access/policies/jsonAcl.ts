// `jsonAcl(field, { owner? })` (RFC 0003 section 4.2): the level comes from a
// JSON access list on the row, `[{ userId, level }]`, the shape 4.x apps
// store (`ACL` on the root export), plus `Admin` for the owner column when
// one is named. Ported from 4.1's `checkEntryACL`
// (4.1 `src/server/BaseService.ts:526-547`), which read one row per check.

import type { AccessLevel } from "../../../contract/access";
import { levelsAtLeast, maxLevel } from "../levels";
import {
  checkName,
  definePolicy,
  levelsById,
  type AccessPolicy,
  type AnyAccessPolicy,
  type RowLevel,
} from "../policy";
import type { StorageRow, StorageWhere } from "../../storage";

/** Options of {@link jsonAcl}. */
export interface JsonAclOptions<Owner extends string = string> {
  /** A column holding the owner's user id; the owner has `Admin`. */
  readonly owner?: Owner;
}

/** The columns a `jsonAcl` policy reads: its access list, and its owner column when it names one. */
export interface JsonAclColumns {
  /** The column holding the `[{ userId, level }]` list. */
  readonly field: string;
  /** The column holding the owner's user id, or `undefined` without an owner. */
  readonly owner: string | undefined;
}

const COLUMNS = new WeakMap<object, JsonAclColumns>();

/**
 * The columns of a policy `jsonAcl` made, or `undefined` for any other
 * policy: what the sharing kit reads and writes.
 */
export function jsonAclColumnsOf(policy: AnyAccessPolicy): JsonAclColumns | undefined {
  return COLUMNS.get(policy);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The highest level the access list grants `userId`. A value that is not a
 * list grants nothing; so does an entry that is not `{ userId, level }` with
 * a known level. Several entries for one user give the highest of them,
 * which is what `accessWhere` matches.
 */
function aclLevel(acl: unknown, userId: string): RowLevel {
  if (!Array.isArray(acl)) {
    return null;
  }
  let level: RowLevel = null;
  for (const entry of acl) {
    if (isRecord(entry) && entry.userId === userId) {
      level = maxLevel(level, entry.level as AccessLevel);
    }
  }
  return level;
}

/**
 * The level comes from the JSON access list in `field`, `[{ userId, level }]`,
 * plus `Admin` for the user named in the `owner` column. One query reads both
 * columns of every row asked about. A malformed list, or an entry with an
 * unknown level, grants nothing.
 *
 * List filters match the list with JSON containment (Prisma's
 * `array_contains`, PostgreSQL's `@>`).
 *
 * @example
 * access: jsonAcl("acl", { owner: "ownerId" }),
 */
export function jsonAcl<const Field extends string, const Owner extends string = never>(
  field: Field,
  options: JsonAclOptions<Owner> = {},
): AccessPolicy<Field | Owner, never> {
  checkName("jsonAcl(field)", "field", field);
  const ownerColumn = options.owner;
  if (ownerColumn !== undefined) {
    checkName("jsonAcl(field, { owner })", "owner", ownerColumn);
  }
  const levelOf = (row: StorageRow | null | undefined, userId: string): RowLevel => {
    if (row === null || row === undefined) {
      return null;
    }
    const owned = ownerColumn !== undefined && row[ownerColumn] === userId ? "Admin" : null;
    return maxLevel(owned, aclLevel(row[field], userId));
  };
  const policy = definePolicy<AccessPolicy<Field | Owner, never>>({
    kind: "jsonAcl",
    field,
    owner: ownerColumn,
    reads: {
      columns: ownerColumn === undefined ? [field] : [field, ownerColumn],
      memberships: [],
      inherits: [],
      storage: true,
    },
    async levelsFor(principal, ids, tools) {
      const rows = await tools.rows(ids);
      return levelsById(ids, (id) => levelOf(rows.get(id), principal.userId));
    },
    accessWhere(principal, level) {
      const listed: StorageWhere[] = levelsAtLeast(level).map((granted) => ({
        [field]: { array_contains: [{ userId: principal.userId, level: granted }] },
      }));
      const owned = ownerColumn === undefined ? [] : [{ [ownerColumn]: principal.userId }];
      return Promise.resolve({ OR: [...owned, ...listed] });
    },
  });
  COLUMNS.set(policy, Object.freeze({ field, owner: ownerColumn }));
  return policy;
}
