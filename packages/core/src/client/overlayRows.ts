// What the query hooks show of a method's result (RFC 0003 section 11.4):
// the overlays of optimistic mutations over the rows it holds, by the shape
// of the method's output. Split from `optimistic.ts`, the overlay store.
//
// React-free.

import type { MethodOutput } from "../contract/methods";
import { isRecord } from "../protocol/guards";
import type { OverlayView } from "./optimistic";

/**
 * How a method's output holds rows of its service: one row (`"entity"` or a
 * projection name), one row or `null` (`nullable(...)`), or a list of rows
 * (`listOf(...)`). A schema output holds none.
 */
export type RowShape = "one" | "nullable" | "list";

/** The row shape of a method's output, or `undefined` for a schema output. */
export function rowShapeOf(output: MethodOutput | undefined): RowShape | undefined {
  if (typeof output === "string") {
    return "one";
  }
  if (!isRecord(output) || "~standard" in output) {
    return undefined;
  }
  if (output.kind === "nullable") {
    return "nullable";
  }
  return output.kind === "list" ? "list" : undefined;
}

/**
 * A result of shape `shape`, read at `readAt` (`OverlayOptions`), as `view`
 * shows it. A hidden row leaves a list and makes a `nullable` result `null`;
 * a result that must be a row keeps it. Returns `data` itself when no
 * overlay changes it.
 */
export function showRows<T>(
  view: OverlayView,
  shape: RowShape,
  data: T,
  readAt: number | undefined,
): T {
  const options = { readAt };
  if (shape !== "list") {
    const shown = view.apply(data, options);
    if (shown === undefined) {
      return (shape === "nullable" ? null : data) as T;
    }
    return shown;
  }
  if (!Array.isArray(data)) {
    return data;
  }
  const rows: unknown[] = [];
  let same = true;
  for (const row of data as unknown[]) {
    const shown = view.apply(row, options);
    same &&= shown === row;
    if (shown !== undefined) {
      rows.push(shown);
    }
  }
  return (same ? data : rows) as T;
}
