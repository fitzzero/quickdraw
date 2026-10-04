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
//
// The last four are the write tracker's (`uow/unitOfWork.ts`), raised exactly
// where they were before; they gained the format and the call. Only an app's
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
import { consoleLogger, type Logger } from "../contract/logger";

/** What a development warning is about. */
export type DevWarningKind =
  | "n-plus-one"
  | "unbounded-read"
  | "oversized-response"
  | "nested-write"
  | "ambient-write"
  | "batch-read"
  | "batch-create-many";

/** One development warning. */
export interface DevWarning {
  readonly kind: DevWarningKind;
  /** The service whose method call raised it; absent outside a call (a job, a script). */
  readonly service?: string;
  readonly method?: string;
  /**
   * What the warning is about within its call, for the once-only rule: the
   * model of an ambient write, the model, field and operation of a nested
   * write. Empty for the kinds that are once per call site.
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
