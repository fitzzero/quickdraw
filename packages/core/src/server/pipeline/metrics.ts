// The completion record (RFC 0003 section 9, step 9) and call logging. Every
// call produces exactly one record, handed to `onCall`, and one log entry:
// `debug` normally, `warn` when slower than `slowMs` or larger than
// `maxResponseBytes`, `error` when the call failed with `INTERNAL` or
// `TIMEOUT` (the failures that are the server's fault). An `INTERNAL`
// entry carries the original error with its stack. This replaces 4.1's two
// `info` entries per call (4.1 `src/server/ServiceRegistry.ts:331-373`).

import type { Logger } from "../../contract/logger";
import type { MethodKind } from "../../contract/methods";
import { QuickdrawError, type ErrorCode } from "../../protocol/errors";
import type { DevWarnings } from "../devWarnings";
import type { Transport } from "../types";

/** How a call ended: `"ok"`, `"not-modified"`, or the error code it failed with. */
export type CallOutcome = "ok" | "not-modified" | ErrorCode;

/** One call's completion record, handed to the dispatcher's `onCall`. */
export interface CallRecord {
  readonly service: string;
  readonly method: string;
  /** `undefined` when the method does not exist. */
  readonly kind: MethodKind | undefined;
  readonly transport: Transport;
  readonly requestId: string;
  readonly outcome: CallOutcome;
  /** From the call's arrival until its result was ready, in milliseconds. */
  readonly durationMs: number;
  /** Time spent waiting for a query slot, in milliseconds. */
  readonly queueMs: number;
  /** The reply's size as the transport measured it; 0 when it measured nothing. */
  readonly bytes: number;
  /** True when the result came from another call's run of the same query, or its `ttlMs` cache. */
  readonly shared: boolean;
  /**
   * Database statements the handler run issued, when the unit of work counts
   * them: the handler's own reads and writes, the reads a kit handler makes
   * to filter by access included. The access check before the handler (its
   * reads run before the unit opens), the flush after it and the per-caller
   * strip of field tiers are not counted. A shared run is counted once, on
   * the call that started it; a call that joined it reports `undefined`.
   */
  readonly sqlStatements: number | undefined;
}

/** Options of {@link createRecorder}. */
export interface RecorderOptions {
  readonly logger: Logger;
  readonly onCall: ((record: CallRecord) => void) | undefined;
  readonly slowMs: number;
  readonly maxResponseBytes: number;
  /** Raises `oversized-response` for a reply over `maxResponseBytes`. */
  readonly warnings?: DevWarnings;
}

/** What a record is logged with besides the record itself. */
export interface RecordDetails {
  /** The error the call failed with. */
  readonly error?: QuickdrawError;
  /** The caller's user id, for the log only. */
  readonly userId?: string;
}

/** The parts of an error worth logging, including its stack and cause. */
export function describeError(error: unknown, depth = 0): Record<string, unknown> {
  if (!(error instanceof Error)) {
    return { value: String(error) };
  }
  const described: Record<string, unknown> = {
    name: error.name,
    message: error.message,
    stack: error.stack,
  };
  if ("code" in error) {
    described.code = error.code;
  }
  if ("data" in error && error.data !== undefined) {
    described.data = error.data;
  }
  if (error.cause !== undefined && depth < 3) {
    described.cause = describeError(error.cause, depth + 1);
  }
  return described;
}

type Level = "debug" | "warn" | "error";

/** True for the codes of server faults, which log at error; every other code the client caused. */
function isFault(code: unknown): boolean {
  return code === "INTERNAL" || code === "TIMEOUT";
}

/**
 * The level a failure outside a call logs at, as a call's failure does:
 * `debug` for a `QuickdrawError` the client caused (any code but `INTERNAL`
 * and `TIMEOUT`), else `error`. A channel handler refusing a payload must
 * not fill the error log.
 */
export function failureLevel(error: unknown): "debug" | "error" {
  return error instanceof QuickdrawError && !isFault(error.code) ? "debug" : "error";
}

function levelOf(record: CallRecord, options: RecorderOptions): Level {
  if (isFault(record.outcome)) {
    return "error";
  }
  const slow = record.durationMs > options.slowMs;
  return slow || record.bytes > options.maxResponseBytes ? "warn" : "debug";
}

/** Hands `record` to `onCall`; what it throws is logged, never thrown. */
function emit(options: RecorderOptions, record: CallRecord): void {
  if (options.onCall === undefined) {
    return;
  }
  try {
    options.onCall(record);
  } catch (error) {
    options.logger.error("onCall threw; the call was not affected", {
      category: "quickdraw.call",
      error: describeError(error),
    });
  }
}

/**
 * The `oversized-response` development warning, for a method whose reply
 * was larger than `maxResponseBytes`. It is raised after the record went to
 * `onCall`, because a strict test app throws it.
 */
function warnOversized(options: RecorderOptions, record: CallRecord): void {
  if (record.kind === undefined || record.bytes <= options.maxResponseBytes) {
    return;
  }
  options.warnings?.warn({
    kind: "oversized-response",
    service: record.service,
    method: record.method,
    message:
      `replied with ${record.bytes} bytes, more than maxResponseBytes (${options.maxResponseBytes}); ` +
      "page the result (take and a cursor), return a leaner projection, or serve it as a collection",
    meta: { bytes: record.bytes, maxResponseBytes: options.maxResponseBytes },
  });
}

/**
 * Returns the function that logs a call's record and hands it to `onCall`.
 * In a strict test app it throws an oversized reply's `DevWarningError`
 * once it has done both.
 */
export function createRecorder(
  options: RecorderOptions,
): (record: CallRecord, details: RecordDetails) => void {
  return (record, details) => {
    const meta: Record<string, unknown> = { category: "quickdraw.call", ...record };
    if (details.userId !== undefined) {
      meta.userId = details.userId;
    }
    if (details.error !== undefined) {
      meta.error = describeError(details.error);
    }
    const duration = Math.round(record.durationMs);
    const message = `${record.service}.${record.method} ${record.outcome} in ${duration} ms`;
    options.logger[levelOf(record, options)](message, meta);
    emit(options, record);
    warnOversized(options, record);
  };
}
