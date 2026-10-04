// The read/write kit's `getMany` (RFC 0003 section 12.1): up to 200 rows by
// id, in the order asked. The caller's level on every id comes from one
// batched policy lookup (`levelsFor`), and the ids it does not reach at the
// method's row level are left out, as are ids with no row: a caller learns
// nothing about rows it may not read. The rows are then read in one
// statement with the entity's select; the framework projects them.

import type { IdsInput } from "../../../contract/kits/crudSchemas";
import type { AccessForm } from "../../access/types";
import { allowedIds, rowLevel } from "./access";
import {
  crudCall,
  projectionOf,
  uniqueIds,
  type KitHandler,
  type KitHandlerArgs,
  type Row,
} from "./runtime";

/** The `getMany` handler. */
export function getManyHandler(form: AccessForm): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<Row[]> => {
    const call = crudCall(ctx, db);
    const ids = uniqueIds((input as IdsInput).ids);
    const allowed = await allowedIds(call, form, ids, rowLevel(form, "Read"), "read");
    if (allowed.length === 0) {
      return [];
    }
    const { select } = projectionOf(call, "entity");
    const rows = await call.table.findMany({ where: { id: { in: allowed } }, select });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return allowed.flatMap((id) => {
      const row = byId.get(id);
      return row === undefined ? [] : [row];
    });
  };
  return handler as KitHandler;
}
