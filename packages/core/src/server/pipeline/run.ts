// One handler run (RFC 0003 section 9, step 7): the handler inside its unit
// of work, with an abort signal and a time limit. Callers join a run; a
// shared query run has several. The run settles every caller exactly once:
// with the handler's outcome, with `TIMEOUT` when the time limit of the call
// that started the run passes first, or with `CANCELLED` (or `TIMEOUT`) for a
// caller whose own signal aborts first. The time limit covers the output
// check too, not the handler alone. The handler's signal aborts on the time
// limit, or when every caller has left. A result that arrives after that is
// dropped.

import type { QuickdrawError } from "../../protocol/errors";
import type { UnitOfWork } from "../uow/types";
import { abortError, toQuickdrawError } from "./errors";

/** How a run, or one caller's share of it, ended. */
export type Outcome =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: QuickdrawError };

/** Options of {@link startRun}. */
export interface RunOptions {
  /**
   * The time limit of the call that starts the run: it aborts, with the
   * `TIMEOUT` error as its reason, once the limit passes, and the run then
   * settles every caller with that error and aborts the handler.
   */
  readonly timeLimit: AbortSignal;
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
   * Adds a caller. Resolves with the run's outcome, or, when `signal` aborts
   * first, with `TIMEOUT` if the caller's time limit aborted it and
   * `CANCELLED` otherwise. A caller without a signal waits for the outcome.
   */
  join(signal: AbortSignal | undefined): Promise<Outcome>;
}

/** How a caller whose signal aborted leaves the run. */
function stopped(signal: AbortSignal): Outcome {
  return { ok: false, error: abortError(signal) };
}

/** The mutable state of one run, shared by its helpers. */
interface RunState {
  final: Outcome | undefined;
  handlerSettled: boolean;
  participants: number;
  readonly outcome: Promise<Outcome>;
  /** Settles the run unless it already settled; aborts the handler for an error that ends it early. */
  readonly end: (result: Outcome, abort: boolean) => void;
}

function createState(options: RunOptions, controller: AbortController): RunState {
  let resolveOutcome: (outcome: Outcome) => void = () => undefined;
  const outcome = new Promise<Outcome>((resolve) => {
    resolveOutcome = resolve;
  });
  const { timeLimit } = options;
  const onTimeLimit = (): void => state.end(stopped(timeLimit), true);
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
      timeLimit.removeEventListener("abort", onTimeLimit);
      resolveOutcome(result);
      if (abort && !result.ok) {
        controller.abort(result.error);
      }
    },
  };
  if (timeLimit.aborted) {
    onTimeLimit();
  } else {
    timeLimit.addEventListener("abort", onTimeLimit, { once: true });
  }
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
    return Promise.resolve(stopped(signal));
  }
  state.participants += 1;
  if (signal === undefined) {
    return state.outcome;
  }
  return new Promise<Outcome>((resolve) => {
    const onAbort = (): void => {
      state.participants -= 1;
      const left = stopped(signal);
      resolve(left);
      // The last caller to leave ends the run with its reason, and aborts the handler.
      if (state.participants === 0) {
        state.end(left, true);
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
