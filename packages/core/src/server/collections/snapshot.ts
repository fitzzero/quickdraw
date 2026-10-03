// One page of a collection scope (RFC 0003 section 7.3): the rows of the
// scope (its scope column, or its `via` junction's links, and `where`) in
// `order`, after the cursor when there is one, at most `limit` of them; the
// scope's member count; the cursor of the next page; and, on a first page
// (no cursor) of a collection that declares `index`, the scope's index
// (section 7.4, `index.ts`). The revision is taken by the caller before any
// read, so the page is never older than the revision it claims. 4.1 left all
// of it to each collection's `snapshot` function and clamped only the page
// size (`legacy-src/server/collections.ts:160-171`).
//
// A page costs two statements, the rows and the count, run together, and a
// first page of an indexed collection a third beside them, the index; a
// `via` scope reads its links first. The first page of a scope through an
// adapter that answers `nullable` also asks it about each order column, once
// per process (`StorageAdapter.nullable`).
//
// A cursor is the client's: when the read that applies it fails while the
// count of the same scope succeeds, the cursor's values did not fit the
// order columns, and the request is `VALIDATION`, not a server fault.

import type { CollectionSnapshot, Revision } from "../../protocol/envelope";
import type { StorageAdapter, StorageRow, StorageWhere } from "../storage";
import { unreadable } from "../transports/ack";
import type { BoundCollection } from "./bind";
import { afterCursor, decodeCursor, encodeCursor, orderByOf, type CursorValues } from "./cursor";
import type { ServiceCollection } from "./define";
import { readIndex } from "./index";
import { itemOf, selectWith } from "./items";

const NOT_A_CURSOR = "cursor is not a cursor of this collection";

/** What a page asks for. */
export interface PageRequest {
  readonly scope: string;
  /** The page size; the collection's `limit` when absent. */
  readonly limit?: number;
  /** The cursor of the page before; the first page when absent. */
  readonly cursor?: string;
}

/** The page size used: the request's or the collection's, lowered to `maxLimit` when above it. */
export function pageSize(
  collection: BoundCollection,
  requested: number | undefined,
): { readonly limit: number; readonly clamped: boolean } {
  const limit = requested ?? collection.limit;
  return limit > collection.maxLimit
    ? { limit: collection.maxLimit, clamped: true }
    : { limit, clamped: false };
}

function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The filter matching the members of a scope: its scope column, or the ids
 * its `via` junction links to it, and `where`. `undefined` for a `via` scope
 * with no links: it has no members. The search kit reads a scope's members
 * with it too, through its database client, and passes `maxLinks`: then at
 * most that many links are read, the first by the linked row's id, so one
 * call never reads a scope's every link.
 */
export async function membersWhere(
  storage: Pick<StorageAdapter, "findMany">,
  collection: Pick<ServiceCollection, "scope" | "where">,
  scope: string,
  maxLinks?: number,
): Promise<StorageWhere | undefined> {
  const { where } = collection;
  const filtered = (filter: StorageWhere): StorageWhere =>
    Object.keys(where).length === 0 ? filter : { AND: [filter, where] };
  if (collection.scope.kind === "column") {
    return filtered({ [collection.scope.column]: scope });
  }
  const { model, entry, scope: column } = collection.scope;
  const links = await storage.findMany(model, {
    where: { [column]: scope },
    select: { [entry]: true },
    ...(maxLinks === undefined ? {} : { orderBy: { [entry]: "asc" }, take: maxLinks }),
  });
  const ids = [...new Set(links.map((link) => link[entry]).filter(isId))];
  return ids.length === 0 ? undefined : filtered({ id: { in: ids } });
}

/**
 * The order columns that may hold null, as the adapter answers. A cursor
 * holding null for a column the adapter says cannot hold it is not a cursor
 * of this collection.
 */
async function nullableColumns(
  storage: StorageAdapter,
  collection: BoundCollection,
  values: CursorValues | undefined,
): Promise<Set<string>> {
  const columns = collection.order.map(([column]) => column);
  const answers = await Promise.all(
    columns.map(async (column) =>
      column === "id" ? false : ((await storage.nullable?.(collection.model, column)) ?? false),
    ),
  );
  const nullable = new Set<string>();
  for (const [index, column] of columns.entries()) {
    const known = storage.nullable !== undefined;
    if (values?.[index] === null && known && answers[index] !== true) {
      throw unreadable(NOT_A_CURSOR, ["cursor"]);
    }
    if (answers[index] === true || values?.[index] === null) {
      nullable.add(column);
    }
  }
  return nullable;
}

/** How one page's rows are read: the scope's filter, the cursor's values and the page size. */
interface RowsRead {
  readonly members: StorageWhere;
  readonly values: CursorValues | undefined;
  readonly nullable: ReadonlySet<string>;
  readonly limit: number;
}

/**
 * The page's rows (one more than `limit`, to tell whether a page follows)
 * and the scope's member count. A rows read that applied a cursor and failed
 * while the count succeeded throws `VALIDATION`: the cursor's values do not
 * fit the order columns.
 */
async function readRows(
  storage: StorageAdapter,
  collection: BoundCollection,
  read: RowsRead,
): Promise<{ readonly rows: StorageRow[]; readonly total: number }> {
  const { members, values, nullable, limit } = read;
  const { order } = collection;
  const where =
    values === undefined ? members : { AND: [members, afterCursor(order, values, nullable)] };
  const [rows, total] = await Promise.allSettled([
    storage.findMany(collection.model, {
      where,
      select: selectWith(
        collection.item.select,
        order.map(([column]) => column),
      ),
      orderBy: orderByOf(order, nullable),
      take: limit + 1,
    }),
    storage.count(collection.model, { where: members }),
  ]);
  if (total.status === "rejected") {
    throw total.reason;
  }
  if (rows.status === "fulfilled") {
    return { rows: rows.value, total: total.value };
  }
  if (values === undefined) {
    throw rows.reason;
  }
  const refused = unreadable(NOT_A_CURSOR, ["cursor"]);
  refused.cause = rows.reason;
  throw refused;
}

/**
 * Reads one page of `request.scope` at revision `rev`: its items, the
 * scope's member count, and the next page's cursor (`null` on the last
 * page); on a first page of a collection that declares `index`, its index
 * too. A request above `maxLimit` gets `maxLimit` items and `clamped`.
 * Throws `VALIDATION` for a cursor that is not one of this collection.
 */
export async function readPage(
  storage: StorageAdapter,
  collection: BoundCollection,
  request: PageRequest,
  rev: Revision,
): Promise<CollectionSnapshot> {
  const { limit, clamped } = pageSize(collection, request.limit);
  const { order } = collection;
  const values = request.cursor === undefined ? undefined : decodeCursor(order, request.cursor);
  const nullable = await nullableColumns(storage, collection, values);
  const members = await membersWhere(storage, collection, request.scope);
  const page = { ok: true, rev, limit, ...(clamped ? { clamped: true as const } : {}) } as const;
  const indexed = values === undefined && collection.index !== undefined;
  if (members === undefined) {
    return { ...page, items: [], total: 0, cursor: null, ...(indexed ? { index: [] } : {}) };
  }
  const [{ rows, total }, index] = await Promise.all([
    readRows(storage, collection, { members, values, nullable, limit }),
    indexed ? readIndex(storage, collection, members, nullable, rev) : undefined,
  ]);
  const shown = rows.slice(0, limit);
  const last = shown.at(-1);
  return {
    ...page,
    items: shown.map((row) => itemOf(collection, row)),
    total,
    cursor: rows.length > limit && last !== undefined ? encodeCursor(order, last) : null,
    ...index,
  };
}
