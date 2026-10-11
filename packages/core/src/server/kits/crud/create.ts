// The read/write kit's `create` (RFC 0003 section 12.1): `db.<model>.create`
// with the caller's input, or what the service's `prepare` makes of it (an
// owner or scope column from the principal, an ordinal from `nextOrdinal`).
// The tracked client records the write, so the flush sends the new row to
// its collections as `added`. A unique violation is `CONFLICT`.
//
// It checks no row of its own (its `id`, when its input has one, names the
// new row), so it checks what it writes (`../columns.ts`; the 5.1 audit's
// CRUD-1): the caller's input holds column values only, and no column the
// policy reads (an owner or access-list column comes only from `prepare`),
// before `prepare` runs; what `prepare` returns holds column values only,
// and each anchor column it sets (an `inherit` parent, an anchored
// collection's scope) names a row on which the caller has the method's row
// level. A service-wide `Admin` passes the last two; an anonymous caller
// names no anchor row.

import { QuickdrawError } from "../../../protocol/errors";
import type { AccessForm } from "../../access/types";
import { checked } from "../../devWarnings";
import type { MaybePromise, Principal } from "../../types";
import {
  checkAnchorColumns,
  checkColumnValues,
  checkLockedColumns,
  columnValueIssues,
} from "../columns";
import { rowLevel } from "./access";
import { crudCall, projectionOf, type KitHandler, type KitHandlerArgs } from "./runtime";

/** `prepare(input, ctx, db)`: the data `create` writes, from the parsed input; `db` is the app's client. */
export type CrudPrepare<Input = never, Ctx = never, Db = unknown> = (
  input: Input,
  ctx: Ctx,
  db: Db,
) => MaybePromise<Readonly<Record<string, unknown>>>;

/** `prepare` as the handler calls it. */
export type AnyPrepare = (
  input: unknown,
  ctx: { readonly principal: Principal | null },
  db: unknown,
) => MaybePromise<unknown>;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The `create` handler, for a method whose access form is `form`. */
export function createHandler(form: AccessForm, prepare: AnyPrepare | undefined): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<unknown> => {
    const call = crudCall(ctx, db);
    const { service } = call.runtime;
    // The caller's input: column values, and none the policy reads.
    const sent = isRecord(input) ? input : {};
    checkColumnValues(service, sent);
    checkLockedColumns(call.runtime, call.principal, sent, { creating: true });
    // The app's prepare is the app's code: its statements are checked.
    const data = prepare === undefined ? input : await checked(() => prepare(input, ctx, db));
    if (!isRecord(data)) {
      throw new QuickdrawError(
        "INTERNAL",
        `The read/write kit's prepare for ${service.name} must return the new row's data`,
      );
    }
    const issues = columnValueIssues(service, data);
    if (issues.length > 0) {
      throw new QuickdrawError(
        "INTERNAL",
        `The read/write kit's prepare for ${service.name} must return column values: ${issues.map((issue) => issue.message).join("; ")}`,
      );
    }
    // What it writes: each parent it names, at the method's row level.
    await checkAnchorColumns(call.runtime, call.principal, data, rowLevel(form, "Moderate"), {
      creating: true,
    });
    const { select } = projectionOf(call, "entity");
    return await call.table.create({ data, select });
  };
  return handler as KitHandler;
}
