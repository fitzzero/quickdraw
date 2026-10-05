// Keyset cursors over a collection's `order` (RFC 0003 section 7.3). A
// cursor holds the last row's value of each order column, `id` last, as
// base64url JSON; the next page is the rows after those values in `order`.
// Unlike an offset, it stays on its row when rows are inserted or removed
// before it. 4.1 left paging to each collection's own `snapshot` function
// (4.1 `src/server/collections.ts:51-55`), which in practice used offsets.
//
// Nulls sort last in ascending order and first in descending order (as
// PostgreSQL does by default); a nullable column is ordered that way
// explicitly, so the database's own default does not matter. Prisma refuses
// a null filter or null ordering on a required column, so which columns may
// be null comes from the storage adapter (`StorageAdapter.nullable`).
//
//   order [ordinal asc, id asc], cursor (3, "t9"):
//   ordinal > 3 OR ordinal IS NULL (when nullable) OR (ordinal = 3 AND id > "t9")

import type { OrderBy, SortDirection } from "../../contract/collections";
import type { StorageRow, StorageWhere } from "../storage";
import { unreadable } from "../transports/ack";

/** A cursor's values: the value of each order column of the row it follows, `id` last. */
export type CursorValues = readonly unknown[];

const DATE = "$date";
const BIGINT = "$bigint";

const INVALID = "cursor is not a cursor of this collection";

function isTagged(value: unknown, tag: string): value is Readonly<Record<string, string>> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === 1 &&
    typeof (value as Readonly<Record<string, unknown>>)[tag] === "string"
  );
}

/** A column value as JSON can carry it: dates and big integers tagged. */
function pack(value: unknown): unknown {
  if (value instanceof Date) {
    return { [DATE]: value.toISOString() };
  }
  if (typeof value === "bigint") {
    return { [BIGINT]: value.toString() };
  }
  return value ?? null;
}

/** A packed value back, or `undefined` for one no cursor holds. */
function unpack(value: unknown): unknown {
  if (isTagged(value, DATE)) {
    const date = new Date(value[DATE] ?? "");
    return Number.isNaN(date.getTime()) ? undefined : date;
  }
  if (isTagged(value, BIGINT)) {
    const digits = value[BIGINT] ?? "";
    return /^-?\d+$/.test(digits) ? BigInt(digits) : undefined;
  }
  const plain = value === null || ["string", "number", "boolean"].includes(typeof value);
  return plain ? value : undefined;
}

/** The cursor that follows `row`: its value of each order column. */
export function encodeCursor(order: OrderBy, row: StorageRow): string {
  const values = order.map(([column]) => pack(row[column]));
  return Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
}

/** The values a cursor holds, or a `VALIDATION` error for a string that is not a cursor of `order`. */
export function decodeCursor(order: OrderBy, cursor: string): CursorValues {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw unreadable(INVALID, ["cursor"]);
  }
  if (!Array.isArray(parsed) || parsed.length !== order.length) {
    throw unreadable(INVALID, ["cursor"]);
  }
  const values = parsed.map(unpack);
  const id = values.at(-1);
  if (values.includes(undefined) || typeof id !== "string" || id.length === 0) {
    throw unreadable(INVALID, ["cursor"]);
  }
  return values;
}

/** Prisma's `orderBy` for `order`: nulls last ascending and first descending, where a column may hold them. */
export function orderByOf(
  order: OrderBy,
  nullable: ReadonlySet<string>,
): Readonly<Record<string, unknown>>[] {
  return order.map(([column, direction]) => ({
    [column]: nullable.has(column)
      ? { sort: direction, nulls: direction === "asc" ? "last" : "first" }
      : direction,
  }));
}

/** The rows strictly after `value` in one column, or `undefined` when none can be. */
function beyond(
  column: string,
  direction: SortDirection,
  value: unknown,
  nullable: boolean,
): StorageWhere | undefined {
  if (direction === "desc") {
    return value === null ? { [column]: { not: null } } : { [column]: { lt: value } };
  }
  if (value === null) {
    return undefined;
  }
  const greater = { [column]: { gt: value } };
  return nullable ? { OR: [greater, { [column]: null }] } : greater;
}

/**
 * The filter matching the rows after `values` in `order`: for each column, the
 * rows equal on every column before it and after it on that one.
 */
export function afterCursor(
  order: OrderBy,
  values: CursorValues,
  nullable: ReadonlySet<string>,
): StorageWhere {
  const branches: StorageWhere[] = [];
  const equal: StorageWhere[] = [];
  for (const [index, [column, direction]] of order.entries()) {
    const value = values[index] ?? null;
    const after = beyond(column, direction, value, nullable.has(column) || value === null);
    if (after !== undefined) {
      branches.push(equal.length === 0 ? after : { AND: [...equal, after] });
    }
    equal.push({ [column]: value });
  }
  return branches.length === 1 ? (branches[0] ?? {}) : { OR: branches };
}
