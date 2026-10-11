// The rowless check, run by `defineService`. On a service with an access
// policy (RFC 0003 section 4.2), a method whose input has `id` reads or
// writes the row that id names. A form that asks the policy nothing about
// that row hands it to anyone the form admits, whoever's row it is: 4.x's "a
// Read method with no row id is open to every signed-in user", in 5.0's
// spelling. Such a method is refused when it is defined, naming the ways
// out: a form that asks the policy about the row id names (`{ entry: L }`,
// or `{ service: L, entry: L }` to keep the grant), or `rowless: true` on the
// method, which says every caller the form admits may reach any row on
// purpose (public profiles, lookups by an id that tells nothing, a create
// whose `id` the client made).
//
// The forms refused:
//
// - the forms that check the caller's level on no row: `"public"`,
//   `"authenticated"`, `{ service: L }` with `L` below `Admin`;
// - `custom(fn)`, which asks the policy nothing: a claim check written as one
//   let any token holding the claim reach every tenant's rows, and a
//   service-wide `Admin` grant skips it (the 5.1 audit's ACCESS-1 and
//   ACCESS-4; a claim check is the method's `claims`, beside an `entry`
//   form, `claims.ts`);
// - `{ scope, of, id }`, which checks a row of another service, and `{
//   entry, id }` naming another key, which checks another row (ACCESS-5).
//
// The kit handlers that check the row whatever their form
// (`checksRowsItself`) stay exempt.
//
// The input's keys come from its Standard JSON Schema (`inputKeys`): the
// top-level keys of every object the input may be, so `id` in any branch of a
// union counts, with values JSON Schema cannot write (a `Date`, a `Set`, a
// `bigint`, a custom type) read as any value. Not checked: an input without
// JSON Schema (a Zod 3 schema), which cannot say whether it holds an `id`; an
// input that is no object (a bare string that is the id itself, an array, a
// record); a row named another way (`ids`, `taskId`, a nested `where.id`)
// under a form that checks the row id names; and an `entry` form whose `id`
// is a function, which names its row in code.

import { inputKeys } from "../emit/projection";
import { isKitHandler, isRowChecked, type ServiceMethod } from "../service";
import { isCustomAccess } from "./forms";
import type { AccessForm, EntryAccess, ScopeAccess } from "./types";

/**
 * What a form checks of the row `input.id` names: `"checked"` when the
 * policy decides on it (an `entry` form on `id`, or a function naming the
 * row in code, a `scope` form on the service's own rows by `id`, and a
 * service-wide `Admin` grant), `"none"` when the form
 * checks the caller's level on no row, `"custom"` for `custom(fn)`, and
 * `"other"` when it checks another row (a `scope` form, an `entry` form on
 * another key).
 */
export type Reach = "checked" | "none" | "custom" | "other";

/** What `form`, on service `service`, checks of the row `input.id` names ({@link Reach}). */
export function reachOf(form: AccessForm, service: string): Reach {
  if (form === "public" || form === "authenticated") {
    return "none";
  }
  if (isCustomAccess(form)) {
    return "custom";
  }
  if (form.scope !== undefined) {
    // A scope form on the service's own rows by `id` asks its own policy about that row.
    return form.of.name === service && form.id === "id" ? "checked" : "other";
  }
  if (form.entry !== undefined) {
    return typeof form.id === "string" && form.id !== "id" ? "other" : "checked";
  }
  return form.service === "Admin" ? "checked" : "none";
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

/** How an `id` selector is written in a message: the key, quoted, or a function's placeholder. */
function selector(id: unknown): string {
  return typeof id === "string" ? `"${id}"` : "(input) => ...";
}

/**
 * The message for a form that checks another row than the one `id` names:
 * a `scope` form, or an `entry` form on another key.
 */
function otherRow(form: EntryAccess<unknown> | ScopeAccess<unknown>, optOut: string): string {
  if (form.scope !== undefined) {
    const { scope, of } = form as ScopeAccess<unknown>;
    const id: unknown = form.id;
    const shown = `{ scope: "${scope}", of: ${of.name}, id: ${selector(id)} }`;
    if (id === "id") {
      return (
        `${shown} checks the ${of.name} row id names, not a row of this service: ` +
        "if id names a row of this service, that lets everyone it admits reach any row by its id. " +
        `Give it { entry: "${scope}" } so the policy decides on the row id names, or, if id names a ${of.name} row as the form says, or a row the method creates, or every caller its access admits may reach any row, ${optOut}`
      );
    }
    return (
      `${shown} checks a row of ${of.name}, not the row id names: ` +
      "on a service with an access policy, that lets everyone it admits reach any row by its id. " +
      `Give it { entry: "${scope}" } so the policy decides on the row id names, or, if id names a row the method creates (an id the client made) or every caller its access admits may reach any row, ${optOut}`
    );
  }
  const { entry, service, id } = form as EntryAccess<unknown>;
  const grant = service === undefined ? "" : `service: "${service}", `;
  return (
    `{ ${grant}entry: "${entry}", id: ${selector(id)} } checks the row ${String(id)} names, not the row id names: ` +
    "on a service with an access policy, that lets everyone it admits reach any row by its id. " +
    `Give it { ${grant}entry: "${entry}" } so the policy decides on the row id names, or, if every caller its access admits may reach any row, ${optOut}`
  );
}

/**
 * Why `method`, on a service with an access policy, must not be defined as
 * it is: its input has `id`, its form asks the policy nothing about the row
 * that id names, and it did not say `rowless: true`. `undefined` when it
 * may.
 */
export function rowlessProblem(method: ServiceMethod, service: string): string | undefined {
  const { access, handler } = method;
  const reach = reachOf(access, service);
  if (method.rowless || reach === "checked" || isRowChecked(handler)) {
    return undefined;
  }
  if (inputKeys(method.input)?.includes("id") !== true) {
    return undefined;
  }
  const optOut = isKitHandler(handler)
    ? `name it in the kit's rowless option (rowless: ["${method.name}"])`
    : "set rowless: true on the method";
  const start = `method "${method.name}" takes a row id (its input has id), but its access `;
  if (reach === "custom") {
    return (
      `${start}custom(check) asks the policy nothing about that row: ` +
      "on a service with an access policy, a check that passes lets the caller reach any row by its id, and a service-wide Admin grant skips the check. " +
      `Give it ${suggestion(method)} so the policy decides, with claims: (claims, input) => ... beside it for a check on the caller's claims, ` +
      `or, if every caller the check admits may reach any row, ${optOut}`
    );
  }
  if (reach === "other") {
    return `${start}${otherRow(access as EntryAccess<unknown> | ScopeAccess<unknown>, optOut)}`;
  }
  const form = described(access);
  return (
    `${start}${form.code} checks no row: ` +
    `on a service with an access policy, that lets ${form.who} reach any row by its id. ` +
    `Give it ${suggestion(method)} so the policy decides, or, if every caller its access admits may reach any row, ${optOut}`
  );
}
