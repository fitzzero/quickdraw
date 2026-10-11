// The logger contract and its console default (4.1 `src/shared/types.ts:525-545`),
// and how an error is written into a log (the 5.1 audit's CLIENT-5). The
// default writes every level outside production, and from `info` up when
// `NODE_ENV` is "production" (a call's record logs at debug with its caller's
// user id); `createConsoleLogger({ level })` names the lowest level written
// instead. A Prisma client error's message renders the call it failed,
// values included, so a log gets its summary (`prismaSummary`, `errorText`),
// never its message. Isomorphic: `process` may not exist, and NODE_ENV is
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

/** The keys of a Prisma error's `meta` that hold the database's own text, which can quote values. */
const DATABASE_TEXT = new Set(["message", "database_error"]);

/** The longest `reason` kept of a Prisma error's message. */
const MAX_REASON = 300;

/**
 * A Prisma error, summarized (the 5.1 audit's CLIENT-5): its class, code,
 * `meta` without the database's own text, client version and stack frames;
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
  if (typeof meta === "object" && meta !== null && !Array.isArray(meta)) {
    described.meta = Object.fromEntries(
      Object.entries(meta).filter(([key]) => !DATABASE_TEXT.has(key)),
    );
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
