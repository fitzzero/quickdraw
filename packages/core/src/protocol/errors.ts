// Error codes and the error every failed call carries (RFC 0003 section 3).
// In 4.1 a failed call answered `{ success: false, error, code? }`
// (4.1 `src/shared/types.ts:88-90`), every thrown error became code 500
// with its own message (4.1 `src/server/ServiceRegistry.ts:398-402`), and
// the client rethrew it as `ServiceCallError` with that number
// (4.1 `src/client/serviceError.ts:6`). In 5.0 a handler picks the code by
// throwing `QuickdrawError`; the same code reaches the caller on every
// transport, and the HTTP transport maps it to a status with `httpStatus`.

import { isRecord } from "./guards";

/** Every code a call can fail with, in the order of RFC 0003 section 3. */
export const ERROR_CODES = Object.freeze([
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "VALIDATION",
  "RATE_LIMITED",
  "CANCELLED",
  "TIMEOUT",
  "INTERNAL",
] as const);

/**
 * Why a call failed:
 *
 * - `UNAUTHENTICATED` (401): there is no principal.
 * - `FORBIDDEN` (403): access was denied.
 * - `NOT_FOUND` (404): an unknown service, method or row.
 * - `CONFLICT` (409): a unique or state conflict.
 * - `VALIDATION` (422): the input failed its schema; see {@link ValidationErrorData}.
 * - `RATE_LIMITED` (429): a limiter or a full queue; see {@link RateLimitedErrorData}.
 * - `CANCELLED` (499): the caller cancelled.
 * - `TIMEOUT` (504): the handler ran past its time limit.
 * - `INTERNAL` (500): anything else.
 */
export type ErrorCode = (typeof ERROR_CODES)[number];

const HTTP_STATUS: Readonly<Record<ErrorCode, number>> = Object.freeze({
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 422,
  RATE_LIMITED: 429,
  CANCELLED: 499,
  TIMEOUT: 504,
  INTERNAL: 500,
});

/** The message every `INTERNAL` error carries on the wire, whatever was thrown. */
export const INTERNAL_MESSAGE = "Internal error";

/** True when `value` is one of the error codes. */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === "string" && Object.hasOwn(HTTP_STATUS, value);
}

/** The HTTP status for an error code, as the table in RFC 0003 section 3 gives it. */
export function httpStatus(code: ErrorCode): number {
  return HTTP_STATUS[code];
}

/** One problem with a call's input, in a `VALIDATION` error's `data.issues`. */
export interface WireIssue {
  /** Where the problem is, as object keys and array indexes; empty for the input itself. */
  readonly path: readonly (string | number)[];
  readonly message: string;
}

/** The `data` of a `VALIDATION` error. */
export interface ValidationErrorData {
  readonly issues: readonly WireIssue[];
}

/** The `data` of a `RATE_LIMITED` error. */
export interface RateLimitedErrorData {
  /** How long to wait before trying again, in milliseconds. */
  readonly retryAfterMs: number;
}

/**
 * The error a failed call carries. A handler throws it to choose the code the
 * caller sees; the client rejects with it. Anything else a handler throws
 * reaches the caller as `INTERNAL` with a generic message (see {@link toWire}).
 */
export class QuickdrawError extends Error {
  /** Why the call failed. */
  readonly code: ErrorCode;
  /**
   * Details for the caller, sent as JSON: `issues` for `VALIDATION`,
   * `retryAfterMs` for `RATE_LIMITED`. `INTERNAL` errors never send it.
   */
  readonly data: unknown;

  constructor(code: ErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "QuickdrawError";
    this.code = code;
    this.data = data;
  }
}

/** An error as it travels: the `e` of a failed acknowledgement. */
export interface WireError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly data?: unknown;
}

/**
 * The wire form of whatever a call failed with. A `QuickdrawError` keeps its
 * code, message and data. Anything else, and every `INTERNAL` error, becomes
 * `{ code: "INTERNAL", message: "Internal error" }`: no stack, message or data
 * of an internal failure ever reaches the caller, so log the original first.
 */
export function toWire(error: unknown): WireError {
  if (!(error instanceof QuickdrawError) || error.code === "INTERNAL" || !isErrorCode(error.code)) {
    return { code: "INTERNAL", message: INTERNAL_MESSAGE };
  }
  return error.data === undefined
    ? { code: error.code, message: error.message }
    : { code: error.code, message: error.message, data: error.data };
}

/**
 * The `QuickdrawError` a wire error describes. A code this version does not
 * know becomes `INTERNAL`, keeping the message and data. A payload that is not
 * a wire error (not an object, or no string `message`) becomes a generic
 * `INTERNAL`. Either way the caller can branch on `code`.
 */
export function fromWire(payload: unknown): QuickdrawError {
  if (!isRecord(payload) || typeof payload.message !== "string") {
    return new QuickdrawError("INTERNAL", INTERNAL_MESSAGE);
  }
  const code = isErrorCode(payload.code) ? payload.code : "INTERNAL";
  return new QuickdrawError(code, payload.message, payload.data);
}
