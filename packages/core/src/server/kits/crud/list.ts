// The read/write kit's `list` (RFC 0003 section 12.1): one page of the rows
// the caller may read, filtered and sorted by the fields the contract
// declares, by keyset cursor (`page.ts`). The trap it exists to close: the
// policy's `accessWhere` is part of every read, so a list never returns a row
// `get` would refuse. Items are the declared projection's rows (its select,
// its map, dates as ISO strings), stripped of the fields above the level
// the page was filtered at.
//
// Statements: the access filter's own reads (none for `owner` and `jsonAcl`
// policies or a service-wide `Admin` grant), then one for the page, and one
// more beside it when the call asks for `totalCount`.

import type { CrudSpec } from "../../../contract/kits/crud";
import type { ListPage, ListQuery } from "../../../contract/kits/crudList";
import type { AccessForm } from "../../access/types";
import { selectWith } from "../../collections/items";
import { projectRow, type Projection } from "../../emit/projection";
import { strip } from "../../emit/tiers";
import { readerLevel, rowLevel, rowsWhere } from "./access";
import { listOrder, listWhere } from "./listQuery";
import { readPage } from "./page";
import { crudCall, projectionOf, type KitHandler, type KitHandlerArgs } from "./runtime";

/** What a `list` handler is made from. */
export interface ListContext {
  readonly spec: Extract<CrudSpec, { method: "list" }>;
  readonly form: AccessForm;
  /** The projection the items are: `"entity"` or one of the contract's. */
  readonly projection: string;
}

/** One row of a page as an item: projected, without the `hidden` fields. The search kit's too. */
export function pageItem(
  projection: Projection,
  row: object,
  hidden: ReadonlySet<string>,
): unknown {
  const item = projectRow(projection, row);
  return typeof item === "object" && item !== null
    ? strip(item as Readonly<Record<string, unknown>>, hidden)
    : item;
}

function emptyPage(query: ListQuery): ListPage<never> {
  return { items: [], nextCursor: null, ...(query.totalCount ? { totalCount: 0 } : {}) };
}

/** The `list` handler. */
export function listHandler(context: ListContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<ListPage<unknown>> => {
    const call = crudCall(ctx, db);
    const query = input as ListQuery;
    const level = rowLevel(context.form, "Read");
    const access = await rowsWhere(call, context.form, level);
    if (access === "none") {
      return emptyPage(query);
    }
    const projection = projectionOf(call, context.projection);
    const order = listOrder(context.spec.sort, query.sort);
    const page = await readPage({
      table: call.table,
      model: call.model,
      storage: call.runtime.storage,
      where: listWhere(query.filter, access),
      order,
      cursor: query.cursor,
      limit: query.limit,
      select: selectWith(
        projection.select,
        order.map(([column]) => column),
      ),
      totalCount: query.totalCount,
      filtered: Object.keys(query.filter).length > 0,
    });
    const hidden = projection.tiers.hidden(readerLevel(call, context.form, level));
    return {
      items: page.rows.map((row) => pageItem(projection, row, hidden)),
      nextCursor: page.nextCursor,
      ...(page.totalCount === undefined ? {} : { totalCount: page.totalCount }),
    };
  };
  return handler as KitHandler;
}
