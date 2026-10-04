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
import type { KitHandler, KitHandlerArgs, ModelDelegate } from "../crud/runtime";
import { inKitTransaction } from "../transactions";
import { adminCall, rowOut, rowWhole, tableOf, type AdminCall } from "./runtime";
import type { AdminContext, AdminWrite } from "./types";
import { checkWrite, writeRefusal } from "./writes";

async function readRow(call: AdminCall, id: string): Promise<unknown> {
  const row = await call.table.findUnique({ where: { id }, select: call.projection.select });
  return rowOut(call, requireRow(row, `No such ${call.model}`));
}

/** One write, as a handler makes it: on `table`, reading the row before it when `before` is asked for. */
type Perform = (
  table: ModelDelegate,
  before: boolean,
) => Promise<{
  readonly id: string;
  readonly before?: object | null;
  readonly after: object | null;
  readonly reply: unknown;
}>;

/**
 * Runs one write of `method`: alone without an `onWrite`, else in a
 * transaction with the hook after it, which hears the row before (read in
 * the transaction) and after, every field; a throw undoes the write. The
 * database's refusal of the values is `VALIDATION` either way.
 */
async function written(
  context: AdminContext,
  call: AdminCall,
  args: KitHandlerArgs,
  method: AdminWrite["method"],
  perform: Perform,
): Promise<unknown> {
  const { onWrite } = context;
  const attempt = async (table: ModelDelegate, before: boolean) => {
    try {
      return await perform(table, before);
    } catch (error) {
      throw writeRefusal(error);
    }
  };
  if (onWrite === undefined) {
    return (await attempt(call.table, false)).reply;
  }
  return await inKitTransaction(
    args.db,
    async (tx) => {
      const done = await attempt(tableOf(tx, call.model), method !== "adminCreate");
      const whole = (row: object | null | undefined) => (row ? rowWhole(call, row) : null);
      const write: AdminWrite = {
        method,
        id: done.id,
        ...(method === "adminCreate" ? {} : { before: whole(done.before) }),
        after: whole(done.after),
      };
      await onWrite(write, args.ctx as Parameters<typeof onWrite>[1], tx);
      return done.reply;
    },
    { owner: "The admin kit's writes with onWrite" },
  );
}

/** The `adminGet` handler. */
export function adminGetHandler(context: AdminContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<unknown> => {
    const call = adminCall(ctx, db, context.fields);
    return await readRow(call, (input as IdInput).id);
  };
  return handler as KitHandler;
}

/** The id of a row the kit wrote: it reads the entity projection, which always selects `id`. */
function idOf(row: object): string {
  return String((row as { readonly id?: unknown }).id);
}

/** The `adminCreate` handler. */
export function adminCreateHandler(context: AdminContext): KitHandler {
  const handler = async (args: KitHandlerArgs): Promise<unknown> => {
    const call = adminCall(args.ctx, args.db, context.fields);
    const { data } = args.input as AdminCreateQuery;
    await checkWrite(call, context, data);
    return await written(context, call, args, "adminCreate", async (table) => {
      const after = await table.create({ data, select: call.projection.select });
      return { id: idOf(after), after, reply: rowOut(call, after) };
    });
  };
  return handler as KitHandler;
}

/** The `adminUpdate` handler. A call that changes nothing reads the row instead of writing it. */
export function adminUpdateHandler(context: AdminContext): KitHandler {
  const handler = async (args: KitHandlerArgs): Promise<unknown> => {
    const call = adminCall(args.ctx, args.db, context.fields);
    const { id, data } = args.input as AdminUpdateQuery;
    await checkWrite(call, context, data);
    if (Object.keys(data).length === 0) {
      return await readRow(call, id);
    }
    const { select } = call.projection;
    return await written(context, call, args, "adminUpdate", async (table, withBefore) => {
      const before = withBefore ? await table.findUnique({ where: { id }, select }) : undefined;
      const after = await table.update({ where: { id }, data, select });
      return { id, before, after, reply: rowOut(call, after) };
    });
  };
  return handler as KitHandler;
}

/** The `adminDelete` handler. */
export function adminDeleteHandler(context: AdminContext): KitHandler {
  const handler = async (args: KitHandlerArgs): Promise<unknown> => {
    const call = adminCall(args.ctx, args.db, context.fields);
    const { id } = args.input as IdInput;
    return await written(context, call, args, "adminDelete", async (table, withBefore) => {
      const select = withBefore ? call.projection.select : { id: true };
      const before = await table.delete({ where: { id }, select });
      return { id, ...(withBefore ? { before } : {}), after: null, reply: null };
    });
  };
  return handler as KitHandler;
}
