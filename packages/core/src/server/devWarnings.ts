// Development warnings (RFC 0003 section 13): the slow or untracked patterns
// a lint rule cannot see, because they only show while the code runs,
// reported as they happen. Every warning has one format, names the call it
// happened in, and is logged once per kind, service, method and subject:
//
//   [quickdraw:n-plus-one] taskService.board: task.findUnique by id ran 10 times in one call...
//
// | Kind                 | Raised when                                                        | Subject                  |
// |----------------------|--------------------------------------------------------------------|--------------------------|
// | `n-plus-one`         | a call ran 10 statements of one shape (model, operation, `where`   | none                     |
// |                      | keys), outside an array-form `$transaction`                         |                          |
// | `unbounded-read`     | a call ran `findMany` with neither `take` nor ids to read (`id`,    | none                     |
// |                      | `{ in }`, `{ equals }`)                                            |                          |
// | `oversized-response` | a reply was larger than `maxResponseBytes`                         | none                     |
// | `nested-write`       | a write's `data` wrote a related row, which is not tracked         | model, field, operation  |
// | `ambient-write`      | a tracked write ran outside any unit of work                       | model                    |
// | `batch-read`         | a write in an array-form `$transaction` read its rows outside it   | model, operation         |
// | `batch-create-many`  | a `createMany` in an array-form `$transaction` could not be traced | model                    |
// | `repeated-call`      | one connection called a method with the same input more than 10    | connection               |
// |                      | times within a second, or was refused `RATE_LIMITED` more than 30  | (`refused <connection>`) |
// |                      | times within a minute: a client in a loop (`createLoopWatch`)      |                          |
// | `tiered-field-in-    | a method's own output schema declares a field the contract tiers,  | the field                |
// | output`              | at any depth, which such an output never strips                    |                          |
// |                      | (`emit/tieredOutputs.ts`); raised when a dispatcher is made, so a  |                          |
// |                      | strict test app fails to start; for an output without JSON Schema, |                          |
// |                      | raised by the first reply that carries the field                    |                          |
// | `resolver-without-   | a service with a model has a `resolver` policy (alone or in        | none (once per service)  |
// | reads`               | `anyOf`) that declares no `reads`, so no tracked write re-checks   |                          |
// |                      | it (`access/resolverReads.ts`); raised when a dispatcher is made,  |                          |
// |                      | so a strict test app fails to start                                 |                          |
//
// `nested-write`, `ambient-write`, `batch-read` and `batch-create-many` are
// the write tracker's (`uow/unitOfWork.ts`), raised exactly where they were
// before; they gained the format and the call. Only an app's
// own statements are checked for the first two: the framework's reads through
// the storage adapter, the tracker's own reads and the kits' handlers run
// `quietly`, while the app's callbacks a kit calls (`prepare`, `onChange`,
// `resolveUser`, a search strategy) run `checked`. A query by an `id` list
// (`{ id: { in: ids } }`) is one query per list, not per row, so it never
// counts toward an N+1. Warnings are off when NODE_ENV is "production". In a test app
// made with `strictWarnings` (under vitest or jest) every warning raised in
// one of its method calls throws a `DevWarningError` where it is raised
// instead, so the test fails; warnings outside its calls (an ambient write
// while seeding, say) are logged as usual.

import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { consoleLogger, type Logger } from "../contract/logger";
import type { CallOutcome } from "./pipeline/metrics";

/** What a development warning is about. */
export type DevWarningKind =
  | "n-plus-one"
  | "unbounded-read"
  | "oversized-response"
  | "nested-write"
  | "ambient-write"
  | "batch-read"
  | "batch-create-many"
  | "repeated-call"
  | "tiered-field-in-output"
  | "resolver-without-reads";

/** One development warning. */
export interface DevWarning {
  readonly kind: DevWarningKind;
  /** The service whose method call raised it; absent outside a call (a job, a script). */
  readonly service?: string;
  readonly method?: string;
  /**
   * What the warning is about within its call, for the once-only rule: the
   * model of an ambient write, the model, field and operation of a nested
   * write, the connection of a repeated call. Empty for the kinds that are
   * once per call site.
   */
  readonly subject?: string;
  /** What happened and what to do instead. */
  readonly message: string;
  /** Logged with the warning. */
  readonly meta?: Readonly<Record<string, unknown>>;
}

/** The statements of one shape a call may run before it is an N+1. */
export const N_PLUS_ONE_STATEMENTS = 10;

/** The text a warning is logged and thrown with: `[quickdraw:<kind>] <service>.<method>: <message>`. */
export function formatDevWarning(warning: DevWarning): string {
  const where =
    warning.service === undefined || warning.method === undefined
      ? ""
      : ` ${warning.service}.${warning.method}:`;
  return `[quickdraw:${warning.kind}]${where} ${warning.message}`;
}

/** A development warning, thrown instead of logged by a test app made with `strictWarnings`. */
export class DevWarningError extends Error {
  override readonly name = "DevWarningError";
  readonly warning: DevWarning;

  constructor(warning: DevWarning) {
    super(formatDevWarning(warning));
    this.warning = warning;
  }
}

/**
 * Where development warnings go: one per dispatcher, which the write tracker
 * reports a call's warnings to as well.
 */
export interface DevWarnings {
  /** False when warnings are off: NODE_ENV is "production" and nothing made them strict. */
  readonly enabled: boolean;
  /** True when every warning throws: a strict test app's dispatcher. */
  readonly strict: boolean;
  /** Logs `warning` the first time its kind, service, method and subject come up; strict, throws it every time. */
  warn(warning: DevWarning): void;
}

/** Options of {@link createDevWarnings}. */
export interface DevWarningsOptions {
  readonly logger?: Logger;
  /** Default: on unless NODE_ENV is "production". */
  readonly development?: boolean;
  /** Throw every warning as a `DevWarningError` instead of logging it. */
  readonly strict?: boolean;
}

function onceKey(warning: DevWarning): string {
  return [warning.kind, warning.service ?? "", warning.method ?? "", warning.subject ?? ""].join(
    "\u0000",
  );
}

/** Creates the development warnings of one dispatcher (or of a write tracker before one attaches). */
export function createDevWarnings(options: DevWarningsOptions = {}): DevWarnings {
  const logger = options.logger ?? consoleLogger;
  const strict = options.strict === true;
  const enabled = strict || (options.development ?? process.env.NODE_ENV !== "production");
  const warned = new Set<string>();
  return Object.freeze({
    enabled,
    strict,
    warn(warning: DevWarning): void {
      if (strict) {
        throw new DevWarningError(warning);
      }
      const key = onceKey(warning);
      if (!enabled || warned.has(key)) {
        return;
      }
      warned.add(key);
      logger.warn(formatDevWarning(warning), {
        category: "quickdraw.dev",
        warning: warning.kind,
        ...(warning.service === undefined ? {} : { service: warning.service }),
        ...(warning.method === undefined ? {} : { method: warning.method }),
        ...warning.meta,
      });
    },
  });
}

/**
 * The option `createTestApp({ strictWarnings })` sets on the server options
 * it passes on, so the dispatcher makes its warnings strict. A symbol, so it
 * survives the options being copied and is no option of the public types.
 */
export const STRICT_WARNINGS: unique symbol = Symbol("quickdraw.strictWarnings");

/** Whether `options` carry {@link STRICT_WARNINGS}. */
export function strictWarningsOf(options: object): boolean {
  return Reflect.get(options, STRICT_WARNINGS) === true;
}

const QUIET = new AsyncLocalStorage<boolean>();

/**
 * Runs `fn` with the development checks of statements off, awaiting its
 * result inside (a Prisma promise runs where it is awaited): the framework's
 * own reads and the kits' handlers, which an app cannot change.
 */
export async function quietly<T>(fn: () => T | PromiseLike<T>): Promise<T> {
  return await QUIET.run(true, async () => await fn());
}

/**
 * Runs `fn` with the development checks of statements on again, inside a
 * kit's quiet handler: the app's own callbacks a kit calls (`prepare`,
 * `onChange`, `resolveUser`, a search strategy) are the app's code, checked
 * like a handler's.
 */
export async function checked<T>(fn: () => T | PromiseLike<T>): Promise<T> {
  return await QUIET.run(false, async () => await fn());
}

/** True inside {@link quietly}, and not inside a {@link checked} within it. */
export function isQuiet(): boolean {
  return QUIET.getStore() === true;
}

// Loop warnings (`repeated-call`). Without them, a client re-issuing one
// call (a mutation fired from an effect that its own result re-runs, a
// refetch that triggers itself) is seen only as `RATE_LIMITED` once the
// socket's 600-per-minute limiter trips, which says nothing about why. The
// dispatcher's loop watch says it instead:
//
// - one connection (a socket, an MCP session) calls the same method with an
//   identical input more than 10 times within a second: once per
//   connection, service and method;
// - one connection is refused `RATE_LIMITED` more than 30 times within a
//   minute, by the socket rate limiter or by a full query queue: once per
//   connection, at warn where a refusal on its own logs at debug.
//
// A test app made with `strictWarnings` throws them from the call that
// crossed the line, once its reply was sent; a refusal outside any call is
// logged even there. Calls without a connection (in-process, HTTP) are not
// counted. Memory is bounded: the 10,000 most recently seen keys are kept.

/** Identical calls one connection may make within {@link REPEATED_CALL_WINDOW_MS}. */
export const REPEATED_CALL_LIMIT = 10;
export const REPEATED_CALL_WINDOW_MS = 1_000;

/** `RATE_LIMITED` refusals one connection may get within {@link REFUSAL_WINDOW_MS}. */
export const REFUSAL_LIMIT = 30;
export const REFUSAL_WINDOW_MS = 60_000;

const MAX_KEYS = 10_000;

/** Inputs longer than this are keyed by their hash. */
const MAX_INPUT_KEY = 256;

/** What a finished call is counted by. */
export interface CountedCall {
  readonly service: string;
  readonly method: string;
  readonly input: unknown;
  readonly connectionId?: string;
}

/** Counts each connection's calls and refusals, and warns when they look like a loop. */
export interface LoopWatch {
  /**
   * Counts one finished call and how it ended. Throws the warning in a test
   * app made with `strictWarnings`; call it once the reply was sent.
   */
  call(call: CountedCall, outcome: CallOutcome): void;
  /** Counts an event the socket rate limiter refused; never throws. */
  refused(connectionId: string, event: string): void;
}

/**
 * Counts events per key: returns how many fell within `windowMs` up to now,
 * once that is more than `limit`, else `undefined`. Keeps at most `limit + 1`
 * times per key and drops the least recently seen key past `MAX_KEYS`.
 */
function createCounter(
  limit: number,
  windowMs: number,
  now: () => number,
): (key: string) => number | undefined {
  const times = new Map<string, number[]>();
  return (key) => {
    const at = now();
    const recent = (times.get(key) ?? []).filter((time) => at - time < windowMs);
    recent.push(at);
    if (recent.length > limit + 1) {
      recent.shift();
    }
    times.delete(key);
    times.set(key, recent);
    if (times.size > MAX_KEYS) {
      const [oldest] = times.keys();
      times.delete(oldest ?? key);
    }
    return recent.length > limit ? recent.length : undefined;
  };
}

/** The input as a key: its JSON, hashed when long; `undefined` for an input JSON cannot write. */
function inputKey(input: unknown): string | undefined {
  let text: string | undefined;
  try {
    text = JSON.stringify(input) ?? "undefined";
  } catch {
    return undefined;
  }
  return text.length <= MAX_INPUT_KEY ? text : createHash("sha1").update(text).digest("base64url");
}

const OFF: LoopWatch = Object.freeze({
  call: () => undefined,
  refused: () => undefined,
});

/**
 * The loop watch of one dispatcher: it raises its `repeated-call` warnings
 * through `warnings`, and through a lenient copy logging to `logger` for
 * refusals outside any call.
 */
export function createLoopWatch(
  warnings: DevWarnings,
  logger: Logger,
  now: () => number = Date.now,
): LoopWatch {
  if (!warnings.enabled) {
    return OFF;
  }
  const repeats = createCounter(REPEATED_CALL_LIMIT, REPEATED_CALL_WINDOW_MS, now);
  const refusals = createCounter(REFUSAL_LIMIT, REFUSAL_WINDOW_MS, now);
  const outside = warnings.strict ? createDevWarnings({ logger, development: true }) : warnings;
  const refusal = (sink: DevWarnings, connectionId: string, what: string): void => {
    const count = refusals(connectionId);
    if (count !== undefined) {
      sink.warn({
        kind: "repeated-call",
        subject: `refused ${connectionId}`,
        message:
          `connection ${connectionId} was refused RATE_LIMITED ${String(count)} times within a minute (the last: ${what}): ` +
          "its client keeps calling while it is rate limited, as a loop does. The quickdraw client backs off on RATE_LIMITED; " +
          "find the call that repeats (a repeated-call warning names it) and stop the loop",
        meta: { connectionId, refusals: count, windowMs: REFUSAL_WINDOW_MS },
      });
    }
  };
  return Object.freeze({
    call(call: CountedCall, outcome: CallOutcome): void {
      const { connectionId } = call;
      if (connectionId === undefined) {
        return;
      }
      if (outcome === "RATE_LIMITED") {
        refusal(warnings, connectionId, `${call.service}.${call.method}`);
      }
      const key = inputKey(call.input);
      const count =
        key === undefined
          ? undefined
          : repeats([connectionId, call.service, call.method, key].join("\u0000"));
      if (count === undefined) {
        return;
      }
      warnings.warn({
        kind: "repeated-call",
        service: call.service,
        method: call.method,
        subject: connectionId,
        message:
          `called ${String(count)} times within a second with the same input, on one connection (${connectionId}): ` +
          "the client calls it in a loop, as a mutation fired from an effect or from render does, or a refetch that triggers itself. " +
          "Call it from an event handler, or guard the effect so it runs once per change",
        meta: { connectionId, calls: count, windowMs: REPEATED_CALL_WINDOW_MS },
      });
    },
    refused(connectionId: string, event: string): void {
      refusal(outside, connectionId, event);
    },
  });
}
