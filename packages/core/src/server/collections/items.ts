// Collection items and membership (RFC 0003 sections 7.1 and 7.2). An item is
// the row in the collection's item projection, the same for everyone in the
// scope: collections have no per-subscriber field tiers, so a field the
// contract's `fields` reserves for a level above the collection's `access` is
// left out of every item and patch. Membership is the declared scope plus the
// equality filter `where`, read from a row's values.

import { pickKeys, projectRow } from "../emit/projection";
import { strip } from "../emit/tiers";
import type { StorageRow } from "../storage";
import type { ServiceCollection } from "./define";

type Values = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Values {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The keys of the item projection a subscriber at the collection's `access` level does not receive. */
function hiddenOf(collection: ServiceCollection): ReadonlySet<string> {
  return collection.item.tiers.hidden(collection.access);
}

/** One row as a collection item. */
export function itemOf(collection: ServiceCollection, row: StorageRow): unknown {
  const item = projectRow(collection.item, row);
  return isRecord(item) ? strip(item, hiddenOf(collection)) : item;
}

/** The fields of a `patched` delta: the patched item keys the row has, without hidden ones. */
export function patchOf(
  collection: ServiceCollection,
  row: StorageRow,
  fields: readonly string[],
): Record<string, unknown> {
  const hidden = hiddenOf(collection);
  return pickKeys(
    row,
    fields.filter((field) => !hidden.has(field)),
  );
}

/** The columns besides `id` that decide membership of a column-scoped collection: its scope column and `where`. */
export function membershipColumns(collection: ServiceCollection): readonly string[] {
  const where = Object.keys(collection.where);
  return collection.scope.kind === "column" ? [collection.scope.column, ...where] : where;
}

/** True when `values` match the collection's `where`. */
export function matchesWhere(collection: ServiceCollection, values: Values): boolean {
  return Object.entries(collection.where).every(
    ([column, expected]) => values[column] === expected,
  );
}

/**
 * The scope `values` put a row in, for a column-scoped collection: its scope
 * value when `where` matches, `null` when the row is in no scope, and
 * `undefined` when `values` lack a column that decides it.
 */
export function scopeIn(
  collection: ServiceCollection,
  values: Values | undefined,
): string | null | undefined {
  if (values === undefined || collection.scope.kind !== "column") {
    return undefined;
  }
  if (membershipColumns(collection).some((column) => !Object.hasOwn(values, column))) {
    return undefined;
  }
  const scope = values[collection.scope.column];
  const valid = typeof scope === "string" && scope.length > 0;
  return valid && matchesWhere(collection, values) ? scope : null;
}

/** What a read for items selects: the item's select, plus `extra` columns (order or membership). */
export function selectWith(
  base: Readonly<Record<string, unknown>>,
  extra: readonly string[],
): Readonly<Record<string, unknown>> {
  const select: Record<string, unknown> = { ...base, id: true };
  for (const column of extra) {
    if (select[column] === undefined) {
      select[column] = true;
    }
  }
  return select;
}
