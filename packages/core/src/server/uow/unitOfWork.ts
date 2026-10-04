// The tracked unit of work (RFC 0003 section 5.1). A write tracker holds the
// writes of every unit of work in `AsyncLocalStorage` frames: a database
// adapter (`trackPrisma` on `./prisma`) records each write into the frame
// that is active where the write runs, and the dispatcher opens a unit per
// handler run and flushes it after the response.
//
// Frames nest:
//
// - a unit's frame buffers the unit's writes until it flushes;
// - a transaction's frame buffers its writes separately, and they join the
//   enclosing buffer only when the transaction commits; a rollback discards
//   them; an interactive transaction's frame also holds its transaction
//   client, so the adapter's own reads see the transaction's writes;
// - a unit begun inside another open frame (an in-process call made from a
//   handler, `qd.run` inside a transaction) joins it: its writes go where
//   the enclosing frame's go, and its own flush does nothing; a detached
//   unit (`qd.run(fn, { detached: true })`, a handler's background work)
//   never joins: it starts a stack of its own and flushes on its own;
// - `countStatements` frames only count.
//
// A write with no open buffer above it (a job that did not use `qd.run`, or
// a handler's background work that outlived its unit's flush) is ambient: it
// flushes on its own on the next tick, with a development warning.
//
// In development a method call's unit also checks the statements run in it
// for N+1 shapes and unbounded reads (`statementChecks.ts`), and every
// warning goes out in the shared format of `../devWarnings.ts`, naming the
// call it happened in. A warning raised inside a method call goes to the
// warnings of the dispatcher that runs the call (a strict test app's throw);
// one raised elsewhere goes to the attached dispatcher's, never strictly.
//
// Dispatchers attach to the tracker as a stack: the last one attached
// receives ambient writes and the warnings outside calls, and detaching it
// (a server's `close()`) restores the one attached before.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { consoleLogger, type Logger } from "../../contract/logger";
import type { TouchOptions } from "../context";
import { createDevWarnings, isQuiet, type DevWarning, type DevWarnings } from "../devWarnings";
import { flushWrites } from "./flush";
import { noFlushSink, type FlushSink } from "./flushSink";
import {
  createStatementChecks,
  type CallSite,
  type Statement,
  type StatementCheck,
  type StatementPlace,
} from "./statementChecks";
import {
  ANY_FIELD,
  type UnitOfWork,
  type UnitOfWorkFactory,
  type UnitOfWorkScope,
  type WriteRecord,
} from "./types";

/** One level of the frame stack. Mutable flags close it once its unit flushed or its transaction settled. */
interface Frame {
  readonly parent: Frame | undefined;
  /** Where writes made here go; a frame without a buffer passes them up. */
  readonly buffer: WriteRecord[] | undefined;
  /** Writes in a unit's buffer are durable; a transaction's wait for its commit. */
  readonly durable: boolean;
  /** An interactive transaction's client, for the adapter's own reads. */
  tx: unknown;
  /** An array-form transaction: no client, and its operations cannot be rewritten. */
  readonly batch: boolean;
  /** Counts the statements issued in this frame and every frame inside it. */
  readonly count: ((statements: number) => void) | undefined;
  /** A method call's unit: the call warnings made inside it are about. */
  readonly call: CallSite | undefined;
  /** A method call's unit: its dispatcher's warnings, which those warnings go to. */
  readonly warnings: DevWarnings | undefined;
  /** A method call's unit in development: checks the statements run inside it. */
  readonly check: StatementCheck | undefined;
  open: boolean;
}

/** A warning the tracker raises; it adds the call it was raised in. */
export type TrackerWarning = Omit<DevWarning, "service" | "method">;

/** An open transaction, from {@link WriteTracker.openTransaction}. */
export interface TrackedTransaction {
  /** Sets the interactive transaction's client, once the database has opened it. */
  setClient(tx: unknown): void;
  /** Runs `fn` inside the transaction's frame, awaiting its result there. */
  run<T>(fn: () => T | PromiseLike<T>): Promise<T>;
  /** The transaction committed: its writes join the enclosing buffer. */
  commit(): void;
  /** The transaction rolled back: its writes are dropped. */
  rollback(): void;
}

/** A statement count, from {@link WriteTracker.countStatements}. */
export interface StatementCount<T> {
  readonly value: T;
  readonly statements: number;
}

/** Options of {@link createWriteTracker}. */
export interface WriteTrackerOptions {
  /** Receives warnings until a dispatcher attaches its logger. Default: the console logger. */
  readonly logger?: Logger;
  /**
   * Raise development warnings: ambient, nested and batched writes, and the
   * checks of each method call's statements. Default: on unless `NODE_ENV`
   * is `"production"`.
   */
  readonly development?: boolean;
}

/**
 * Where a database adapter records writes, and the unit of work factory the
 * dispatcher opens units with. One tracker belongs to one tracked client.
 */
export interface WriteTracker {
  /** The units of work of handler runs and `qd.run` blocks: give it to the dispatcher. */
  readonly unitOfWork: UnitOfWorkFactory;
  /** Records writes where they ran: an open transaction, a unit of work, or the next tick's ambient flush. */
  record(writes: readonly WriteRecord[]): void;
  /** Records `ids` of `model` as changed, or as deleted with `removed`: `ctx.touch`. */
  touch(model: string, ids: readonly string[], options?: TouchOptions): void;
  /** Counts one statement in every open frame where it runs. */
  countStatement(): void;
  /** Opens a transaction frame inside the active one. */
  openTransaction(kind: "interactive" | "batch"): TrackedTransaction;
  /** The client of the open interactive transaction where this runs, or `undefined`. */
  transactionClient(): unknown;
  /** True inside an array-form transaction. */
  inBatch(): boolean;
  /** Runs `fn` and counts the statements it issued. */
  countStatements<T>(fn: () => T | PromiseLike<T>): Promise<StatementCount<T>>;
  /** Calls `listener` with each write once it is durable: in a unit of work, or flushing on its own. */
  onWrite(listener: (write: WriteRecord) => void): () => void;
  /**
   * Raises a development warning about the method call this runs in (none
   * outside a call): logged once, in the shared format, by the attached
   * dispatcher's warnings. Nothing outside development.
   */
  warn(warning: TrackerWarning): void;
  /**
   * Hands a statement the database client is about to run to the checks of
   * the method call it runs in (development only; nothing outside a call,
   * nor inside `quietly`).
   */
  observe(statement: Statement): void;
  /** The logger warnings go to: the attached dispatcher's, or the one given at creation. */
  readonly logger: Logger;
}

/** Where ambient writes flush and warnings outside a call go: the attached dispatcher's. */
interface Attachment {
  readonly sink: FlushSink;
  readonly logger: Logger;
  /** Never strict: warnings outside a method call only log. */
  readonly warnings: DevWarnings;
}

interface TrackerState {
  readonly als: AsyncLocalStorage<Frame>;
  readonly listeners: Set<(write: WriteRecord) => void>;
  readonly development: boolean;
  /** Before any dispatcher attaches, and once every one detached. */
  readonly base: Attachment;
  /** The dispatchers attached, the current one last. */
  readonly attached: Attachment[];
  logger: Logger;
  warnings: DevWarnings;
  sink: FlushSink;
  ambient: WriteRecord[];
  /** Every statement counted since the tracker was created, wherever it ran. */
  issued: number;
}

const ISSUED = new WeakMap<object, () => number>();

/**
 * How many statements the tracked client of `unitOfWork` (a tracker's
 * `unitOfWork`, as `storage.unitOfWork` carries it) has counted since it was
 * created, in every async context: what `expectBudget` measures a test step
 * with. `undefined` for units of work no tracker made.
 */
export function statementsIssued(unitOfWork: object): number | undefined {
  return ISSUED.get(unitOfWork)?.();
}

function frameWhere(state: TrackerState, test: (frame: Frame) => boolean): Frame | undefined {
  for (let frame = state.als.getStore(); frame !== undefined; frame = frame.parent) {
    if (frame.open && test(frame)) {
      return frame;
    }
  }
  return undefined;
}

function warn(state: TrackerState, warning: TrackerWarning): void {
  if (!state.development) {
    return;
  }
  const frame = frameWhere(state, (candidate) => candidate.call !== undefined);
  if (frame?.call === undefined) {
    state.warnings.warn(warning);
    return;
  }
  (frame.warnings ?? state.warnings).warn({ ...warning, ...frame.call });
}

/** Where a statement runs: the innermost open buffer is a unit's, a batch's or an interactive transaction's. */
function placeOf(state: TrackerState): StatementPlace {
  const open = frameWhere(state, (candidate) => candidate.buffer !== undefined);
  if (open?.batch === true) {
    return "batch";
  }
  return open?.tx === undefined ? "unit" : "interactive";
}

function observe(state: TrackerState, statement: Statement): void {
  if (!state.development || isQuiet()) {
    return;
  }
  const frame = frameWhere(state, (candidate) => candidate.check !== undefined);
  frame?.check?.(statement, placeOf(state));
}

function notify(state: TrackerState, writes: readonly WriteRecord[]): void {
  for (const listener of state.listeners) {
    for (const write of writes) {
      try {
        listener(write);
      } catch (error) {
        state.logger.error("An onWrite listener threw", {
          category: "quickdraw.writes",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

function flushAmbient(state: TrackerState): void {
  const writes = state.ambient;
  state.ambient = [];
  const scope: UnitOfWorkScope = {
    requestId: randomUUID(),
    transport: "internal",
    sink: state.sink,
  };
  void flushWrites(writes, scope, state.logger);
}

function recordAmbient(state: TrackerState, writes: readonly WriteRecord[]): void {
  for (const model of new Set(writes.map((write) => write.model))) {
    warn(state, {
      kind: "ambient-write",
      subject: model,
      message: `A tracked write to ${model} ran outside any unit of work, so it flushes on its own; run jobs and scripts inside qd.run(...)`,
      meta: { model },
    });
  }
  if (state.ambient.length === 0) {
    setImmediate(() => flushAmbient(state));
  }
  state.ambient.push(...writes);
  notify(state, writes);
}

/** Puts `writes` in the first open buffer at or above `from`, or flushes them on their own. */
function deliver(
  state: TrackerState,
  writes: readonly WriteRecord[],
  from: Frame | undefined,
): void {
  if (writes.length === 0) {
    return;
  }
  for (let frame = from; frame !== undefined; frame = frame.parent) {
    if (frame.open && frame.buffer !== undefined) {
      frame.buffer.push(...writes);
      if (frame.durable) {
        notify(state, writes);
      }
      return;
    }
  }
  recordAmbient(state, writes);
}

function openTransaction(state: TrackerState, kind: "interactive" | "batch"): TrackedTransaction {
  const parent = state.als.getStore();
  const frame: Frame = {
    parent,
    buffer: [],
    durable: false,
    tx: undefined,
    batch: kind === "batch",
    count: undefined,
    call: undefined,
    warnings: undefined,
    check: undefined,
    open: true,
  };
  return {
    setClient: (tx) => {
      frame.tx = tx;
    },
    run: (fn) => state.als.run(frame, async () => await fn()),
    commit: () => {
      frame.open = false;
      deliver(state, frame.buffer ?? [], parent);
    },
    rollback: () => {
      frame.open = false;
    },
  };
}

async function countStatements<T>(
  state: TrackerState,
  fn: () => T | PromiseLike<T>,
): Promise<StatementCount<T>> {
  let statements = 0;
  const frame: Frame = {
    parent: state.als.getStore(),
    buffer: undefined,
    durable: false,
    tx: undefined,
    batch: false,
    count: (n) => {
      statements += n;
    },
    call: undefined,
    warnings: undefined,
    check: undefined,
    open: true,
  };
  try {
    const value = await state.als.run(frame, async () => await fn());
    return { value, statements };
  } finally {
    frame.open = false;
  }
}

/**
 * The method call a unit's scope names, the warnings of the dispatcher that
 * runs it (the tracker's own when that dispatcher's are off, as for a
 * production dispatcher over a development tracker), and in development the
 * checks of its statements.
 */
function callOf(
  state: TrackerState,
  scope: UnitOfWorkScope,
): Pick<Frame, "call" | "warnings" | "check"> {
  if (scope.service === undefined || scope.method === undefined) {
    return { call: undefined, warnings: undefined, check: undefined };
  }
  const call: CallSite = { service: scope.service, method: scope.method };
  const warnings = scope.warnings?.enabled === true ? scope.warnings : state.warnings;
  if (!state.development) {
    return { call, warnings, check: undefined };
  }
  return {
    call,
    warnings,
    check: createStatementChecks((warning) => warnings.warn({ ...warning, ...call })),
  };
}

/** A unit of work over the tracker's frames. */
function createUnit(state: TrackerState, scope: UnitOfWorkScope): UnitOfWork {
  let statements = 0;
  let frame: Frame | undefined;
  let flushed = false;
  const writes: WriteRecord[] = [];
  return {
    get sqlStatements() {
      return statements;
    },
    run<T>(fn: () => T | PromiseLike<T>): Promise<T> {
      // Inside an open buffer (a transaction, another unit), this unit joins it, unless it is
      // detached: then it stands alone, outside every frame open where it was begun.
      const detached = scope.detached === true;
      const joins =
        !detached && frameWhere(state, (candidate) => candidate.buffer !== undefined) !== undefined;
      const own: Frame = {
        parent: detached ? undefined : state.als.getStore(),
        buffer: joins ? undefined : writes,
        durable: true,
        tx: undefined,
        batch: false,
        count: (n) => {
          statements += n;
        },
        ...callOf(state, scope),
        open: true,
      };
      frame = own;
      return state.als.run(own, async () => await fn());
    },
    async flush(): Promise<void> {
      if (flushed) {
        return;
      }
      flushed = true;
      if (frame !== undefined) {
        frame.open = false;
      }
      await flushWrites(writes.splice(0), scope, state.logger);
    },
  };
}

function touchWrites(
  model: string,
  ids: readonly string[],
  options: TouchOptions | undefined,
): WriteRecord[] {
  const removed = options?.removed === true;
  return [...new Set(ids)].map((id) => ({
    model,
    id,
    op: removed ? "delete" : "update",
    fields: removed ? [] : [ANY_FIELD],
  }));
}

/**
 * The warnings an attaching dispatcher's give the tracker for warnings
 * outside its calls: its own, unless they are off (a tracker made with
 * `development: true` keeps warning under a production dispatcher, as it
 * always did) or strict (only a strict dispatcher's calls throw).
 */
function outsideCalls(
  state: TrackerState,
  logger: Logger,
  warnings: DevWarnings | undefined,
): DevWarnings {
  return warnings?.enabled === true && !warnings.strict
    ? warnings
    : createDevWarnings({ logger, development: state.development });
}

/** Makes `attachment` the current one, until the returned function detaches it. */
function attach(state: TrackerState, attachment: Attachment): () => void {
  const follow = (): void => {
    const current = state.attached.at(-1) ?? state.base;
    state.sink = current.sink;
    state.logger = current.logger;
    state.warnings = current.warnings;
  };
  state.attached.push(attachment);
  follow();
  return () => {
    const index = state.attached.indexOf(attachment);
    if (index !== -1) {
      state.attached.splice(index, 1);
      follow();
    }
  };
}

/** Creates the write tracker of one tracked database client. */
export function createWriteTracker(options: WriteTrackerOptions = {}): WriteTracker {
  const development = options.development ?? process.env.NODE_ENV !== "production";
  const logger = options.logger ?? consoleLogger;
  const base: Attachment = {
    sink: noFlushSink,
    logger,
    warnings: createDevWarnings({ logger, development }),
  };
  const state: TrackerState = {
    als: new AsyncLocalStorage<Frame>(),
    listeners: new Set(),
    development,
    base,
    attached: [],
    ...base,
    ambient: [],
    issued: 0,
  };
  const touch = (model: string, ids: readonly string[], touchOptions?: TouchOptions): void =>
    deliver(state, touchWrites(model, ids, touchOptions), state.als.getStore());
  const unitOfWork: UnitOfWorkFactory = Object.freeze({
    begin: (scope: UnitOfWorkScope) => createUnit(state, scope),
    touch,
    attach: (sink: FlushSink, attached: Logger, warnings?: DevWarnings) =>
      attach(state, { sink, logger: attached, warnings: outsideCalls(state, attached, warnings) }),
  });
  ISSUED.set(unitOfWork, () => state.issued);
  return Object.freeze({
    unitOfWork,
    record: (writes: readonly WriteRecord[]) => deliver(state, writes, state.als.getStore()),
    touch,
    countStatement(): void {
      state.issued += 1;
      for (let frame = state.als.getStore(); frame !== undefined; frame = frame.parent) {
        if (frame.open) {
          frame.count?.(1);
        }
      }
    },
    openTransaction: (kind: "interactive" | "batch") => openTransaction(state, kind),
    transactionClient: () => frameWhere(state, (frame) => frame.tx !== undefined)?.tx,
    inBatch: () => frameWhere(state, (frame) => frame.buffer !== undefined)?.batch === true,
    countStatements: <T>(fn: () => T | PromiseLike<T>) => countStatements(state, fn),
    onWrite(listener: (write: WriteRecord) => void): () => void {
      state.listeners.add(listener);
      return () => {
        state.listeners.delete(listener);
      };
    },
    warn: (warning: TrackerWarning) => warn(state, warning),
    observe: (statement: Statement) => observe(state, statement),
    get logger() {
      return state.logger;
    },
  });
}
