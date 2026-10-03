// What every handler of the sharing kit starts from (RFC 0003 section 12.3):
// the service its method runs in (found through the call's `ctx`, as the
// read/write kit finds it), the caller, and the transaction a change runs
// in. Every write goes through the dispatcher's tracked client, so the flush
// evicts the access cache, revokes live subscriptions that lost access and
// sends the `via` collection deltas; the kit sends nothing itself.
//
// A change reads the list or the members and writes them back in one
// SERIALIZABLE transaction. PostgreSQL's default isolation (READ COMMITTED)
// would let two changes that run at once both read the old list and the
// second write drop the first (an unshare undone), or two Admin members each
// see the other and both leave. Under SERIALIZABLE the database fails one of
// them instead; the kit answers it `CONFLICT`, and the caller may try again.

import type { SharingChange, SharingOnChange } from "./types";
import { QuickdrawError } from "../../../protocol/errors";
import { kitRuntimeOf, type KitRuntime } from "../../context";
import { modelKey } from "../../storage";
import type { Principal } from "../../types";
import type { KitHandlerArgs, ModelDelegate } from "../crud/runtime";
import type { KitContext } from "../crud/types";
import { inKitTransaction } from "../transactions";

/** One call of a sharing kit method: its service, the caller, and the database client. */
export interface SharingCall {
  readonly runtime: KitRuntime;
  /** The service's model, named as the client names it. */
  readonly model: string;
  readonly principal: Principal | null;
  /** The call's `ctx`, as `resolveUser` and `onChange` receive it. */
  readonly ctx: KitContext;
  /** The dispatcher's tracked database client. */
  readonly db: unknown;
}

/** The sharing kit call `ctx` belongs to. */
export function sharingCall(ctx: KitHandlerArgs["ctx"], db: unknown): SharingCall {
  const runtime = kitRuntimeOf(ctx);
  const model = runtime?.service.model;
  if (runtime === undefined || model === undefined) {
    throw new QuickdrawError(
      "INTERNAL",
      "The sharing kit's handlers run through a dispatcher, in a service with a model",
    );
  }
  return {
    runtime,
    model: modelKey(model),
    principal: ctx.principal,
    ctx: ctx as unknown as KitContext,
    db,
  };
}

/** The delegate of `model` on a database client or a transaction's client. */
export function tableOf(db: unknown, model: string): ModelDelegate {
  const name = modelKey(model);
  const isClient = (typeof db === "object" || typeof db === "function") && db !== null;
  const delegate: unknown = isClient ? Reflect.get(db, name) : undefined;
  const usable =
    typeof delegate === "object" &&
    delegate !== null &&
    typeof (delegate as { readonly findMany?: unknown }).findMany === "function";
  if (!usable) {
    throw new QuickdrawError(
      "INTERNAL",
      `The sharing kit reads and writes through db.${name}, which the dispatcher's database client does not have`,
    );
  }
  return delegate as ModelDelegate;
}

/**
 * Runs `fn` in a SERIALIZABLE interactive transaction of the database
 * client: its writes join the call's unit of work when it commits and are
 * dropped when it rolls back. A transaction the database fails for a
 * concurrent one is `CONFLICT`.
 */
export async function inSerializable<T>(db: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> {
  return await inKitTransaction(db, fn, {
    owner: "The sharing kit's changes",
    conflict: "Another change to this row's access ran at the same time; try again",
  });
}

/** Tells the app's `onChange` about a change, inside its transaction (`tx`). */
export async function notifyChange(
  onChange: SharingOnChange | undefined,
  call: SharingCall,
  change: SharingChange,
  tx: unknown,
): Promise<void> {
  await onChange?.(Object.freeze(change), call.ctx, tx);
}
