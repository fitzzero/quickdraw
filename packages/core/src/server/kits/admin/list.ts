// The admin kit's `adminList` (RFC 0003 section 12.4): one page of every row
// of the service, by page number, with the total. The page arithmetic is
// 4.1's (`legacy-src/server/BaseService.ts:1367-1388`): `skip` is
// `(page - 1) * pageSize`, and `totalPages` is `ceil(total / pageSize)`; a
// page past the last is empty. The rest is the read/write kit's list
// machinery (`../crud/listQuery.ts`, `../crud/page.ts`): the filter is
// equality on the declared fields and the sort a declared field, then `id`,
// so the order is total and pages never overlap; a filter or sort on a field
// above the caller's level is `FORBIDDEN`, and a default sort on one falls
// back to `id` (its order would tell what the field holds). 4.1 passed the
// caller's `where` and `orderBy` to the database as they came.
//
// Statements: two, run together: the page's rows and the count.

import type { AdminListQuery, AdminPage } from "../../../contract/kits/adminSchemas";
import { orderByOf } from "../../collections/cursor";
import { selectWith } from "../../collections/items";
import { defaultSorts, listOrder, listWhere, namedFields } from "../crud/listQuery";
import { refusal } from "../crud/page";
import type { KitHandler, KitHandlerArgs, Row } from "../crud/runtime";
import { adminCall, checkSeen, rowOut } from "./runtime";
import type { AdminContext } from "./types";

/** Plain directions: an offset page needs no explicit place for nulls, only a total order. */
const NO_NULLABLE: ReadonlySet<string> = new Set();

/** The `adminList` handler. */
export function adminListHandler(context: AdminContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<AdminPage<unknown>> => {
    const call = adminCall(ctx, db, context.fields);
    const query = input as AdminListQuery;
    checkSeen(call, namedFields(query));
    const order = listOrder(defaultSorts(context.spec.sort, call.unseen), query.sort);
    const where = listWhere(query.filter, undefined);
    const select = selectWith(
      call.projection.select,
      order.map(([column]) => column),
    );
    let rows: Row[];
    let total: number;
    try {
      [rows, total] = await Promise.all([
        call.table.findMany({
          where,
          select,
          orderBy: orderByOf(order, NO_NULLABLE),
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        call.table.count({ where }),
      ]);
    } catch (error) {
      throw refusal(error, { cursor: undefined, filtered: Object.keys(query.filter).length > 0 });
    }
    return {
      items: rows.map((row) => rowOut(call, row)),
      total,
      page: query.page,
      pageSize: query.pageSize,
      totalPages: Math.ceil(total / query.pageSize),
    };
  };
  return handler as KitHandler;
}
