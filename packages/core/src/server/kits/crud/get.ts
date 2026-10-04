// The read/write kit's `get` (RFC 0003 section 12.1): one row by id, read
// with its projection's select (one statement). Its access form decides who
// may read the row; `{ entry: "Read" }` checks the row itself. A row that is
// not there is `NOT_FOUND` (for a caller the form let through: an `entry`
// check already refuses a missing row with `FORBIDDEN`).

import type { IdInput } from "../../../contract/kits/crudSchemas";
import { requireRow } from "../guards";
import { crudCall, projectionOf, type KitHandler, type KitHandlerArgs } from "./runtime";

/** The `get` handler. */
export function getHandler(): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<unknown> => {
    const call = crudCall(ctx, db);
    const { id } = input as IdInput;
    const { select } = projectionOf(call, "entity");
    return requireRow(
      await call.table.findUnique({ where: { id }, select }),
      `No such ${call.model}`,
    );
  };
  return handler as KitHandler;
}
