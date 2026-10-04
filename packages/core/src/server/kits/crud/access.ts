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
// else `Read` for reads and `Moderate` for writes. A `"public"` read's rows
// are public; a write always needs the level, so an anonymous caller writes
// nothing, and a write on one row needs it on that row whatever its form
// (`checkRowWrite`). A service-wide grant at level L is a row level of L on
// every row where the form names `service` (`grantRowLevel`): such a read is
// unfiltered, its rows stripped at the grant. A service without a policy has
// no row-level access: there the form is the whole check, so `defineService`
// takes only `"public"` or `{ service }` for its methods on many rows
// (`everyRowProblem`).

import type { AccessLevel } from "../../../contract/access";
import { QuickdrawError } from "../../../protocol/errors";
import { isCustomAccess } from "../../access/forms";
import { meetsLevel, serviceGrant } from "../../access/levels";
import type { AccessFilter, RowLevel } from "../../access/policy";
import type { AccessForm } from "../../access/types";
import type { AnyService } from "../../service";
import type { CrudCall } from "./runtime";

/** The level a method's rows need: its form's entry level, else its scope level, else `fallback`. */
export function rowLevel(form: AccessForm, fallback: AccessLevel): AccessLevel {
  if (typeof form !== "object" || isCustomAccess(form)) {
    return fallback;
  }
  return form.entry ?? form.scope ?? fallback;
}

/** True when a method's rows are not checked against a policy: a public read, or no policy. */
function unchecked(call: CrudCall, form: AccessForm, use: "read" | "write"): boolean {
  return call.runtime.service.access === undefined || (use === "read" && form === "public");
}

/** True for `"public"`, or `{ service: L }` alone: a form that names who may reach every row. */
function reachesEveryRow(form: AccessForm): boolean {
  if (form === "public") {
    return true;
  }
  return (
    typeof form === "object" &&
    !isCustomAccess(form) &&
    form.service !== undefined &&
    form.entry === undefined &&
    form.scope === undefined
  );
}

/**
 * Why a kit method on many rows (`list`, `getMany`, `search`, the bulk
 * methods) cannot run on `service` under `form`; `undefined` when it can. A
 * service with a model but no row policy has nothing to keep rows by, so
 * such a method reaches every row, and its form must say so outright:
 * `"public"` or `{ service }`. `"authenticated"`, `custom` or a `scope`
 * form would hand every row to anyone who passes it.
 */
export function everyRowProblem(
  service: Pick<AnyService, "name" | "access">,
  method: string,
  form: AccessForm,
): string | undefined {
  if (service.access !== undefined || reachesEveryRow(form)) {
    return undefined;
  }
  return `${method} reaches every row of ${service.name}, which declares no access policy to keep rows by: give it "public" or { service } access, or declare the service's access policy`;
}

/**
 * The caller's service-wide grant as their level on every row: a grant at
 * level L is a row level of L on every row where the form names `service`
 * and the grant meets it (a grant below `Admin` counts only where `service`
 * is named, RFC 0003 section 4.1). `undefined` otherwise.
 */
export function grantRowLevel(call: CrudCall, form: AccessForm): AccessLevel | undefined {
  const { principal } = call;
  if (principal === null || typeof form !== "object" || isCustomAccess(form)) {
    return undefined;
  }
  const grant = serviceGrant(principal, call.runtime.service.name);
  return form.service !== undefined && meetsLevel(grant, form.service) ? grant : undefined;
}

/** True when the caller's service-wide grant reaches every row at `level` (`grantRowLevel`). */
function grantReaches(call: CrudCall, form: AccessForm, level: AccessLevel): boolean {
  return meetsLevel(grantRowLevel(call, form), level);
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
  if (unchecked(call, form, "read") || grantReaches(call, form, level)) {
    return undefined;
  }
  if (call.principal === null) {
    return "none";
  }
  const { access, service } = call.runtime;
  return await access.accessWhere(service.name, call.principal, level);
}

/** True for a form whose own check covered row `input.id` at `level`: `{ entry }` alone, on `id`. */
function entryCovers(form: AccessForm, level: AccessLevel): boolean {
  return (
    typeof form === "object" &&
    !isCustomAccess(form) &&
    form.service === undefined &&
    (form.id === undefined || form.id === "id") &&
    meetsLevel(form.entry, level)
  );
}

/**
 * `FORBIDDEN` unless the caller has the method's row level on row `id`: a
 * kit write on one row (`update`, `delete`, `reorder`) of a service with a
 * policy needs it whatever its form says, so `update: "authenticated"`
 * edits no row. The level is the form's `entry` (or `scope`) level, else
 * `Moderate`; a service-wide grant the form names counts on every row. One
 * lookup, unless the form's own `entry` check already covered the row.
 */
export async function checkRowWrite(call: CrudCall, form: AccessForm, id: string): Promise<void> {
  const { access, service } = call.runtime;
  const level = rowLevel(form, "Moderate");
  if (service.access === undefined || grantReaches(call, form, level) || entryCovers(form, level)) {
    return;
  }
  const levels =
    call.principal === null
      ? undefined
      : await access.levelsFor(service.name, call.principal, [id]);
  if (!meetsLevel(levels?.get(id), level)) {
    throw new QuickdrawError("FORBIDDEN", "Insufficient permissions");
  }
}

/**
 * The ids among `ids` on which the caller has at least `level`, in order:
 * one batched lookup. `use` says whether the method reads or writes them.
 */
export async function allowedIds(
  call: CrudCall,
  form: AccessForm,
  ids: readonly string[],
  level: AccessLevel,
  use: "read" | "write",
): Promise<string[]> {
  if (unchecked(call, form, use) || ids.length === 0 || grantReaches(call, form, level)) {
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
 * service-wide `Admin` grant, the grant for one the form names that reaches
 * every row (`grantRowLevel`), and no level for rows no policy checked.
 */
export function readerLevel(call: CrudCall, form: AccessForm, level: AccessLevel): RowLevel {
  const { service } = call.runtime;
  const grant = call.principal === null ? undefined : serviceGrant(call.principal, service.name);
  if (service.adminBypass && grant === "Admin") {
    return "Admin";
  }
  const granted = grantRowLevel(call, form);
  if (unchecked(call, form, "read")) {
    return granted ?? null;
  }
  return granted !== undefined && meetsLevel(granted, level) ? granted : level;
}
