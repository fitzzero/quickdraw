// Collection items and membership (RFC 0003 sections 7.1 and 7.2). An item is
// the row in the collection's item projection, the same for everyone in the
// scope: collections have no per-subscriber field tiers, so a field the
// contract's `fields` reserves for a level above the collection's `access` is
// left out of every item and patch. Membership is the declared scope plus the
// equality filter `where`, read from a row's values.
//
// `qd:col:items` (section 7.4) loads items by id: a client holding a scope's
// index asks for the members it shows. The read applies the scope and
// `where`, so an id that is not a member is simply absent from the answer.

import type { Revision } from "../../protocol/envelope";
import { pickKeys, projectRow } from "../emit/projection";
import { strip } from "../emit/tiers";
import type { StorageAdapter, StorageRow, StorageWhere } from "../storage";
import type { BoundCollection } from "./bind";
import type { ServiceCollection } from "./define";

/** The most ids one `qd:col:items` may name. */
export const MAX_ITEM_IDS = 200;

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

/**
 * The filter matching the members of `scope` among `ids`: its scope column,
 * or the ids among them its `via` junction links to it, and `where`.
 * `undefined` when none can be a member.
 */
async function membersAmong(
  storage: StorageAdapter,
  collection: BoundCollection,
  scope: string,
  ids: readonly string[],
): Promise<StorageWhere | undefined> {
  const { where } = collection;
  const filtered = (filter: StorageWhere): StorageWhere =>
    Object.keys(where).length === 0 ? filter : { AND: [filter, where] };
  if (collection.scope.kind === "column") {
    return filtered({ [collection.scope.column]: scope, id: { in: [...ids] } });
  }
  const { model, entry, scope: column } = collection.scope;
  const links = await storage.findMany(model, {
    where: { [column]: scope, [entry]: { in: [...ids] } },
    select: { [entry]: true },
  });
  const linked = links.map((link) => link[entry]).filter((id) => typeof id === "string");
  return linked.length === 0 ? undefined : filtered({ id: { in: [...new Set(linked)] } });
}

/**
 * The items of the members of `scope` among `ids`, in the order of `ids`,
 * each once, and the revision they were read at (`rev`, claimed before the
 * first read): one read for a column scope, two for a `via` scope (its
 * links among `ids`, then the rows). An id that is not a member is left out.
 */
export async function readItemsById(
  storage: StorageAdapter,
  collection: BoundCollection,
  scope: string,
  ids: readonly string[],
  rev: Revision,
): Promise<{ readonly rev: Revision; readonly items: unknown[] }> {
  const wanted = [...new Set(ids)];
  const members =
    wanted.length === 0 ? undefined : await membersAmong(storage, collection, scope, wanted);
  if (members === undefined) {
    return { rev, items: [] };
  }
  const rows = await storage.findMany(collection.model, {
    where: members,
    select: collection.item.select,
  });
  const found = new Map(rows.flatMap((row) => (typeof row.id === "string" ? [[row.id, row]] : [])));
  const items = wanted.flatMap((id) => {
    const row = found.get(id);
    return row === undefined ? [] : [itemOf(collection, row)];
  });
  return { rev, items };
}
