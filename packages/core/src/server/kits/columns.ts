// The values a kit write may hold (RFC 0003 sections 4.2, 4.4 and 12). A
// write of the read/write kit (`create`, `update`, `bulkUpdate`) or of the
// admin kit (`adminCreate`, `adminUpdate`) holds three kinds of risk, checked
// here in this order:
//
// - Column values only (`checkColumnValues`): a key that is a relation of
//   the model (one a projection of the service selects with a nested
//   select) or a value that is a Prisma nested write (`{ connect }`, `{
//   update }`, a to-many `{ set: [...] }`) is `VALIDATION`, in every
//   environment and for every caller, a service-wide Admin included: nested
//   writes are not tracked, and they passed the name-only checks below
//   (`{ project: { update: { ownerId } } }` made a member the owner; the
//   5.1 audit's CRUD-5, DATA-2 and ADMIN-1). A JSON value whose own key is a
//   relation operation holding rows is refused too; keep such data a level
//   deeper.
// - Locked columns (`checkLockedColumns`): a column the service's policy
//   reads (an owner column, an access list) is read-only, and on `create`
//   comes only from the kit's `prepare`.
// - Anchor columns (`checkAnchorColumns`): a column that places the row
//   under an anchor row (an `inherit` policy's `via`, an anchored
//   collection's scope column) may name only an anchor row on which the
//   caller's level, from that row's own policy (as `inherit` and collection
//   scopes count it, without grants on its service), meets the method's row
//   level: a move on `update`, a parent on `create` (CRUD-1). Setting it to
//   null moves the row out of every anchor, which needs nothing more. An
//   anonymous caller names no anchor row.
//
// A caller with a service-wide `Admin` grant (with `adminBypass`) writes any
// column, but never a relation or a nested write. `update`, `bulkUpdate`
// and the admin writes run all three (`checkWritableColumns`); `create` runs
// them apart: column values and locked columns on the caller's input before
// `prepare`, column values and anchors on what it returns.
//
// Statements: one engine call per anchor column the write sets (the anchor
// policy's reads), none otherwise.

import type { AccessLevel } from "../../contract/access";
import { findNestedWrites } from "../../prisma/nested";
import { QuickdrawError } from "../../protocol/errors";
import { meetsLevel, serviceGrant } from "../access/levels";
import type { KitRuntime } from "../context";
import type { AnyService } from "../service";
import type { Principal } from "../types";

/** A column whose value is the id of an anchor row, and the service that row belongs to. */
interface AnchorColumn {
  readonly column: string;
  readonly anchor: string;
}

/** The columns of a service's rows that decide who may reach them. */
interface GuardedColumns {
  /** Read-only unless the caller holds a service-wide `Admin` grant. */
  readonly locked: ReadonlySet<string>;
  /** Writable into an anchor row the caller has the method's row level on. */
  readonly anchors: readonly AnchorColumn[];
}

function guardedColumns(service: AnyService): GuardedColumns {
  const reads = service.access?.reads;
  const anchors = new Map<string, AnchorColumn>();
  const add = (column: string, anchor: string): void => {
    anchors.set(`${column}\u0000${anchor}`, { column, anchor });
  };
  for (const { from, via } of reads?.parents ?? []) {
    add(via, from.name);
  }
  for (const collection of service.collections.values()) {
    if (collection.anchor !== undefined && collection.scope.kind === "column") {
      add(collection.scope.column, collection.anchor.name);
    }
  }
  const moving = new Set([...anchors.values()].map(({ column }) => column));
  const locked = (reads?.columns ?? []).filter((column) => column !== "id" && !moving.has(column));
  return { locked: new Set(locked), anchors: [...anchors.values()] };
}

function forbidden(message: string): QuickdrawError {
  return new QuickdrawError("FORBIDDEN", message);
}

/** True when the principal's service-wide `Admin` grant passes every check on the service. */
function bypasses(service: AnyService, principal: Principal | null): boolean {
  return (
    principal !== null && service.adminBypass && serviceGrant(principal, service.name) === "Admin"
  );
}

/** Options of the column checks: `creating` words the refusals for `create`. */
interface ColumnCheckOptions {
  readonly creating?: boolean;
}

/** The columns `data` gives a value (`undefined` is no value). */
function namedColumns(data: Readonly<Record<string, unknown>>): Set<string> {
  return new Set(Object.keys(data).filter((column) => data[column] !== undefined));
}

/**
 * `FORBIDDEN` when `data` gives a value to a column the service's policy
 * reads, unless the caller holds a service-wide `Admin` grant.
 */
export function checkLockedColumns(
  runtime: Pick<KitRuntime, "service">,
  principal: Principal | null,
  data: Readonly<Record<string, unknown>>,
  options: ColumnCheckOptions = {},
): void {
  const { service } = runtime;
  if (bypasses(service, principal)) {
    return;
  }
  const { locked } = guardedColumns(service);
  const readOnly = [...namedColumns(data)].find((column) => locked.has(column));
  if (readOnly === undefined) {
    return;
  }
  throw forbidden(
    options.creating === true
      ? `"${readOnly}" decides who may reach rows of ${service.name}: only a service-wide Admin may send it; set it in the kit's prepare`
      : `"${readOnly}" decides who may reach rows of ${service.name}: only a service-wide Admin may change it`,
  );
}

/**
 * `FORBIDDEN` unless each anchor column `data` gives a value names an
 * anchor row the caller has `level` on (or is null), unless the caller
 * holds a service-wide `Admin` grant. An anonymous caller names none.
 */
export async function checkAnchorColumns(
  runtime: Pick<KitRuntime, "service" | "access">,
  principal: Principal | null,
  data: Readonly<Record<string, unknown>>,
  level: AccessLevel,
  options: ColumnCheckOptions = {},
): Promise<void> {
  const { service, access } = runtime;
  if (bypasses(service, principal)) {
    return;
  }
  const { anchors } = guardedColumns(service);
  const named = namedColumns(data);
  for (const { column, anchor } of anchors) {
    const target = data[column];
    if (!named.has(column) || target === null) {
      continue;
    }
    const valid = principal !== null && typeof target === "string" && target.length > 0;
    const resolved = valid
      ? await access.resolve(anchor, principal, [target], { grants: false })
      : undefined;
    if (resolved === undefined || !meetsLevel(resolved.levels.get(target as string), level)) {
      throw forbidden(
        options.creating === true
          ? `Creating a row of ${service.name} with "${column}" needs ${level} on the ${anchor} row it names`
          : `Moving a row of ${service.name} by "${column}" needs ${level} on the ${anchor} row it moves into`,
      );
    }
  }
}

/** The relation keys of each service, by the service. */
const relations = new WeakMap<object, ReadonlySet<string>>();

/**
 * The keys of a service's rows that are relations of its model, as far as
 * the service says: those any of its projections `select`s with an object
 * (`project: { select: { name: true } }`). A relation selected with `true`
 * is not known as one; its nested-write values still are.
 */
export function relationKeysOf(service: Pick<AnyService, "projections">): ReadonlySet<string> {
  let keys = relations.get(service);
  if (keys === undefined) {
    const found = new Set<string>();
    for (const projection of service.projections.values()) {
      for (const [key, value] of Object.entries(projection.select)) {
        if (typeof value === "object" && value !== null) {
          found.add(key);
        }
      }
    }
    keys = found;
    relations.set(service, keys);
  }
  return keys;
}

/** One reason a kit write's data is not column values. */
export interface ColumnValueIssue {
  readonly path: PropertyKey[];
  readonly message: string;
}

function isPlainObject(value: unknown): value is Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Why `data` holds something other than column values: one issue per key
 * that is a relation of the service's model, or whose value is a nested
 * write (`findNestedWrites`), or a plain object holding a `set` list (which
 * disconnects every child of a to-many relation). Empty when it holds column
 * values only. `path` goes before each key (`["data"]`).
 */
export function columnValueIssues(
  service: Pick<AnyService, "name" | "projections">,
  data: Readonly<Record<string, unknown>>,
  path: readonly PropertyKey[] = [],
): ColumnValueIssue[] {
  const relationKeys = relationKeysOf(service);
  const nested = new Map(findNestedWrites(data).map(({ field, operation }) => [field, operation]));
  const issues: ColumnValueIssue[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) {
      continue;
    }
    const operation =
      nested.get(key) ?? (isPlainObject(value) && Array.isArray(value.set) ? "set" : undefined);
    if (relationKeys.has(key)) {
      issues.push({
        path: [...path, key],
        message: `"${key}" is a relation of ${service.name}'s model: kits write column values only; set its foreign key column instead`,
      });
    } else if (operation !== undefined) {
      issues.push({
        path: [...path, key],
        message: `"${key}" holds a nested write ({ ${operation} }), which is not tracked: kits write column values only`,
      });
    }
  }
  return issues;
}

/**
 * `VALIDATION` unless `data` holds column values only (`columnValueIssues`),
 * whoever the caller: never bypassed, since a nested write is not tracked.
 */
export function checkColumnValues(
  service: Pick<AnyService, "name" | "projections">,
  data: Readonly<Record<string, unknown>>,
  path: readonly PropertyKey[] = [],
): void {
  const issues = columnValueIssues(service, data, path);
  if (issues.length > 0) {
    throw new QuickdrawError(
      "VALIDATION",
      "The data holds a relation or a nested write, which kits do not write",
      { issues },
    );
  }
}

/**
 * The checks of a kit write on existing rows (`update`, `bulkUpdate`, the
 * admin writes): `VALIDATION` unless `data` holds column values only, then
 * `FORBIDDEN` unless the caller may set every column it gives a value, in a
 * write whose rows need `level`: no column the policy reads, and each
 * anchor column only to an anchor row the caller has `level` on (or null).
 * `path` goes before each key of an issue (`["data"]`).
 */
export async function checkWritableColumns(
  runtime: Pick<KitRuntime, "service" | "access">,
  principal: Principal | null,
  data: Readonly<Record<string, unknown>>,
  level: AccessLevel,
  path: readonly PropertyKey[] = [],
): Promise<void> {
  checkColumnValues(runtime.service, data, path);
  checkLockedColumns(runtime, principal, data);
  await checkAnchorColumns(runtime, principal, data, level);
}
