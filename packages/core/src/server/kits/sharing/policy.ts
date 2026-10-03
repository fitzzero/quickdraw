// Which access list or membership table the sharing kit changes (RFC 0003
// sections 4.2 and 12.3): the one the service's own policy reads. A mode
// `"acl"` method edits the list of the service's `jsonAcl` policy and a mode
// `"members"` method the table of its `members` policy, alone or inside
// `anyOf` (at any depth). The kit takes the column, model and role names
// from that policy, never as options of its own, so the list it writes is
// the one access is decided by. A service whose policy has none, or more
// than one, cannot run the mode's methods: `defineService` refuses it.

import type { SharingMode } from "../../../contract/kits/sharing";
import { QuickdrawError } from "../../../protocol/errors";
import { anyOfPolicies } from "../../access/policies/anyOf";
import { jsonAclColumnsOf, type JsonAclColumns } from "../../access/policies/jsonAcl";
import { membershipOf } from "../../access/policies/members";
import type { AnyAccessPolicy, MembershipRead } from "../../access/policy";
import type { AnyService } from "../../service";

/** The policies `policy` is made of: itself, or each policy an `anyOf` combines, at any depth. */
export function policiesIn(policy: AnyAccessPolicy): readonly AnyAccessPolicy[] {
  const combined = anyOfPolicies(policy);
  return combined === undefined ? [policy] : combined.flatMap(policiesIn);
}

/** The distinct access lists the service's policy reads. */
function listsOf(service: AnyService): JsonAclColumns[] {
  const policy = service.access;
  const found = policy === undefined ? [] : policiesIn(policy).map(jsonAclColumnsOf);
  return [...new Set(found)].filter((columns) => columns !== undefined);
}

/** The distinct membership tables the service's policy reads. */
function tablesOf(service: AnyService): MembershipRead[] {
  const policy = service.access;
  const found = policy === undefined ? [] : policiesIn(policy).map(membershipOf);
  return [...new Set(found)].filter((read) => read !== undefined);
}

const NEEDED: Readonly<Record<SharingMode, string>> = Object.freeze({
  acl: "a jsonAcl(field) policy, whose access list they change",
  members: "a members({ model, entry, user, level }) policy, whose table they change",
});

/** Why the service cannot run the sharing kit's methods of `mode`, or `undefined` when it can. */
export function policyProblem(service: AnyService, mode: SharingMode): string | undefined {
  const found = mode === "acl" ? listsOf(service) : tablesOf(service);
  if (found.length === 1) {
    return undefined;
  }
  const declared =
    service.access === undefined ? "no access policy" : `${service.access.kind}(...)`;
  if (found.length === 0) {
    return `the sharing kit's "${mode}" methods need ${NEEDED[mode]}, alone or inside anyOf; ${service.name} declares ${declared}`;
  }
  return `the sharing kit's "${mode}" methods need one ${mode === "acl" ? "jsonAcl" : "members"} policy to change, and ${service.name}'s has ${found.length}`;
}

function missing(service: AnyService, mode: SharingMode): never {
  throw new QuickdrawError(
    "INTERNAL",
    `The sharing kit's "${mode}" methods run in ${service.name}, ${policyProblem(service, mode) ?? "which they cannot use"}`,
  );
}

/** The access list a mode `"acl"` method of the service changes. */
export function aclColumnsOf(service: AnyService): JsonAclColumns {
  const [columns, ...others] = listsOf(service);
  return columns !== undefined && others.length === 0 ? columns : missing(service, "acl");
}

/** The membership table a mode `"members"` method of the service changes. */
export function membershipTableOf(service: AnyService): MembershipRead {
  const [read, ...others] = tablesOf(service);
  return read !== undefined && others.length === 0 ? read : missing(service, "members");
}
