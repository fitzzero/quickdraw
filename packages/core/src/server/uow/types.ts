// The unit of work seam (RFC 0003 section 5.1). Every method call runs its
// handler inside a unit of work, which the tracked database client records
// writes into. After the response is sent, the dispatcher flushes it, and
// the flush turns those writes into entity frames, collection deltas and
// change signals (section 5.3).
//
// This card ships an untracked default (`untracked.ts`): it awaits the
// handler inside its scope and records nothing. The tracked-writes card
// replaces the factory without touching the pipeline.

import type { MethodKind } from "../../contract/methods";
import type { Transport } from "../types";
import type { FlushSink } from "./flushSink";

/** One write a unit of work recorded: `{ model, id, op, fields, before? }` (RFC 0003 section 5.1). */
export interface WriteRecord {
  /** The database model, for example `"task"`. */
  readonly model: string;
  /** The written row's id. */
  readonly id: string;
  readonly op: "create" | "update" | "delete";
  /** The fields the write changed. */
  readonly fields: readonly string[];
  /** Old values read before the write, when a scope or membership column changed. */
  readonly before?: Readonly<Record<string, unknown>>;
}

/** The call a unit of work belongs to. */
export interface UnitOfWorkScope {
  readonly service: string;
  readonly method: string;
  readonly kind: MethodKind;
  readonly requestId: string;
  readonly transport: Transport;
  /** Where the unit's writes go when it flushes. */
  readonly sink: FlushSink;
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
}
