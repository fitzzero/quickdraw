// The admin kit's methods on one row (RFC 0003 section 12.4): `adminGet`,
// `adminCreate`, `adminUpdate` and `adminDelete`, through `db.<model>` on the
// dispatcher's tracked client, as 4.1's went through `this.create` and
// `this.update` (`legacy-src/server/BaseService.ts:1393-1417`). The tracked
// client records each write, so the flush sends subscribers and collections
// the same frames as any other write of the row: an admin edit shows live.
//
// Each reads one statement's worth: the row with the entity projection's
// select. A row that is not there is `NOT_FOUND`, a unique violation
// `CONFLICT`, and a value the database refuses `VALIDATION`. A write never
// sets a field the service hides, one an override made read-only, `id` or a
// timestamp (the contract half refuses the last two before the call runs).

import type { IdInput } from "../../../contract/kits/crudSchemas";
import type { AdminCreateQuery, AdminUpdateQuery } from "../../../contract/kits/adminSchemas";
import { requireRow } from "../guards";
import type { KitHandler, KitHandlerArgs } from "../crud/runtime";
import {
  adminCall,
  checkWrite,
  rowOut,
  writeRefusal,
  type AdminCall,
  type AdminContext,
} from "./runtime";

async function readRow(call: AdminCall, id: string): Promise<unknown> {
  const row = await call.table.findUnique({ where: { id }, select: call.projection.select });
  return rowOut(call, requireRow(row, `No such ${call.model}`));
}

/** The `adminGet` handler. */
export function adminGetHandler(context: AdminContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<unknown> => {
    const call = adminCall(ctx, db, context.fields);
    return await readRow(call, (input as IdInput).id);
  };
  return handler as KitHandler;
}

/** The `adminCreate` handler. */
export function adminCreateHandler(context: AdminContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<unknown> => {
    const call = adminCall(ctx, db, context.fields);
    const { data } = input as AdminCreateQuery;
    checkWrite(call, context, data);
    try {
      return rowOut(call, await call.table.create({ data, select: call.projection.select }));
    } catch (error) {
      throw writeRefusal(error);
    }
  };
  return handler as KitHandler;
}

/** The `adminUpdate` handler. A call that changes nothing reads the row instead of writing it. */
export function adminUpdateHandler(context: AdminContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<unknown> => {
    const call = adminCall(ctx, db, context.fields);
    const { id, data } = input as AdminUpdateQuery;
    checkWrite(call, context, data);
    if (Object.keys(data).length === 0) {
      return await readRow(call, id);
    }
    try {
      const select = call.projection.select;
      return rowOut(call, await call.table.update({ where: { id }, data, select }));
    } catch (error) {
      throw writeRefusal(error);
    }
  };
  return handler as KitHandler;
}

/** The `adminDelete` handler. */
export function adminDeleteHandler(context: AdminContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<null> => {
    const call = adminCall(ctx, db, context.fields);
    await call.table.delete({ where: { id: (input as IdInput).id }, select: { id: true } });
    return null;
  };
  return handler as KitHandler;
}
