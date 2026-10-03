// The collection index on the client (RFC 0003 sections 7.4 and 7.5). The
// first page of a collection that declares `index` carries one row per
// member, `[id, rev, ...fields]` in the collection's `order`; the client keeps
// those rows as objects (`{ id, status, ordinal }`), which is what a view
// reads, and keeps them in order from deltas: every `order` column but `id`
// is an index field (section 7.1), so a row's place can be found by its own
// values.
//
// The order is the server's keyset order: each column ascending or
// descending, nulls last ascending and first descending, `id` last. Numbers
// compare as numbers, booleans false first, and strings by code unit, which
// matches a database collation only for ASCII text; a snapshot brings the
// server's own order back.
//
// Pure functions, React-free.

import type { OrderBy } from "../../contract/collections";
import type { WireIndexRow } from "../../protocol/envelope";
import { isRecord } from "../../protocol/guards";

/** One member in a collection's index, as views and hooks read it: `id` and the index fields, by name. */
export type IndexRow = Readonly<Record<string, unknown>> & { readonly id: string };

/** What the store needs of a collection's declaration (`CollectionDef`). */
export interface CollectionShape {
  /** The index fields, in the order the contract declares them; absent when there is no index. */
  readonly index?: readonly string[] | undefined;
  /** The sort columns, ending in `id`. */
  readonly order?: OrderBy | undefined;
}

/** True when `value` is an item or row: an object with a non-empty string `id`. */
export function hasId(value: unknown): value is { readonly id: string } {
  return isRecord(value) && typeof value.id === "string" && value.id !== "";
}

/** A wire index row `[id, rev, ...fields]` as an object; `undefined` when it is malformed. */
export function indexRowOf(shape: CollectionShape, wire: unknown): IndexRow | undefined {
  if (!Array.isArray(wire) || typeof wire[0] !== "string" || wire[0] === "") {
    return undefined;
  }
  const values: WireIndexRow | readonly unknown[] = wire;
  const row: Record<string, unknown> = { id: values[0] };
  for (const [position, field] of (shape.index ?? []).entries()) {
    row[field] = values[position + 2] ?? null;
  }
  return Object.freeze(row) as IndexRow;
}

/** The index row of an item: its index fields, which are item fields. */
export function indexRowFromItem(shape: CollectionShape, item: { readonly id: string }): IndexRow {
  const values = item as Readonly<Record<string, unknown>>;
  const row: Record<string, unknown> = { id: item.id };
  for (const field of shape.index ?? []) {
    row[field] = values[field] ?? null;
  }
  return Object.freeze(row) as IndexRow;
}

/** `row` with the index fields among `fields` (a patch) laid over it; `row` itself when none changes. */
export function patchIndexRow(shape: CollectionShape, row: IndexRow, fields: unknown): IndexRow {
  if (!isRecord(fields)) {
    return row;
  }
  let next: Record<string, unknown> | undefined;
  for (const field of shape.index ?? []) {
    if (Object.hasOwn(fields, field) && !Object.is(row[field], fields[field])) {
      next ??= { ...row };
      next[field] = fields[field];
    }
  }
  return next === undefined ? row : (Object.freeze(next) as IndexRow);
}

function rank(value: unknown): number {
  return value === null || value === undefined ? 1 : 0;
}

/** Compares two column values ascending: nulls last, numbers as numbers, the rest as strings. */
function compareValues(a: unknown, b: unknown): number {
  if (Object.is(a, b)) {
    return 0;
  }
  if (rank(a) !== rank(b)) {
    return rank(a) - rank(b);
  }
  if (typeof a === "number" && typeof b === "number") {
    return a - b;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Number(a) - Number(b);
  }
  const left = typeof a === "string" ? a : JSON.stringify(a);
  const right = typeof b === "string" ? b : JSON.stringify(b);
  if (left === right) {
    return 0;
  }
  return left < right ? -1 : 1;
}

type Values = Readonly<Record<string, unknown>>;

/** Compares two rows by `order`, as the server's keyset cursor orders them. */
export function compareRows(order: OrderBy, a: Values, b: Values): number {
  for (const [column, direction] of order) {
    const compared = compareValues(a[column], b[column]);
    if (compared !== 0) {
      return direction === "desc" ? -compared : compared;
    }
  }
  return 0;
}

/** True when `value` holds every `order` column, so its place in the order can be found. */
export function hasOrderValues(order: OrderBy | undefined, value: Values): boolean {
  return order !== undefined && order.every(([column]) => Object.hasOwn(value, column));
}

/** Where `row` goes in `rows`, which are sorted by `order`: after every row that sorts before or with it. */
export function insertionPoint(order: OrderBy, rows: readonly Values[], row: Values): number {
  let low = 0;
  let high = rows.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compareRows(order, rows[middle] as Values, row) <= 0) {
      low = middle + 1;
    } else {
      high = middle;
    }
  }
  return low;
}

/**
 * Where the row of `id`, whose values are `row`, is in `rows`: found by its
 * values in the order, else by a scan (a string order the database collates
 * differently); -1 when it is not there.
 */
export function positionOf(
  order: OrderBy | undefined,
  rows: readonly IndexRow[],
  row: IndexRow,
): number {
  if (order !== undefined) {
    const after = insertionPoint(order, rows, row);
    if (after > 0 && rows[after - 1]?.id === row.id) {
      return after - 1;
    }
  }
  return rows.findIndex((candidate) => candidate.id === row.id);
}
