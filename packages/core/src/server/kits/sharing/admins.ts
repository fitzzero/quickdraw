// Whether a row keeps an Admin through the service's other policies (RFC
// 0003 sections 4.2 and 12.3). A change may not leave a row without an Admin
// it had, and under `anyOf` an Admin can come from any of its policies: an
// owner column (`owner`, or `jsonAcl`'s `owner`), an `Admin` entry of an
// access list, or an `Admin` role in a membership table. So the owner of a
// project whose policy is `anyOf(jsonAcl("acl", { owner }), members(...))`
// may remove its only Admin member: the row keeps the owner. The policy the
// change edits counts its own Admins itself (`acl.ts`, `members.ts`); this
// counts every other one. `inherit` and `resolver` policies are not counted:
// their Admins are not the row's own.
//
// Statements, inside the change's transaction, and only when the edited
// policy would be left without an Admin: one read of the row's owner and list
// columns when the policy has any, then one per other membership table
// unless the row named an Admin.

import { jsonAclColumnsOf, type JsonAclColumns } from "../../access/policies/jsonAcl";
import { membershipOf } from "../../access/policies/members";
import type { MembershipRead } from "../../access/policy";
import type { AnyService } from "../../service";
import { parseList } from "./aclList";
import { policiesIn } from "./policy";
import { adminRolesOf } from "./roles";
import { tableOf } from "./runtime";

/** Where the service's other policies keep a row's Admins. */
interface AdminSources {
  /** Columns holding an owner's user id. */
  readonly owners: string[];
  /** Columns holding an access list. */
  readonly lists: string[];
  readonly tables: MembershipRead[];
}

function sourcesOf(service: AnyService, changing: JsonAclColumns | MembershipRead): AdminSources {
  const sources: AdminSources = { owners: [], lists: [], tables: [] };
  const policy = service.access;
  for (const one of policy === undefined ? [] : policiesIn(policy)) {
    const list = jsonAclColumnsOf(one);
    const table = membershipOf(one);
    if (list !== undefined && list !== changing) {
      sources.lists.push(list.field);
      sources.owners.push(...(list.owner === undefined ? [] : [list.owner]));
    } else if (table !== undefined && table !== changing) {
      sources.tables.push(table);
    } else if (one.kind === "owner") {
      sources.owners.push(...one.reads.columns);
    }
  }
  return sources;
}

/** True when the row's own columns name an Admin: an owner, or an `Admin` entry of a list. */
async function rowNamesAdmin(
  service: AnyService,
  tx: unknown,
  id: string,
  sources: AdminSources,
): Promise<boolean> {
  const columns = [...sources.owners, ...sources.lists];
  if (columns.length === 0 || service.model === undefined) {
    return false;
  }
  const select = Object.fromEntries([["id", true], ...columns.map((column) => [column, true])]);
  const row = await tableOf(tx, service.model).findUnique({ where: { id }, select });
  if (row === null) {
    return false;
  }
  const owned = sources.owners.some(
    (column) => typeof row[column] === "string" && row[column] !== "",
  );
  return (
    owned ||
    sources.lists.some((column) =>
      (parseList(row[column]) ?? []).some((entry) => entry.level === "Admin"),
    )
  );
}

/**
 * True when a policy of the service other than `changing` (the list or the
 * table the change edits) gives someone `Admin` on row `id`, read through
 * `tx`, the change's transaction.
 */
export async function adminElsewhere(
  service: AnyService,
  tx: unknown,
  id: string,
  changing: JsonAclColumns | MembershipRead,
): Promise<boolean> {
  const sources = sourcesOf(service, changing);
  if (await rowNamesAdmin(service, tx, id, sources)) {
    return true;
  }
  const found = await Promise.all(
    sources.tables.map(async (table) => {
      const roles = adminRolesOf(table);
      return roles.length === 0
        ? null
        : await tableOf(tx, table.model).findFirst({
            where: { [table.entry]: id, [table.level]: { in: roles } },
            select: { id: true },
          });
    }),
  );
  return found.some((row) => row !== null);
}
