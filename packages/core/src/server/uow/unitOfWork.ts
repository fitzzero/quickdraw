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
//   the enclosing frame's go, and its own flush does nothing;
// - `countStatements` frames only count.
//
// A write with no open buffer above it (a job that did not use `qd.run`, or
// a handler's background work that outlived its unit's flush) is ambient: it
// flushes on its own on the next tick, with a development warning.

import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { consoleLogger, type Logger } from "../../contract/logger";
import type { TouchOptions } from "../context";
import { flushWrites } from "./flush";
import { noFlushSink, type FlushSink } from "./flushSink";
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
  open: boolean;
}

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
  /** Log development warnings (ambient and nested writes). Default: on unless `NODE_ENV` is `"production"`. */
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
  /** Logs a development warning once per `key`. */
  warnOnce(key: string, message: string, meta?: Record<string, unknown>): void;
  /** The logger warnings go to: the attached dispatcher's, or the one given at creation. */
  readonly logger: Logger;
}

interface TrackerState {
  readonly als: AsyncLocalStorage<Frame>;
  readonly listeners: Set<(write: WriteRecord) => void>;
  readonly warned: Set<string>;
  readonly development: boolean;
  logger: Logger;
  sink: FlushSink;
  ambient: WriteRecord[];
}

function frameWhere(state: TrackerState, test: (frame: Frame) => boolean): Frame | undefined {
  for (let frame = state.als.getStore(); frame !== undefined; frame = frame.parent) {
    if (frame.open && test(frame)) {
      return frame;
    }
  }
  return undefined;
}

function warnOnce(
  state: TrackerState,
  key: string,
  message: string,
  meta: Record<string, unknown> = {},
): void {
  if (!state.development || state.warned.has(key)) {
    return;
  }
  state.warned.add(key);
  state.logger.warn(message, { category: "quickdraw.writes", ...meta });
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
    warnOnce(
      state,
      `ambient:${model}`,
      `A tracked write to ${model} ran outside any unit of work, so it flushes on its own; run jobs and scripts inside qd.run(...)`,
      { model },
    );
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
    open: true,
  };
  try {
    const value = await state.als.run(frame, async () => await fn());
    return { value, statements };
  } finally {
    frame.open = false;
  }
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
      // Inside an open buffer (a transaction, another unit), this unit joins it.
      const joins = frameWhere(state, (candidate) => candidate.buffer !== undefined) !== undefined;
      const own: Frame = {
        parent: state.als.getStore(),
        buffer: joins ? undefined : writes,
        durable: true,
        tx: undefined,
        batch: false,
        count: (n) => {
          statements += n;
        },
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

/** Creates the write tracker of one tracked database client. */
export function createWriteTracker(options: WriteTrackerOptions = {}): WriteTracker {
  const state: TrackerState = {
    als: new AsyncLocalStorage<Frame>(),
    listeners: new Set(),
    warned: new Set(),
    development: options.development ?? process.env.NODE_ENV !== "production",
    logger: options.logger ?? consoleLogger,
    sink: noFlushSink,
    ambient: [],
  };
  const touch = (model: string, ids: readonly string[], touchOptions?: TouchOptions): void =>
    deliver(state, touchWrites(model, ids, touchOptions), state.als.getStore());
  const unitOfWork: UnitOfWorkFactory = Object.freeze({
    begin: (scope: UnitOfWorkScope) => createUnit(state, scope),
    touch,
    attach(sink: FlushSink, logger: Logger): void {
      state.sink = sink;
      state.logger = logger;
    },
  });
  return Object.freeze({
    unitOfWork,
    record: (writes: readonly WriteRecord[]) => deliver(state, writes, state.als.getStore()),
    touch,
    countStatement(): void {
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
    warnOnce: (key: string, message: string, meta?: Record<string, unknown>) =>
      warnOnce(state, key, message, meta),
    get logger() {
      return state.logger;
    },
  });
}
