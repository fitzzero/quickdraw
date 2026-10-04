// The collection index (RFC 0003 section 7.4): one small row per member of a
// scope, `[id, rev, ...index fields]` in `order`, sent whole with the first
// page of the scope. A client then knows the scope's membership and order at
// once, filters it by views without asking the server, and loads full items
// by window, by id (`qd:col:items`) or all at once. 4.1 had nothing like it:
// a board loaded page after page, and mirrored the server's filters to know
// what it held.
//
// Deltas keep the index live, from the same flush batch as the items: an
// `added` delta carries its member's index row, built from the very item it
// sends (`deltas.ts`), and `patched` and `updated` deltas carry every changed
// index field, since index fields are item fields the items carry
// (`define.ts`). So an index row and its item never disagree.
//
// An index row's `rev` is the time in the service's `versionColumn` when it
// declares one, else the revision the snapshot (or the flush, for an `added`
// delta) was read at. Index fields are read with the item's own select for
// them (the item's whole select when it has a `map`) and projected and
// stripped as items are.
//
// A snapshot's index is one more statement, run beside the page and the
// count. It holds at most {@link INDEX_MAX_ROWS} rows: a larger scope gets
// `indexTruncated: true` instead, and is loaded by pages.

import type { Revision, WireIndexRow } from "../../protocol/envelope";
import { versionTime } from "../rev";
import type { StorageAdapter, StorageRow, StorageWhere } from "../storage";
import type { BoundCollection } from "./bind";
import { orderByOf } from "./cursor";
import { itemOf, selectWith } from "./items";

/** The most members a scope's index holds; a larger scope's first page says `indexTruncated`. */
export const INDEX_MAX_ROWS = 50_000;

/** What a first page carries besides its items: the scope's index, or that it was too large for one. */
export type IndexPart =
  | { readonly index: readonly WireIndexRow[] }
  | { readonly indexTruncated: true };

type Values = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Values {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The columns a read of an indexed collection's rows adds to the item's
 * select, so the index rows built from them carry their version: the
 * service's `versionColumn`, or none.
 */
export function indexColumns(collection: BoundCollection): readonly string[] {
  const { versionColumn } = collection.service;
  return collection.index === undefined || versionColumn === undefined ? [] : [versionColumn];
}

/** What an index read selects: `id` and the item's select for each index field, or its whole select when it maps. */
function indexSelect(collection: BoundCollection, fields: readonly string[]): Values {
  const { item } = collection;
  const select =
    item.map === undefined
      ? Object.fromEntries(
          fields.flatMap((field) =>
            item.select[field] === undefined ? [] : [[field, item.select[field]]],
          ),
        )
      : item.select;
  return selectWith(select, indexColumns(collection));
}

/**
 * The index row of a member, from the item it is sent as (`item`, built from
 * `row`) and `rev`, the revision `row` was read at: its version column's time
 * instead, when the service declares one. A field the item lacks is `null`.
 */
export function indexRowFrom(
  collection: BoundCollection,
  item: unknown,
  row: StorageRow,
  rev: Revision,
): WireIndexRow {
  const values = isRecord(item) ? item : {};
  const { versionColumn } = collection.service;
  const version = versionColumn === undefined ? undefined : versionTime(row[versionColumn]);
  const id = typeof row.id === "string" ? row.id : "";
  return [id, version ?? rev, ...(collection.index ?? []).map((field) => values[field] ?? null)];
}

/**
 * Reads the index of the scope `members` matches, in `order` (`nullable`
 * holds the order columns that may hold null), at revision `rev`: one
 * statement. More than `max` members give `indexTruncated` instead.
 */
export async function readIndex(
  storage: StorageAdapter,
  collection: BoundCollection,
  members: StorageWhere,
  nullable: ReadonlySet<string>,
  rev: Revision,
  max = INDEX_MAX_ROWS,
): Promise<IndexPart> {
  const fields = collection.index ?? [];
  const rows = await storage.findMany(collection.model, {
    where: members,
    select: indexSelect(collection, fields),
    orderBy: orderByOf(collection.order, nullable),
    take: max + 1,
  });
  if (rows.length > max) {
    return { indexTruncated: true };
  }
  return {
    index: rows.flatMap((row) =>
      typeof row.id === "string"
        ? [indexRowFrom(collection, itemOf(collection, row), row, rev)]
        : [],
    ),
  };
}
