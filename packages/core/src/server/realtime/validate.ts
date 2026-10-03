// Synchronous schema checks for the realtime paths (RFC 0003 section 12.5):
// a channel message, a pushed stream item and an emitted event are checked
// where they happen, with no promise per message. A Standard Schema may
// validate asynchronously (an async refinement); such a schema cannot be
// used on these paths, and `validateNow` says so instead of awaiting it.

import type { StandardSchemaV1, ValidationIssue } from "../../contract/standardSchema";
import { QuickdrawError } from "../../protocol/errors";
import { toWireIssues } from "../pipeline/validation";

/** What a synchronous check found: the parsed value, the issues, or that the schema is asynchronous. */
export type SyncValidation =
  | { readonly value: unknown; readonly issues?: undefined }
  | { readonly issues: readonly ValidationIssue[] }
  | "async";

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/** Validates `value` against `schema` without awaiting: `"async"` when the schema answers with a promise. */
export function validateNow(schema: StandardSchemaV1, value: unknown): SyncValidation {
  const result = schema["~standard"].validate(value);
  if (isThenable(result)) {
    // Not awaited: keep a rejection from going unhandled.
    Promise.resolve(result).catch(() => undefined);
    return "async";
  }
  return result.issues === undefined ? { value: result.value } : { issues: result.issues };
}

/**
 * Checks what the server is about to send (a stream item, an event payload)
 * against its schema and returns the validated value, which is what goes
 * out: streams and events have no projections, so the schema is what keeps
 * the app's other keys off the wire (a Zod object strips them). A mismatch
 * is the app's bug, so it throws `INTERNAL` with the issues (logged, never
 * sent), and nothing is sent.
 */
export function checkOutgoing(schema: StandardSchemaV1, value: unknown, label: string): unknown {
  const result = validateNow(schema, value);
  if (result === "async") {
    throw new TypeError(
      `${label}: its schema validates asynchronously; streams and events are checked synchronously, so use a synchronous schema`,
    );
  }
  if (result.issues !== undefined) {
    throw new QuickdrawError("INTERNAL", `${label} does not match its contract schema`, {
      issues: toWireIssues(result.issues),
    });
  }
  return result.value;
}
