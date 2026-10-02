// Run-time side of the access forms: the `custom(fn)` builder, the shape
// check `defineService` runs on every method's form, and the row ids an
// `entry` or `scope` form refers to.

import { isAccessLevel } from "../../contract/access";
import { QuickdrawError } from "../../protocol/errors";
import type { AccessForm, CustomAccess, EntryAccess, ScopeAccess } from "./types";

/**
 * A custom access check: the call passes when `check(ctx, input)` resolves
 * `true`. The caller must be authenticated first, so `ctx.principal` is
 * never `null` in `check`. A service-wide `Admin` grant passes without
 * running it (unless the service sets `adminBypass: false`). A method with
 * custom access cannot `share: "all"`, because its result may depend on who
 * asks.
 *
 * @example
 * access: custom((ctx, input) => ctx.principal.userId === input.ownerId),
 */
export function custom<Input, Ctx>(
  check: (ctx: Ctx, input: Input) => boolean | PromiseLike<boolean>,
): CustomAccess<Input, Ctx> {
  if (typeof check !== "function") {
    throw new TypeError("custom(check): check must be a function");
  }
  return Object.freeze({ kind: "custom", check });
}

type UnknownForm = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownForm {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `form` is a `custom(fn)` form. */
export function isCustomAccess(form: AccessForm): form is CustomAccess {
  return typeof form === "object" && form.kind === "custom";
}

function isIdSelector(value: unknown): boolean {
  return (typeof value === "string" && value.length > 0) || typeof value === "function";
}

const OBJECT_FORM_KEYS = new Set(["service", "entry", "scope", "of", "id"]);

function objectFormProblem(form: UnknownForm): string | undefined {
  const unknownKey = Object.keys(form).find((key) => !OBJECT_FORM_KEYS.has(key));
  if (unknownKey !== undefined) {
    return `has an unknown key "${unknownKey}"`;
  }
  const levels = ["service", "entry", "scope"].filter((key) => form[key] !== undefined);
  if (levels.length === 0 || !levels.every((key) => isAccessLevel(form[key]))) {
    return "needs service, entry or scope set to an access level";
  }
  if (form.scope !== undefined) {
    const valid = levels.length === 1 && isRecord(form.of) && isIdSelector(form.id);
    return valid ? undefined : "a scope form is { scope, of: contract, id } and nothing else";
  }
  if (form.of !== undefined || (form.id !== undefined && !isIdSelector(form.id))) {
    return "id must be an input key or a function, and of belongs to scope forms";
  }
  return form.entry === undefined && form.id !== undefined
    ? "id belongs to entry and scope forms"
    : undefined;
}

/**
 * Why `form` is not an access form, or `undefined` when it is one. Run by
 * `defineService` so a JavaScript caller or a cast fails at definition time
 * rather than on the first call.
 */
export function accessFormProblem(form: unknown): string | undefined {
  if (form === "public" || form === "authenticated") {
    return undefined;
  }
  if (!isRecord(form)) {
    return 'must be "public", "authenticated", { service }, { entry }, { scope, of, id } or custom(fn)';
  }
  if (form.kind === "custom") {
    return typeof form.check === "function" ? undefined : "custom access needs a check function";
  }
  return objectFormProblem(form);
}

function idsFrom(value: unknown): readonly string[] | undefined {
  if (typeof value === "string" && value.length > 0) {
    return [value];
  }
  const isIdList =
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((id) => typeof id === "string" && id.length > 0);
  return isIdList ? (value as readonly string[]) : undefined;
}

/**
 * The row ids an `entry` or `scope` form refers to, read from the parsed
 * input: `id` names an input key or is a function of the input, and an
 * `entry` form without `id` reads `input.id`. A missing or empty id is a
 * `FORBIDDEN` call: a failed lookup denies.
 */
export function accessIds(form: EntryAccess | ScopeAccess, input: unknown): readonly string[] {
  const { id } = form;
  let value: unknown;
  if (typeof id === "function") {
    value = (id as (input: unknown) => unknown)(input);
  } else if (isRecord(input)) {
    value = input[id ?? "id"];
  }
  const ids = idsFrom(value);
  if (ids === undefined) {
    throw new QuickdrawError("FORBIDDEN", "Insufficient permissions");
  }
  return ids;
}
