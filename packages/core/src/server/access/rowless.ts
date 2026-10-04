// The rowless check, run by `defineService`. On a service with an access
// policy (RFC 0003 section 4.2), a method whose input has `id` reads or
// writes the row that id names. A form that checks the caller's level on no
// row, `"public"`, `"authenticated"` or `{ service: L }` with `L` below
// `Admin`, hands that row to anyone the form admits, whoever's row it is:
// 4.x's "a Read method with no row id is open to every signed-in user", in
// 5.0's spelling. Such a method is refused when it is defined, naming the
// two ways out: a form that asks the policy (`{ entry: L }`, or `{ service:
// L, entry: L }` to keep the grant), or `rowless: true` on the method, which
// says every caller the form admits may reach any row on purpose (public
// profiles, lookups by an id that tells nothing).
//
// The input's keys come from its Standard JSON Schema. An input that has
// none (a Zod 3 schema) cannot say whether it holds an `id`, so its method is
// not checked. `custom` forms decide for themselves, and so do the kit
// handlers that check the row whatever their form (`checksRowsItself`).

import { schemaKeys } from "../emit/projection";
import { isKitHandler, isRowChecked, type ServiceMethod } from "../service";
import { isCustomAccess } from "./forms";
import type { AccessForm } from "./types";

/** The forms that check the caller's level on no row: `"public"`, `"authenticated"`, `{ service: L }` below `Admin`. */
function checksNoRow(form: AccessForm): boolean {
  if (form === "public" || form === "authenticated") {
    return true;
  }
  return (
    typeof form === "object" &&
    !isCustomAccess(form) &&
    form.entry === undefined &&
    form.scope === undefined &&
    form.service !== undefined &&
    form.service !== "Admin"
  );
}

/** A form that checks no row as code, and who it lets reach every row, for the message. */
function described(form: AccessForm): { readonly code: string; readonly who: string } {
  if (form === "public") {
    return { code: '"public"', who: "anyone, signed in or not," };
  }
  if (form === "authenticated") {
    return { code: '"authenticated"', who: "every signed-in user" };
  }
  const level = typeof form === "object" && !isCustomAccess(form) ? form.service : undefined;
  return {
    code: `{ service: "${String(level)}" }`,
    who: `everyone with a service-wide ${String(level)} grant`,
  };
}

/** The form to suggest instead: the policy's check at the method's level, keeping a named grant. */
function suggestion(method: ServiceMethod): string {
  const { access } = method;
  if (typeof access === "object" && !isCustomAccess(access) && access.service !== undefined) {
    return `{ service: "${access.service}", entry: "${access.service}" }`;
  }
  return `{ entry: "${method.kind === "query" ? "Read" : "Moderate"}" }`;
}

/**
 * Why `method`, on a service with an access policy, must not be defined as
 * it is: its input has `id` and its form checks no row, and it did not say
 * `rowless: true`. `undefined` when it may.
 */
export function rowlessProblem(method: ServiceMethod): string | undefined {
  const { access, handler } = method;
  if (method.rowless || !checksNoRow(access) || isRowChecked(handler)) {
    return undefined;
  }
  if (schemaKeys(method.input, "input")?.includes("id") !== true) {
    return undefined;
  }
  const optOut = isKitHandler(handler)
    ? `name it in the kit's rowless option (rowless: ["${method.name}"])`
    : "set rowless: true on the method";
  const form = described(access);
  return (
    `method "${method.name}" takes a row id (its input has id), but its access ${form.code} checks no row: ` +
    `on a service with an access policy, that lets ${form.who} reach any row by its id. ` +
    `Give it ${suggestion(method)} so the policy decides, or, if every caller its access admits may reach any row, ${optOut}`
  );
}
