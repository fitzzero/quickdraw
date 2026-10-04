// The unit of work seam (RFC 0003 section 5.1). Every method call runs its
// handler inside a unit of work, which the tracked database client records
// writes into. After the response is sent, the dispatcher flushes it, and
// the flush turns those writes into entity frames, collection deltas and
// change signals (section 5.3).
//
// The dispatcher's default (`untracked.ts`) awaits the handler inside its
// scope and records nothing. A tracked database client (`trackPrisma` on
// `./prisma`) brings the tracked implementation (`unitOfWork.ts`), which the
// dispatcher picks up from the client without touching the pipeline.

import type { Logger } from "../../contract/logger";
import type { MethodKind } from "../../contract/methods";
import type { TouchOptions } from "../context";
import type { DevWarnings } from "../devWarnings";
import type { Transport } from "../types";
import type { FlushSink } from "./flushSink";

/**
 * The `fields` of a write whose changed fields are unknown, such as a
 * `ctx.touch`: any field may have changed. No column can have this name.
 */
export const ANY_FIELD = "*";

/**
 * One write a unit of work recorded: `{ model, id, op, fields, before? }`
 * (RFC 0003 section 5.1), plus `after`. The values in `before` and `after`
 * are those of the model's interested columns: the scope, membership and
 * owner columns later cards register with `registerInterest`.
 */
export interface WriteRecord {
  /** The database model, named as the client names it: `"task"`, `"taskLabel"`. */
  readonly model: string;
  /** The written row's id. */
  readonly id: string;
  readonly op: "create" | "update" | "delete";
  /** The fields the write set; `[ANY_FIELD]` when they are unknown. */
  readonly fields: readonly string[];
  /**
   * The row before the unit of work wrote it, for its interested columns: an
   * update's old values of the interested columns it changed (read first,
   * narrowly), or a delete's values. A row the unit created has none.
   */
  readonly before?: Readonly<Record<string, unknown>>;
  /** The interested columns' values after the write, when the write returned them. */
  readonly after?: Readonly<Record<string, unknown>>;
  /**
   * Set on a `create` an `upsert` recorded without reading whether its row
   * existed (its `update` set no interested column): the row may have been
   * updated rather than created. Only merging reads it: a row created and
   * deleted in one unit is dropped from the flush only when its create is
   * certain.
   */
  readonly mayHaveExisted?: true;
}

/**
 * Where a unit of work's writes come from. A method call's unit names the
 * call's service, method and kind; a `qd.run` block's unit does not.
 */
export interface UnitOfWorkScope {
  readonly service?: string;
  readonly method?: string;
  readonly kind?: MethodKind;
  readonly requestId: string;
  readonly transport: Transport;
  /** Where the unit's writes go when it flushes. */
  readonly sink: FlushSink;
  /**
   * The development warnings of the dispatcher whose method call this unit
   * runs: a warning raised inside the call goes there, so only a strict
   * dispatcher's own calls throw. Without them, the attached dispatcher's.
   */
  readonly warnings?: DevWarnings;
  /**
   * A unit of its own even where another unit or a transaction is open (a
   * handler's background work, `qd.run(fn, { detached: true })`): its writes
   * flush when it does, never with the unit around it, and its statements
   * are not counted there. Default `false`: a unit begun inside an open
   * one joins it.
   */
  readonly detached?: boolean;
}

/**
 * The writes of one handler run. The dispatcher calls `run` once, with the
 * handler, and `flush` once, after the handler has settled and the response
 * has been sent, whether the handler succeeded or failed.
 */
export interface UnitOfWork {
  /**
   * Runs `fn` inside this unit's scope and awaits its result inside that
   * scope. Prisma promises are lazy: one returned without being awaited would
   * otherwise run outside the scope and escape tracking.
   */
  run<T>(fn: () => T | PromiseLike<T>): Promise<T>;
  /**
   * Hands the recorded writes to the scope's sink. A failure is logged by
   * the dispatcher and never fails the response, which was already sent.
   */
  flush(): Promise<void>;
  /** Database statements the run issued, for the completion record; `undefined` when not counted. */
  readonly sqlStatements: number | undefined;
}

/** Opens the unit of work of each handler run. A shared query run has one unit for all its callers. */
export interface UnitOfWorkFactory {
  begin(scope: UnitOfWorkScope): UnitOfWork;
  /**
   * Records writes the database client cannot see (`ctx.touch`) as if the
   * client had made them where `touch` is called: into the open transaction
   * or unit of work there, or, outside any, flushed on their own. A factory
   * that tracks nothing leaves it out, and `ctx.touch` then does nothing.
   */
  touch?(model: string, ids: readonly string[], options?: TouchOptions): void;
  /**
   * Called by each dispatcher created with this factory: writes made outside
   * any unit of work flush to `sink`, and development warnings raised
   * outside a method call go to the dispatcher's `warnings` (or, without
   * them, to `logger`), never strictly. The dispatcher attached last wins.
   * Returns the function that detaches it again (a server's `close()`
   * calls it), restoring the dispatcher attached before.
   */
  attach?(sink: FlushSink, logger: Logger, warnings?: DevWarnings): (() => void) | void;
}
