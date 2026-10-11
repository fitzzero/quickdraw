// The logger contract and its console default (4.1 `src/shared/types.ts:525-545`),
// and how an error is written into a log (the 5.1 audit's CLIENT-5). The
// default writes every level outside production, and from `info` up when
// `NODE_ENV` is "production" (a call's record logs at debug with its caller's
// user id); `createConsoleLogger({ level })` names the lowest level written
// instead. A Prisma client error's message renders the call it failed,
// values included, and its `meta` can hold the database's own text, which
// quotes the row, so a log gets its summary (`prismaSummary`, `errorText`),
// never its message or that text. Isomorphic: `process` may not exist, and NODE_ENV is
// read at each call.

/**
 * Logger interface compatible with Winston and other loggers
 */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  child(options: Record<string, unknown>): Logger;
}

/** A logger's levels, lowest first. */
export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVELS: readonly string[] = ["debug", "info", "warn", "error"];

/** Options of {@link createConsoleLogger}. */
export interface ConsoleLoggerOptions {
  /**
   * The lowest level written. Default `"info"` when `NODE_ENV` is
   * `"production"` (read at each call), else `"debug"`.
   */
  readonly level?: LogLevel;
}

/** True when `process.env.NODE_ENV` is "production", or cannot be read. */
function inProduction(): boolean {
  try {
    // Written out whole, so a bundler can inline it.
    return process.env.NODE_ENV === "production";
  } catch {
    // No `process` here (a bundler that provides none): treated as production.
    return true;
  }
}

/**
 * A logger that writes to the console from `level` up: by default every
 * level, but `debug` when `NODE_ENV` is "production". `child` returns the
 * same logger.
 */
export function createConsoleLogger(options: ConsoleLoggerOptions = {}): Logger {
  const { level } = options;
  if (level !== undefined && !LEVELS.includes(level)) {
    throw new TypeError(
      `createConsoleLogger: level must be "debug", "info", "warn" or "error", not ${JSON.stringify(level)}`,
    );
  }
  const writes = (at: LogLevel): boolean =>
    LEVELS.indexOf(at) >= LEVELS.indexOf(level ?? (inProduction() ? "info" : "debug"));
  const logger: Logger = {
    info: (message, meta) => {
      if (writes("info")) {
        console.log(`[INFO] ${message}`, meta ?? "");
      }
    },
    warn: (message, meta) => {
      if (writes("warn")) {
        console.warn(`[WARN] ${message}`, meta ?? "");
      }
    },
    error: (message, meta) => {
      if (writes("error")) {
        console.error(`[ERROR] ${message}`, meta ?? "");
      }
    },
    debug: (message, meta) => {
      if (writes("debug")) {
        console.debug(`[DEBUG] ${message}`, meta ?? "");
      }
    },
    child: () => logger,
  };
  return logger;
}

/** The default console logger: every level, but `debug` in production. */
export const consoleLogger: Logger = createConsoleLogger();

/** True for an error of the Prisma client, whose message renders the call it failed, values included. */
export function isPrismaError(error: Error): boolean {
  return /^PrismaClient\w*Error$/u.test(error.name);
}

/**
 * The keys of a Prisma error's `meta` a log keeps: each names the schema (a
 * model, field, constraint, relation or operation) or a code, never a value.
 * Every other key is dropped: `argument_value`, `field_value`, `details`,
 * `database_error` and `message` quote the row or the database's own text.
 */
const META_KEYS: ReadonlySet<string> = new Set([
  "modelName",
  "model_name",
  "operation",
  "target",
  "field_name",
  "column_name",
  "argument_name",
  "relation_name",
  "model_a_name",
  "model_b_name",
  "object_name",
  "constraint",
  "table",
  "column",
  "path",
  "code",
]);

/**
 * The keys of a driver adapter error's cause a log keeps (Prisma 7 puts it
 * in every database error's `meta.driverAdapterError`): its kind, its codes
 * and the schema it names. Its `originalMessage`, `message`, `detail` and
 * `cause` are the database's own text, which quotes values ("Failing row
 * contains (...)").
 */
const ADAPTER_CAUSE_KEYS: ReadonlySet<string> = new Set([
  "kind",
  "originalCode",
  "code",
  "constraint",
  "column",
  "table",
]);

function isObject(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The entries of `value` whose keys `keys` holds. */
function picked(
  value: Readonly<Record<string, unknown>>,
  keys: ReadonlySet<string>,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => keys.has(key)));
}

/** A Prisma error's `meta` as a log keeps it: the schema it names and its codes, never a value. */
function metaOf(meta: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const kept = picked(meta, META_KEYS);
  const adapter = meta.driverAdapterError;
  if (isObject(adapter)) {
    kept.driverAdapterError = {
      ...(typeof adapter.name === "string" ? { name: adapter.name } : {}),
      ...(isObject(adapter.cause) ? { cause: picked(adapter.cause, ADAPTER_CAUSE_KEYS) } : {}),
    };
  }
  return kept;
}

/** The longest `reason` kept of a Prisma error's message. */
const MAX_REASON = 300;

/**
 * A Prisma error, summarized (the 5.1 audit's CLIENT-5): its class, code,
 * the schema names and codes of its `meta` (`metaOf`), client version and
 * stack frames;
 * for a validation or initialization error, its message's last line, which
 * names arguments and never their values. Never the message: it renders the
 * call, values included, and the stack's first lines repeat it.
 */
export function prismaSummary(error: Error): Record<string, unknown> {
  const { code, errorCode, meta, clientVersion } = error as Error &
    Readonly<Record<"code" | "errorCode" | "meta" | "clientVersion", unknown>>;
  const described: Record<string, unknown> = { name: error.name };
  const kept = typeof code === "string" ? code : errorCode;
  if (typeof kept === "string") {
    described.code = kept;
  }
  if (isObject(meta)) {
    described.meta = metaOf(meta);
  }
  if (typeof clientVersion === "string") {
    described.clientVersion = clientVersion;
  }
  if (
    error.name === "PrismaClientValidationError" ||
    error.name === "PrismaClientInitializationError"
  ) {
    const lines = error.message.split("\n").filter((line) => line.trim() !== "");
    const reason = lines.at(-1)?.trim();
    if (reason !== undefined) {
      described.reason = reason.slice(0, MAX_REASON);
    }
  }
  const frames = error.stack?.split("\n").filter((line) => line.startsWith("    at "));
  if (frames !== undefined) {
    described.stack = frames.join("\n");
  }
  return described;
}

/**
 * One line for an error in a log message or a reply's text: a Prisma error
 * summarized as `"<class> <code>: <reason>"` (the parts it has; never the
 * call its message renders), another error's message, anything else as a
 * string.
 */
export function errorText(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  if (!isPrismaError(error)) {
    return error.message;
  }
  const { code, reason } = prismaSummary(error);
  const coded = typeof code === "string" ? `${error.name} ${code}` : error.name;
  return typeof reason === "string" ? `${coded}: ${reason}` : coded;
}
