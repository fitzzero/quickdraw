// Synchronous schema checks for the realtime paths (RFC 0003 section 12.5):
// `validateNow` (`contract/validateNow.ts`, which a room's host uses too),
// and what the server checks of what it sends.

import type { StandardSchemaV1 } from "../../contract/standardSchema";
import { validateNow } from "../../contract/validateNow";
import { QuickdrawError } from "../../protocol/errors";
import { toWireIssues } from "../pipeline/validation";

export { validateNow, type SyncValidation } from "../../contract/validateNow";

/**
 * Whether a stream's items are checked: always, unless it declared
 * `validate: "development"` and the dispatcher does not check outputs
 * (`outputValidation`, off in production).
 */
export function checksItems(
  stream: { readonly validate: "always" | "development" },
  outputValidation: boolean,
): boolean {
  return stream.validate === "always" || outputValidation;
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
