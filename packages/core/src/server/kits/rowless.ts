// The kits' `rowless` option: the kit methods whose access form is their
// whole check on purpose. Each one's implementation carries `rowless: true`,
// which `defineService`'s rowless check reads (`../access/rowless.ts`): on a
// service with an access policy, a kit method whose input has `id` (the
// read/write kit's `get`, the admin kit's `adminGet`, the sharing kit's
// access-list methods) under a form that checks no row is refused unless it
// is named here.

import type { AccessForm } from "../access/types";

/**
 * The kit methods `value` names, each one of the kit's `names`; an empty set
 * when it is left out. `fail` reports what is wrong with it.
 */
export function rowlessMethods(
  value: unknown,
  names: readonly string[],
  fail: (message: string) => never,
): ReadonlySet<string> {
  if (value === undefined) {
    return new Set();
  }
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
    fail("rowless must list the kit's methods whose access is their whole check");
  }
  const unknownName = value.find((name) => !names.includes(name));
  if (unknownName !== undefined) {
    fail(`rowless names "${String(unknownName)}", which is not one of the kit's methods`);
  }
  return new Set(value);
}

/** One kit method's implementation: its form and handler, with `rowless: true` when `rowless` names it. */
export function kitEntry(
  name: string,
  form: AccessForm,
  handler: object,
  rowless: ReadonlySet<string>,
): object {
  return Object.freeze(
    rowless.has(name) ? { access: form, handler, rowless: true } : { access: form, handler },
  );
}
