// Which rows a read/write kit method may touch (RFC 0003 sections 4.3 and
// 12.1). The method's access form decides who may call it, as for every
// method; a method on one row (`get`, `update`, `delete`, `reorder`) is
// checked on that row by an `{ entry }` form. A method on many rows cannot
// be: `list`, `getMany`, `bulkUpdate` and `bulkDelete` keep only the rows on
// which the service's policy gives the caller the method's row level, from
// the same policy that answers `get`, so a list never shows a row `get`
// would refuse. A service-wide `Admin` grant (with `adminBypass`) reaches
// every row, as everywhere.
//
// The row level is the form's own (`{ entry: L }` or `{ scope: L }`), or
// else `Read` for reads and `Moderate` for writes. A `"public"` method's
// rows are public, and a service without a policy has no row-level access:
// there the form is the whole check.

import type { AccessLevel } from "../../../contract/access";
import { isCustomAccess } from "../../access/forms";
import { meetsLevel, serviceGrant } from "../../access/levels";
import type { AccessFilter, RowLevel } from "../../access/policy";
import type { AccessForm } from "../../access/types";
import type { CrudCall } from "./runtime";

/** The level a method's rows need: its form's entry level, else its scope level, else `fallback`. */
export function rowLevel(form: AccessForm, fallback: AccessLevel): AccessLevel {
  if (typeof form !== "object" || isCustomAccess(form)) {
    return fallback;
  }
  return form.entry ?? form.scope ?? fallback;
}

/** True when the method's rows are not checked against a policy: a public method, or no policy. */
function unchecked(call: CrudCall, form: AccessForm): boolean {
  return form === "public" || call.runtime.service.access === undefined;
}

/**
 * The filter matching the rows the caller may see at `level`, `"none"` when
 * it may see none, or `undefined` when every row is visible.
 */
export async function rowsWhere(
  call: CrudCall,
  form: AccessForm,
  level: AccessLevel,
): Promise<AccessFilter | undefined> {
  if (unchecked(call, form)) {
    return undefined;
  }
  if (call.principal === null) {
    return "none";
  }
  const { access, service } = call.runtime;
  return await access.accessWhere(service.name, call.principal, level);
}

/** The ids among `ids` on which the caller has at least `level`, in order: one batched lookup. */
export async function allowedIds(
  call: CrudCall,
  form: AccessForm,
  ids: readonly string[],
  level: AccessLevel,
): Promise<string[]> {
  if (unchecked(call, form) || ids.length === 0) {
    return [...ids];
  }
  if (call.principal === null) {
    return [];
  }
  const { access, service } = call.runtime;
  const levels = await access.levelsFor(service.name, call.principal, ids);
  return ids.filter((id) => meetsLevel(levels.get(id), level));
}

/**
 * The level whose field tiers a list's items are stripped to. Like a
 * collection's items (RFC 0003 section 7.2), a page's items are stripped
 * once, at the level the page was filtered at, not per row: `Admin` for a
 * service-wide `Admin` grant, and no level for rows no policy checked.
 */
export function readerLevel(call: CrudCall, form: AccessForm, level: AccessLevel): RowLevel {
  const { service } = call.runtime;
  const grant = call.principal === null ? undefined : serviceGrant(call.principal, service.name);
  if (service.adminBypass && grant === "Admin") {
    return "Admin";
  }
  return unchecked(call, form) ? null : level;
}
