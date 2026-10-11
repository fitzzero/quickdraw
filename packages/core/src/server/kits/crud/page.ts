// One page of rows by keyset cursor (RFC 0003 sections 7.3 and 12.1), for
// the read/write kit's `list` and the kits built on it (search). It reuses
// the collections' cursor (`collections/cursor.ts`): a cursor holds the last
// row's value of each order column, `id` last, so the next page starts right
// after that row however many rows are inserted or removed before it.
//
// A list can be sorted several ways, so its cursors also name the order they
// were made for; a cursor from another order, or any string that is not a
// cursor, is `VALIDATION`. So is a filter value or cursor value the
// database refuses for its column's type.
//
// A page costs one statement, plus a second when the call counts the rows,
// run beside the first. The first page of a sort on an optional column also
// asks the storage adapter once per process whether it may hold null.
//
// A cursor longer than a cursor may be (`MAX_CURSOR_LENGTH`: a sort value
// of thousands of characters) names its row instead of holding its values,
// so paging goes on (the 5.1 audit's CRUD-8: such a cursor was refused).
// The next page reads that row's order values first, inside the list's own
// filter, so the row must still be one the caller may list: one more
// statement, and `VALIDATION` once the row has left the list.

import type { OrderBy } from "../../../contract/collections";
import { MAX_CURSOR_LENGTH } from "../../../contract/kits/crudList";
import { QuickdrawError } from "../../../protocol/errors";
import { afterCursor, decodeCursor, encodeCursor, orderByOf } from "../../collections/cursor";
import type { StorageAdapter, StorageWhere } from "../../storage";
import { unreadable } from "../../transports/ack";
import type { ModelDelegate, Row } from "./runtime";

/** What one page reads. */
export interface PageRead {
  readonly table: ModelDelegate;
  /** The model, named as the client names it, for the storage adapter's `nullable`. */
  readonly model: string;
  readonly storage: StorageAdapter | undefined;
  /** The rows to page through: the caller's filter and the access filter. */
  readonly where: StorageWhere;
  /** Sort columns ending in `id`. */
  readonly order: OrderBy;
  readonly cursor: string | undefined;
  readonly limit: number;
  /** What each row is read with; it must include every order column. */
  readonly select: Readonly<Record<string, unknown>>;
  /** Count every row `where` matches, too. */
  readonly totalCount: boolean;
  /**
   * Whether `where` holds values the caller sent (a filter): a database
   * refusal of them, like one of the cursor's, is then `VALIDATION`.
   */
  readonly filtered: boolean;
}

/** One page of rows. */
export interface RowsPage {
  readonly rows: Row[];
  /** The cursor of the next page, or `null` on the last one. */
  readonly nextCursor: string | null;
  readonly totalCount?: number;
}

const SIGNATURE = "~order";

const NOT_A_CURSOR = "cursor is not a cursor of this list in this order";

/** The order a cursor was made for, as the cursor carries it. */
function signatureOf(order: OrderBy): string {
  return order.map(([column, direction]) => `${column} ${direction}`).join(",");
}

/** `order` with the signature as a first, pseudo column. */
function signed(order: OrderBy): OrderBy {
  return [[SIGNATURE, "asc"], ...order] as unknown as OrderBy;
}

/** How a cursor that names its row is signed: this, then the order's signature. */
const ROW = "row ";

/** The shape of a cursor that names its row: its signature, then the row's id. */
const ROW_CURSOR = [
  [SIGNATURE, "asc"],
  ["id", "asc"],
] as unknown as OrderBy;

/**
 * The cursor of the page after `row`: its order values, or, when they would
 * make the cursor longer than `MAX_CURSOR_LENGTH`, its id.
 */
export function cursorAfter(order: OrderBy, row: Row): string {
  const cursor = encodeCursor(signed(order), { ...row, [SIGNATURE]: signatureOf(order) });
  return cursor.length <= MAX_CURSOR_LENGTH
    ? cursor
    : encodeCursor(ROW_CURSOR, { [SIGNATURE]: `${ROW}${signatureOf(order)}`, id: row.id });
}

/** What a cursor holds: the order values of the row before the page, or that row's id. */
type CursorHeld = { readonly values: readonly unknown[] } | { readonly row: string };

/** What a cursor of `order` holds, or `VALIDATION` for one that is not a cursor of `order`. */
export function readCursor(order: OrderBy, cursor: string): CursorHeld {
  const signature = signatureOf(order);
  const decoded = (shape: OrderBy): readonly unknown[] | undefined => {
    try {
      return decodeCursor(shape, cursor);
    } catch {
      return undefined;
    }
  };
  const values = decoded(signed(order));
  if (values?.[0] === signature) {
    return { values: values.slice(1) };
  }
  const named = decoded(ROW_CURSOR);
  if (named?.[0] === `${ROW}${signature}` && typeof named[1] === "string") {
    return { row: named[1] };
  }
  throw unreadable(NOT_A_CURSOR, ["cursor"]);
}

/**
 * The order columns that may hold null, as the storage adapter answers. A
 * cursor holding null for a column the adapter says cannot hold it is not a
 * cursor of this list.
 */
async function nullableColumns(
  read: PageRead,
  values: readonly unknown[] | undefined,
): Promise<Set<string>> {
  const { storage, model, order } = read;
  const nullable = new Set<string>();
  for (const [index, [column]] of order.entries()) {
    const value = values?.[index];
    const known = column === "id" ? false : await storage?.nullable?.(model, column);
    if (value === null && known === false) {
      throw unreadable(NOT_A_CURSOR, ["cursor"]);
    }
    if (known === true || value === null) {
      nullable.add(column);
    }
  }
  return nullable;
}

/**
 * A database refusal of the caller's values (a filter or a cursor), as
 * `VALIDATION`; anything else unchanged. The admin kit's `adminList` too.
 */
export function refusal(error: unknown, read: Pick<PageRead, "cursor" | "filtered">): unknown {
  const isValidation = error instanceof Error && error.name === "PrismaClientValidationError";
  if (!isValidation || (read.cursor === undefined && !read.filtered)) {
    return error;
  }
  const refused = new QuickdrawError(
    "VALIDATION",
    "The filter or the cursor does not fit its fields",
    {
      issues: [
        {
          path: read.cursor === undefined ? ["filter"] : [],
          message: "A filter or cursor value does not fit its field's type",
        },
      ],
    },
  );
  refused.cause = error;
  return refused;
}

/**
 * The order values a page starts after: the cursor's, or those of the row it
 * names, read inside the list's filter (`VALIDATION` once it has left).
 */
async function startValues(read: PageRead, cursor: string): Promise<readonly unknown[]> {
  const held = readCursor(read.order, cursor);
  if ("values" in held) {
    return held.values;
  }
  let row: Row | null;
  try {
    row = await read.table.findFirst({
      where: { AND: [read.where, { id: held.row }] },
      select: Object.fromEntries(read.order.map(([column]) => [column, true])),
    });
  } catch (error) {
    throw refusal(error, read);
  }
  if (row === null) {
    throw unreadable(NOT_A_CURSOR, ["cursor"]);
  }
  return read.order.map(([column]) => row[column]);
}

/** Reads one page: `limit` rows after the cursor, in `order`, the next cursor, and the count when asked. */
export async function readPage(read: PageRead): Promise<RowsPage> {
  const values = read.cursor === undefined ? undefined : await startValues(read, read.cursor);
  const nullable = await nullableColumns(read, values);
  const where =
    values === undefined
      ? read.where
      : { AND: [read.where, afterCursor(read.order, values, nullable)] };
  let rows: Row[];
  let total: number | undefined;
  try {
    [rows, total] = await Promise.all([
      read.table.findMany({
        where,
        select: read.select,
        orderBy: orderByOf(read.order, nullable),
        take: read.limit + 1,
      }),
      read.totalCount ? read.table.count({ where: read.where }) : undefined,
    ]);
  } catch (error) {
    throw refusal(error, read);
  }
  const shown = rows.slice(0, read.limit);
  const last = shown.at(-1);
  return {
    rows: shown,
    nextCursor:
      rows.length > read.limit && last !== undefined ? cursorAfter(read.order, last) : null,
    ...(total === undefined ? {} : { totalCount: total }),
  };
}
