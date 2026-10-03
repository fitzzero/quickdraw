// The read/write kit's `update` (RFC 0003 section 12.1): `db.<model>.update`
// with the fields the call gives (the app's patch schema decides which). The
// tracked client records the changed fields, so subscribers get a patch
// (`p`) and collections a `patched` delta. A row that is not there is
// `NOT_FOUND`, a unique violation `CONFLICT`. A call that changes nothing
// reads the row instead of writing it.

import { requireRow } from "../guards";
import { crudCall, projectionOf, type KitHandler, type KitHandlerArgs } from "./runtime";

/** The fields a patch sets: its keys with a value, never `id`. */
export function patchData(patch: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(patch).filter(([key, value]) => key !== "id" && value !== undefined),
  );
}

/** The `update` handler. */
export function updateHandler(): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<unknown> => {
    const call = crudCall(ctx, db);
    const { id, ...patch } = input as { readonly id: string } & Record<string, unknown>;
    const data = patchData(patch);
    const { select } = projectionOf(call, "entity");
    if (Object.keys(data).length === 0) {
      return requireRow(
        await call.table.findUnique({ where: { id }, select }),
        `No such ${call.model}`,
      );
    }
    return await call.table.update({ where: { id }, data, select });
  };
  return handler as KitHandler;
}
