// Shape checks shared by the protocol's hand-written guards. Internal: the
// package root exports the guards built on these, not these.

/** An object that is not an array or `null`: what a JSON object decodes to. */
export type UnknownRecord = { readonly [key: string]: unknown };

/** True when `value` is an object that is not an array or `null`. */
export function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `value` is a non-empty string, as service and method names are. */
export function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
