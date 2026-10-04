// The read/write kit's `create` (RFC 0003 section 12.1): `db.<model>.create`
// with the caller's input, or what the service's `prepare` makes of it (an
// owner or scope column from the principal, an ordinal from `nextOrdinal`).
// The tracked client records the write, so the flush sends the new row to
// its collections as `added`. A unique violation is `CONFLICT`.

import { QuickdrawError } from "../../../protocol/errors";
import { checked } from "../../devWarnings";
import type { MaybePromise, Principal } from "../../types";
import { crudCall, projectionOf, type KitHandler, type KitHandlerArgs } from "./runtime";

/** `prepare(input, ctx, db)`: the data `create` writes, from the parsed input. */
export type CrudPrepare<Input = never, Ctx = never> = (
  input: Input,
  ctx: Ctx,
  db: unknown,
) => MaybePromise<Readonly<Record<string, unknown>>>;

/** `prepare` as the handler calls it. */
export type AnyPrepare = (
  input: unknown,
  ctx: { readonly principal: Principal | null },
  db: unknown,
) => MaybePromise<unknown>;

/** The `create` handler. */
export function createHandler(prepare: AnyPrepare | undefined): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<unknown> => {
    const call = crudCall(ctx, db);
    // The app's prepare is the app's code: its statements are checked.
    const data = prepare === undefined ? input : await checked(() => prepare(input, ctx, db));
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new QuickdrawError(
        "INTERNAL",
        `The read/write kit's prepare for ${call.runtime.service.name} must return the new row's data`,
      );
    }
    const { select } = projectionOf(call, "entity");
    return await call.table.create({ data, select });
  };
  return handler as KitHandler;
}
