// The read/write kit's `delete` (RFC 0003 section 12.1): `db.<model>.delete`.
// The tracked client records it, so subscribers get `r` and collections a
// `removed` delta. A row that is not there is `NOT_FOUND`. There is no soft
// delete: no consumer app uses one.

import type { IdInput } from "../../../contract/kits/crudSchemas";
import type { AccessForm } from "../../access/types";
import { checkRowWrite } from "./access";
import { crudCall, type KitHandler, type KitHandlerArgs } from "./runtime";

/** The `delete` handler: the caller needs the method's row level on the row whatever the form. */
export function deleteHandler(form: AccessForm): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<null> => {
    const call = crudCall(ctx, db);
    const { id } = input as IdInput;
    await checkRowWrite(call, form, id);
    await call.table.delete({ where: { id }, select: { id: true } });
    return null;
  };
  return handler as KitHandler;
}
