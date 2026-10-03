// The completion record (RFC 0003 section 9, step 9) and call logging. Every
// call produces exactly one record, handed to `onCall`, and one log entry:
// `debug` normally, `warn` when slower than `slowMs` or larger than
// `maxResponseBytes`, `error` when the call failed with `INTERNAL` or
// `TIMEOUT` (the failures that are the server's fault). An `INTERNAL`
// entry carries the original error with its stack. This replaces 4.1's two
// `info` entries per call (`legacy-src/server/ServiceRegistry.ts:331-373`).

import type { Logger } from "../../contract/logger";
import type { MethodKind } from "../../contract/methods";
import type { ErrorCode, QuickdrawError } from "../../protocol/errors";
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
  /** Database statements the handler run issued, when the unit of work counts them. */
  readonly sqlStatements: number | undefined;
}

/** Options of {@link createRecorder}. */
export interface RecorderOptions {
  readonly logger: Logger;
  readonly onCall: ((record: CallRecord) => void) | undefined;
  readonly slowMs: number;
  readonly maxResponseBytes: number;
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

function levelOf(record: CallRecord, options: RecorderOptions): Level {
  if (record.outcome === "INTERNAL" || record.outcome === "TIMEOUT") {
    return "error";
  }
  const slow = record.durationMs > options.slowMs;
  return slow || record.bytes > options.maxResponseBytes ? "warn" : "debug";
}

/** Returns the function that logs a call's record and hands it to `onCall`. */
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
  };
}
