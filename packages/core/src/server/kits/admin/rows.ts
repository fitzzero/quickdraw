// The admin kit's methods on one row (RFC 0003 section 12.4): `adminGet`,
// `adminCreate`, `adminUpdate` and `adminDelete`, through `db.<model>` on the
// dispatcher's tracked client, as 4.1's went through `this.create` and
// `this.update` (4.1 `src/server/BaseService.ts:1393-1417`). The tracked
// client records each write, so the flush sends subscribers and collections
// the same frames as any other write of the row: an admin edit shows live.
//
// Each reads one statement's worth: the row with the entity projection's
// select. A row that is not there is `NOT_FOUND`, a unique violation
// `CONFLICT`, and a value the database refuses `VALIDATION`. A write never
// sets a field the service hides, one an override made read-only, `id` or a
// timestamp (the contract half refuses the last two before the call runs).
//
// With a hook (`prepare`, `onWrite` or `onCommitted`) a write runs in a
// transaction, which reads the row before it: `prepare` first, which may add
// column values to the write and write other rows through the transaction's
// tracked client (the rows a database cascade would delete unseen), then the
// write, then `onWrite`. Statements: one per write without a hook; with one,
// a read of the row before an `adminUpdate`, and before an `adminDelete`
// that `prepare` hears (one that only `onWrite` or `onCommitted` hears reads
// it as it deletes), plus the hooks' own.

import type { IdInput } from "../../../contract/kits/crudSchemas";
import type { AdminCreateQuery, AdminUpdateQuery } from "../../../contract/kits/adminSchemas";
import { requireRow } from "../guards";
import type { KitHandler, KitHandlerArgs, ModelDelegate } from "../crud/runtime";
import { kitRuntimeOf } from "../../context";
import { inKitTransaction } from "../transactions";
import { adminCall, rowOut, rowWhole, tableOf, type AdminCall } from "./runtime";
import type { AdminContext, AdminPrepare, AdminPrepareCall, AdminWrite } from "./types";
import { checkWrite, prepareWrite, writeRefusal } from "./writes";
import { errorText } from "../../../contract/logger";

async function readRow(call: AdminCall, id: string): Promise<unknown> {
  const row = await call.table.findUnique({ where: { id }, select: call.projection.select });
  return rowOut(call, requireRow(row, `No such ${call.model}`));
}

/** The column values a write sets. */
type Data = Readonly<Record<string, unknown>>;

/** One write, as its handler names it: the method, the row, and the caller's checked data. */
type WriteCall =
  | { readonly method: "adminCreate"; readonly data: Data }
  | { readonly method: "adminUpdate"; readonly id: string; readonly data: Data }
  | { readonly method: "adminDelete"; readonly id: string };

/** What a handler's write is given. */
interface WriteArgs {
  /** The model's delegate: on the dispatcher's client, or on the hooks' transaction. */
  readonly table: ModelDelegate;
  /** What `adminCreate` and `adminUpdate` set: the caller's data, with `prepare`'s columns over it. */
  readonly values: Data;
  /** True when the write returns the row before it: an `adminDelete` a hook hears, its row not read first. */
  readonly before: boolean;
}

/** One write, as a handler makes it. */
type Perform = (args: WriteArgs) => Promise<{
  readonly id: string;
  readonly before?: object | null;
  readonly after: object | null;
  readonly reply: unknown;
}>;

/**
 * Hands a committed write to `onCommitted`, in a detached unit of work of
 * the dispatcher the call runs in: the reply does not wait for it, and a
 * throw (or a rejection) is logged with the call's logger, never the
 * caller's.
 */
function committed(context: AdminContext, args: KitHandlerArgs, write: AdminWrite): void {
  const { onCommitted } = context;
  if (onCommitted === undefined) {
    return;
  }
  const ctx = args.ctx as Parameters<typeof onCommitted>[1];
  const run = kitRuntimeOf(args.ctx)?.runDetached ?? ((fn: () => unknown) => Promise.resolve(fn()));
  const failed = (error: unknown): void => {
    ctx.log.error("The admin kit's onCommitted failed; the write stands", {
      category: "quickdraw.admin",
      method: write.method,
      id: write.id,
      error: errorText(error),
    });
  };
  try {
    run(() => onCommitted(write, ctx)).catch(failed);
  } catch (error) {
    failed(error);
  }
}

/**
 * The row before an `adminUpdate`, or before an `adminDelete` that
 * `prepare` hears, read in the write's transaction (`NOT_FOUND` when there
 * is none, before any hook runs); `undefined` for an `adminCreate`, and for
 * an `adminDelete` only `onWrite` or `onCommitted` hears, which reads it as
 * it deletes.
 */
async function rowBefore(
  context: AdminContext,
  call: AdminCall,
  table: ModelDelegate,
  write: WriteCall,
): Promise<object | undefined> {
  const readsAsItDeletes = write.method === "adminDelete" && context.prepare === undefined;
  if (write.method === "adminCreate" || readsAsItDeletes) {
    return undefined;
  }
  const row = await table.findUnique({ where: { id: write.id }, select: call.projection.select });
  return requireRow(row, `No such ${call.model}`);
}

/** What `prepare` hears of a write: a frozen copy of the caller's data, so it changes nothing in place. */
function prepareCall(write: WriteCall, before: unknown): AdminPrepareCall {
  if (write.method === "adminCreate") {
    return Object.freeze({ method: write.method, data: Object.freeze({ ...write.data }) });
  }
  if (write.method === "adminUpdate") {
    const data = Object.freeze({ ...write.data });
    return Object.freeze({ method: write.method, id: write.id, data, before });
  }
  return Object.freeze({ method: write.method, id: write.id, before });
}

/**
 * Runs one write: alone without a hook, else in a transaction that reads the
 * row before it (`rowBefore`), runs `prepare` when given (whose column values
 * the write sets over the caller's: `prepareWrite`), makes the write and runs
 * `onWrite`, which hears the row before and after, every field; a throw in
 * any of them undoes it all. Once it committed, `onCommitted` hears the same
 * (`committed`). The database's refusal of the values is `VALIDATION` either
 * way.
 */
async function written(
  context: AdminContext,
  call: AdminCall,
  args: KitHandlerArgs,
  write: WriteCall,
  perform: Perform,
): Promise<unknown> {
  const { prepare, onWrite, onCommitted } = context;
  const data = write.method === "adminDelete" ? {} : write.data;
  const attempt = async (table: ModelDelegate, values: Data, before: boolean) => {
    try {
      return await perform({ table, values, before });
    } catch (error) {
      throw writeRefusal(error);
    }
  };
  if (prepare === undefined && onWrite === undefined && onCommitted === undefined) {
    return (await attempt(call.table, data, false)).reply;
  }
  const ctx = args.ctx as Parameters<AdminPrepare>[1];
  let heard: AdminWrite | undefined;
  const reply = await inKitTransaction(
    args.db,
    async (tx) => {
      const table = tableOf(tx, call.model);
      const whole = (row: object | null | undefined) => (row ? rowWhole(call, row) : null);
      const first = await rowBefore(context, call, table, write);
      const before = first === undefined ? undefined : whole(first);
      const values = await prepareWrite(call, context, prepareCall(write, before), ctx, tx);
      const done = await attempt(
        table,
        values,
        write.method === "adminDelete" && first === undefined,
      );
      heard = {
        method: write.method,
        id: done.id,
        ...(write.method === "adminCreate" ? {} : { before: before ?? whole(done.before) }),
        after: whole(done.after),
      };
      await onWrite?.(heard, ctx, tx);
      return done.reply;
    },
    { owner: "The admin kit's writes with prepare, onWrite or onCommitted" },
  );
  if (heard !== undefined) {
    committed(context, args, heard);
  }
  return reply;
}

/** The `adminGet` handler. */
export function adminGetHandler(context: AdminContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<unknown> => {
    const call = adminCall(ctx, db, context.fieldsFor);
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
    const call = adminCall(args.ctx, args.db, context.fieldsFor);
    const { data } = args.input as AdminCreateQuery;
    await checkWrite(call, context, data);
    const { select } = call.projection;
    const write = { method: "adminCreate", data } as const;
    return await written(context, call, args, write, async ({ table, values }) => {
      const after = await table.create({ data: values, select });
      return { id: idOf(after), after, reply: rowOut(call, after) };
    });
  };
  return handler as KitHandler;
}

/**
 * The `adminUpdate` handler. A call that changes nothing reads the row
 * instead of writing it, and runs no hook.
 */
export function adminUpdateHandler(context: AdminContext): KitHandler {
  const handler = async (args: KitHandlerArgs): Promise<unknown> => {
    const call = adminCall(args.ctx, args.db, context.fieldsFor);
    const { id, data } = args.input as AdminUpdateQuery;
    await checkWrite(call, context, data);
    if (Object.keys(data).length === 0) {
      return await readRow(call, id);
    }
    const { select } = call.projection;
    const write = { method: "adminUpdate", id, data } as const;
    return await written(context, call, args, write, async ({ table, values }) => {
      const after = await table.update({ where: { id }, data: values, select });
      return { id, after, reply: rowOut(call, after) };
    });
  };
  return handler as KitHandler;
}

/** The `adminDelete` handler. */
export function adminDeleteHandler(context: AdminContext): KitHandler {
  const handler = async (args: KitHandlerArgs): Promise<unknown> => {
    const call = adminCall(args.ctx, args.db, context.fieldsFor);
    const { id } = args.input as IdInput;
    const write = { method: "adminDelete", id } as const;
    return await written(context, call, args, write, async ({ table, before }) => {
      const select = before ? call.projection.select : { id: true };
      const row = await table.delete({ where: { id }, select });
      return { id, ...(before ? { before: row } : {}), after: null, reply: null };
    });
  };
  return handler as KitHandler;
}
