// The read/write kit's `bulkUpdate` and `bulkDelete` (RFC 0003 section
// 12.1): one `updateMany` or `deleteMany` over the ids the caller may write,
// in one transaction with the policy lookup that picked them. Ids the caller
// cannot write at the method's row level (`Moderate` unless the form names
// another), and ids with no row, are skipped, even for a `"public"` method;
// the result counts the rows changed. The tracked client records every row, and a flush touching more
// rows of one collection scope than its `bulkThreshold` sends that scope one
// `reset` instead of a delta per row.

import type { IdsInput } from "../../../contract/kits/crudSchemas";
import type { AccessForm } from "../../access/types";
import { allowedIds, rowLevel } from "./access";
import {
  crudCall,
  delegateOf,
  inTransaction,
  uniqueIds,
  type CrudCall,
  type KitHandler,
  type KitHandlerArgs,
  type ModelDelegate,
} from "./runtime";
import { patchData } from "./update";

interface Counted {
  readonly count: number;
}

/** Runs `write` on the ids among `ids` the caller may write, inside one transaction. */
async function writeAllowed(
  call: CrudCall,
  db: unknown,
  form: AccessForm,
  ids: readonly string[],
  write: (table: ModelDelegate, allowed: readonly string[]) => Promise<Counted>,
): Promise<Counted> {
  const unique = uniqueIds(ids);
  if (unique.length === 0) {
    return { count: 0 };
  }
  return await inTransaction(db, async (tx) => {
    const allowed = await allowedIds(call, form, unique, rowLevel(form, "Moderate"), "write");
    if (allowed.length === 0) {
      return { count: 0 };
    }
    const { count } = await write(delegateOf(tx, call.model), allowed);
    return { count };
  });
}

/** The `bulkUpdate` handler. */
export function bulkUpdateHandler(form: AccessForm): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<Counted> => {
    const call = crudCall(ctx, db);
    const { ids, data } = input as {
      readonly ids: readonly string[];
      readonly data: Readonly<Record<string, unknown>>;
    };
    const patch = patchData(data);
    if (Object.keys(patch).length === 0) {
      return { count: 0 };
    }
    return await writeAllowed(call, db, form, ids, (table, allowed) =>
      table.updateMany({ where: { id: { in: [...allowed] } }, data: patch }),
    );
  };
  return handler as KitHandler;
}

/** The `bulkDelete` handler. */
export function bulkDeleteHandler(form: AccessForm): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<Counted> => {
    const call = crudCall(ctx, db);
    return await writeAllowed(call, db, form, (input as IdsInput).ids, (table, allowed) =>
      table.deleteMany({ where: { id: { in: [...allowed] } } }),
    );
  };
  return handler as KitHandler;
}
