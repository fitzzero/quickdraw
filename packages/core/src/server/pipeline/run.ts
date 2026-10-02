// One handler run (RFC 0003 section 9, step 7): the handler inside its unit
// of work, with an abort signal and a time limit. Callers join a run; a
// shared query run has several. The run settles every caller exactly once:
// with the handler's outcome, with `TIMEOUT` when the time limit passes
// first, or with `CANCELLED` for a caller whose own signal aborts first.
// The handler's signal aborts on the time limit, or when every caller of a
// query has cancelled. A result that arrives after that is dropped.

import type { QuickdrawError } from "../../protocol/errors";
import type { UnitOfWork } from "../uow/types";
import { cancelledError, timeoutError, toQuickdrawError } from "./errors";

/** How a run, or one caller's share of it, ended. */
export type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: QuickdrawError };

/** Options of {@link startRun}. */
export interface RunOptions {
  readonly timeoutMs: number;
  readonly unit: UnitOfWork;
  /** Calls the handler with the run's signal. */
  readonly invoke: (signal: AbortSignal) => unknown;
  /** Turns the handler's value into the run's outcome: output validation, freezing. */
  readonly accept: (value: unknown) => Promise<Outcome>;
}

/** A handler run in progress, or finished. */
export interface Run {
  /** The run's own outcome. It never rejects. */
  readonly outcome: Promise<Outcome>;
  /** The run's outcome once it has one, read synchronously. */
  readonly settled: Outcome | undefined;
  readonly unit: UnitOfWork;
  /** Resolves once the handler itself has settled, which may be after the run timed out. Never rejects. */
  readonly handlerDone: Promise<void>;
  /** True once the handler itself has settled. */
  readonly handlerSettled: boolean;
  /**
   * Adds a caller. Resolves with the run's outcome, or with `CANCELLED` when
   * `signal` aborts first. A caller without a signal (a mutation, which is
   * never cancelled) waits for the outcome.
   */
  join(signal: AbortSignal | undefined): Promise<Outcome>;
}

function cancelled(): Outcome {
  return { ok: false, error: cancelledError() };
}

/** The mutable state of one run, shared by its helpers. */
interface RunState {
  final: Outcome | undefined;
  handlerSettled: boolean;
  participants: number;
  readonly outcome: Promise<Outcome>;
  /** Settles the run unless it already settled; aborts the handler for an error that ends it early. */
  readonly end: (result: Outcome, abort: boolean) => void;
  /** Stops the time limit: the handler has settled, and only its result is still being checked. */
  readonly stopTimer: () => void;
}

function createState(options: RunOptions, controller: AbortController): RunState {
  let resolveOutcome: (outcome: Outcome) => void = () => undefined;
  const outcome = new Promise<Outcome>((resolve) => {
    resolveOutcome = resolve;
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const state: RunState = {
    final: undefined,
    handlerSettled: false,
    participants: 0,
    outcome,
    end(result, abort) {
      if (state.final !== undefined) {
        return;
      }
      state.final = result;
      clearTimeout(timer);
      resolveOutcome(result);
      if (abort && !result.ok) {
        controller.abort(result.error);
      }
    },
    stopTimer: () => clearTimeout(timer),
  };
  timer = setTimeout(
    () => state.end({ ok: false, error: timeoutError(options.timeoutMs) }, true),
    options.timeoutMs,
  );
  return state;
}

function runHandler(options: RunOptions, state: RunState, signal: AbortSignal): Promise<void> {
  let started: Promise<unknown>;
  try {
    started = options.unit.run(() => options.invoke(signal));
  } catch (error) {
    started = Promise.reject(error);
  }
  return started.then(
    async (value) => {
      state.handlerSettled = true;
      state.stopTimer();
      if (state.final !== undefined) {
        return;
      }
      try {
        state.end(await options.accept(value), false);
      } catch (error) {
        state.end({ ok: false, error: toQuickdrawError(error) }, false);
      }
    },
    (error: unknown) => {
      state.handlerSettled = true;
      state.end({ ok: false, error: toQuickdrawError(error) }, false);
    },
  );
}

function joinRun(state: RunState, signal: AbortSignal | undefined): Promise<Outcome> {
  if (signal?.aborted === true) {
    return Promise.resolve(cancelled());
  }
  state.participants += 1;
  if (signal === undefined) {
    return state.outcome;
  }
  return new Promise<Outcome>((resolve) => {
    const onAbort = (): void => {
      state.participants -= 1;
      resolve(cancelled());
      if (state.participants === 0) {
        state.end(cancelled(), true);
      }
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void state.outcome.then((result) => {
      signal.removeEventListener("abort", onAbort);
      resolve(result);
    });
  });
}

/** Starts the handler inside its unit of work, with a time limit. Add callers with `join`. */
export function startRun(options: RunOptions): Run {
  const controller = new AbortController();
  const state = createState(options, controller);
  const handlerDone = runHandler(options, state, controller.signal);
  return {
    outcome: state.outcome,
    get settled() {
      return state.final;
    },
    unit: options.unit,
    handlerDone,
    get handlerSettled() {
      return state.handlerSettled;
    },
    join: (signal) => joinRun(state, signal),
  };
}
