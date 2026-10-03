// What every handler of the read/write kit starts from (RFC 0003 section
// 12.1): the service its method runs in, found through the call's `ctx`
// (`kitRuntimeOf`), and the service's model on the dispatcher's tracked
// database client. The kit reads and writes through that client, as a
// hand-written handler does, so every write is tracked and its frames are
// sent by the flush; the kit never sends one itself.

import { QuickdrawError } from "../../../protocol/errors";
import { kitRuntimeOf, type KitRuntime } from "../../context";
import type { Projection } from "../../emit/projection";
import { modelKey } from "../../storage";
import type { Principal } from "../../types";
import { inKitTransaction } from "../transactions";

/** A row as the database client returns it. */
export type Row = Readonly<Record<string, unknown>>;

/** The model methods the kit calls: a Prisma model delegate, structurally. */
export interface ModelDelegate {
  findUnique(args: object): Promise<Row | null>;
  findFirst(args: object): Promise<Row | null>;
  findMany(args: object): Promise<Row[]>;
  count(args: object): Promise<number>;
  create(args: object): Promise<Row>;
  update(args: object): Promise<Row>;
  delete(args: object): Promise<Row>;
  updateMany(args: object): Promise<{ readonly count: number }>;
  deleteMany(args: object): Promise<{ readonly count: number }>;
  aggregate(args: object): Promise<Row>;
}

/** What a kit handler is called with, whatever the app's own types. */
export interface KitHandlerArgs {
  readonly input: unknown;
  /** The call's `ctx`; a dispatcher's always carries its `signal`. */
  readonly ctx: { readonly principal: Principal | null; readonly signal?: AbortSignal };
  readonly db: unknown;
}

/**
 * A handler of a kit method. Typed to return `never` so it fits the method
 * of any app's service: what it returns is the row (or rows, or page) its
 * method's output names, which the framework projects as for any handler.
 */
export type KitHandler = (args: KitHandlerArgs) => Promise<never>;

/** One call of a kit method: the service it runs in, its model's delegate, and the caller. */
export interface CrudCall {
  readonly runtime: KitRuntime;
  /** The model, named as the database client names it: `"task"`. */
  readonly model: string;
  readonly table: ModelDelegate;
  readonly principal: Principal | null;
}

/** The delegate of `model` on a database client (or a transaction's client). */
export function delegateOf(db: unknown, model: string): ModelDelegate {
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
      `The read/write kit reads and writes through db.${name}, which the dispatcher's database client does not have`,
    );
  }
  return delegate as ModelDelegate;
}

/** The kit call `ctx` belongs to: its service and model, and the caller. */
export function crudCall(ctx: KitHandlerArgs["ctx"], db: unknown): CrudCall {
  const runtime = kitRuntimeOf(ctx);
  const model = runtime?.service.model;
  if (runtime === undefined || model === undefined) {
    throw new QuickdrawError(
      "INTERNAL",
      "The read/write kit's handlers run through a dispatcher, in a service with a model",
    );
  }
  return {
    runtime,
    model: modelKey(model),
    table: delegateOf(db, model),
    principal: ctx.principal,
  };
}

/**
 * Runs `fn` in an interactive transaction of the database client: its writes
 * join the call's unit of work when it commits, and are dropped when it
 * rolls back. Reads the framework makes inside it (access policies) go
 * through the transaction too.
 */
export async function inTransaction<T>(db: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> {
  return await inKitTransaction(db, fn, { owner: "The read/write kit's bulk methods" });
}

/** A projection of the call's service, by name. */
export function projectionOf(call: CrudCall, name: string): Projection {
  const projection = call.runtime.service.projections.get(name);
  if (projection === undefined) {
    throw new QuickdrawError(
      "INTERNAL",
      `The read/write kit asked ${call.runtime.service.name} for projection "${name}", which it does not have`,
    );
  }
  return projection;
}

/** The ids in `ids`, each once, in order. */
export function uniqueIds(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}
