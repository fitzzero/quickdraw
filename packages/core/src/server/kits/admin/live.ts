// The admin kit's methods on a row's subscribers (RFC 0003 sections 6 and
// 12.4). A subscriber sits in the row's room for its access level
// (`entityRoom(service, id, level)`), so `adminSubscribers` counts the
// sockets in each of those rooms, reading nothing. 4.1 listed each socket and
// user from a per-entity map (4.1 `src/server/BaseService.ts:1448-1464`),
// which 5.0 does not keep. The counts are this process's: behind a cluster
// adapter (Redis) another server's sockets are invisible here, and the reply
// says so (`complete: false`).
//
// `adminReemit` records a touch of the row (`ctx.touch`), so the call's flush
// reads it and sends it whole to every subscriber and collection, as after
// any write; 4.1 emitted it by hand (`BaseService.ts:1470-1485`). A row that
// is not there is `NOT_FOUND` (one statement).

import type { IdInput } from "../../../contract/kits/crudSchemas";
import type { AdminSubscribers } from "../../../contract/kits/adminSchemas";
import { entityRoom } from "../../../contract/names";
import type { AnyContext } from "../../context";
import { SUBSCRIBER_LEVELS } from "../../emit/tiers";
import { requireRow } from "../guards";
import type { KitHandler, KitHandlerArgs } from "../crud/runtime";
import { adminCall, type AdminCall } from "./runtime";
import type { AdminContext } from "./types";

/** The sockets subscribed to row `id`, per level. */
function subscribersOf(call: AdminCall, id: string): AdminSubscribers {
  const { occupancy, service } = call.runtime;
  const counted = SUBSCRIBER_LEVELS.map(
    (level) => [level, occupancy?.sockets(entityRoom(service.name, id, level)) ?? 0] as const,
  );
  return {
    id,
    count: counted.reduce((sum, [, count]) => sum + count, 0),
    levels: Object.fromEntries(counted) as AdminSubscribers["levels"],
    complete: occupancy?.complete() ?? true,
  };
}

/** The `adminSubscribers` handler. */
export function adminSubscribersHandler(context: AdminContext): KitHandler {
  const handler = ({ input, ctx, db }: KitHandlerArgs): Promise<AdminSubscribers> => {
    const call = adminCall(ctx, db, context.fields);
    return Promise.resolve(subscribersOf(call, (input as IdInput).id));
  };
  return handler as KitHandler;
}

/** The `adminReemit` handler. */
export function adminReemitHandler(context: AdminContext): KitHandler {
  const handler = async ({ input, ctx, db }: KitHandlerArgs): Promise<AdminSubscribers> => {
    const call = adminCall(ctx, db, context.fields);
    const { id } = input as IdInput;
    requireRow(
      await call.table.findUnique({ where: { id }, select: { id: true } }),
      `No such ${call.model}`,
    );
    (ctx as Partial<Pick<AnyContext, "touch">>).touch?.(call.model, [id]);
    return subscribersOf(call, id);
  };
  return handler as KitHandler;
}
