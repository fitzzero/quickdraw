// The handler of each read/write kit method (RFC 0003 section 12.1), from
// what `crud.contract` made it for and the access form `crud.handlers`
// gives it.

import { bulkDeleteHandler, bulkUpdateHandler } from "./bulk";
import { createHandler } from "./create";
import { deleteHandler } from "./delete";
import { getHandler } from "./get";
import { getManyHandler } from "./getMany";
import { listHandler } from "./list";
import { reorderHandler } from "./reorder";
import type { KitHandler } from "./runtime";
import type { MethodContext } from "./types";
import { updateHandler } from "./update";

/** The handler of one kit method: a new function for each call, which `defineService` checks. */
export function handlerOf(context: MethodContext): KitHandler {
  const { spec, form } = context;
  switch (spec.method) {
    case "get":
      return getHandler();
    case "getMany":
      return getManyHandler(form);
    case "list":
      return listHandler({ spec, form, projection: context.projection });
    case "create":
      return createHandler(context.prepare);
    case "update":
      return updateHandler(form);
    case "delete":
      return deleteHandler();
    case "reorder":
      return reorderHandler(spec);
    case "bulkUpdate":
      return bulkUpdateHandler(form);
    default:
      return bulkDeleteHandler(form);
  }
}
