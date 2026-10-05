// The `tiered-field-in-output` development warning (finding F7.4 of the
// quickdraw-chat review, widened by the final review of the release
// candidates). Field tiers (RFC 0003 section 6) strip what a reader may not
// receive from projection outputs only: `"entity"`, a named projection, and
// `nullable(...)` or `listOf(...)` of one. A method whose output is a schema
// of its own is sent as that schema declares it (section 9, step 8;
// `pipeline/schemaOutput.ts`), so a key the schema declares and the contract
// tiers reaches every caller the method's access admits: the template's
// `updateUser` answered `email`, an `Admin` field, to a service-wide
// `Moderate` grant. Two checks say so:
//
// - When a dispatcher is made, each tiered key a method's output schema
//   declares, at any depth (a nested `{ user: { id, email } }`, the rows of
//   a list, the values of a record), raises the warning once, naming the
//   method, the key, where the schema declares it, and the fix: answer
//   `"entity"` (or a projection), which is stripped per caller, or drop the
//   key from the schema. A key the schema does not declare needs no warning:
//   it is dropped before the reply leaves.
// - An output without JSON Schema (a Zod 3 schema) cannot be reduced and is
//   sent as the handler returns it. In development its replies are checked
//   instead: the first reply that carries a tiered key, at any depth, raises
//   the warning for that key.
//
// A method whose access admits no caller below the field's level is left
// alone: a service-wide `Admin` grant (`{ service: "Admin" }`, while the
// service's Admin bypass is on, as it is by default), and `{ entry: L }`
// with `L` at or above the field's level, whose caller holds that level on
// the row its input names (the row such a method answers with). A form with
// both halves must pass on both. Every other form warns: `"public"`,
// `"authenticated"`, `{ service: L }` below `Admin`, `{ scope }` (a level on
// another service's row) and `custom`. A kit's methods are left alone too:
// a kit strips what its readers may not see itself.

import type { AccessLevel } from "../../contract/access";
import { isCustomAccess } from "../access/forms";
import { meetsLevel } from "../access/levels";
import type { AccessForm } from "../access/types";
import type { DevWarning, DevWarnings } from "../devWarnings";
import type { Registry, RegisteredMethod } from "../registry";
import { isKitHandler, type AnyService, type ServiceMethod } from "../service";

/** True when every caller `form` admits holds `level` on the row the method answers about. */
function admitsOnlyAt(form: AccessForm, level: AccessLevel, adminBypass: boolean): boolean {
  if (typeof form !== "object" || isCustomAccess(form) || form.scope !== undefined) {
    return false;
  }
  const serviceHalf = form.service === undefined || (form.service === "Admin" && adminBypass);
  const entryHalf =
    form.entry === undefined ? form.service !== undefined : meetsLevel(form.entry, level);
  return serviceHalf && entryHalf;
}

/** The tiered keys a method's access may hand to a caller below their level, with those levels. */
function exposedTiers(
  service: AnyService,
  method: ServiceMethod,
): ReadonlyMap<string, AccessLevel> {
  const exposed = new Map<string, AccessLevel>();
  if (isKitHandler(method.handler)) {
    return exposed;
  }
  for (const [key, level] of Object.entries(service.contract.fields)) {
    if (!admitsOnlyAt(method.access, level, service.adminBypass)) {
      exposed.set(key, level);
    }
  }
  return exposed;
}

/** ` (at user.email)`, or nothing for a key at the top level. */
function where(key: string, path: string): string {
  return path === key ? "" : ` (at ${path})`;
}

function schemaWarning(
  service: AnyService,
  method: string,
  key: string,
  path: string,
  level: AccessLevel,
): DevWarning {
  return {
    kind: "tiered-field-in-output",
    service: service.name,
    method,
    subject: key,
    message:
      `its output schema names "${key}"${where(key, path)}, which the contract gives only to readers with ` +
      `${level} on the row (fields: { ${key}: "${level}" }), but a schema output is sent as its schema declares ` +
      `it to every caller the method's access admits: field tiers strip only projection outputs. Answer ` +
      `"entity" or a projection (or nullable(...) or listOf(...) of one), which is stripped per caller, or drop ` +
      `"${key}" from the schema`,
    meta: { field: key, level, path },
  };
}

function replyWarning(
  service: AnyService,
  method: string,
  key: string,
  path: string,
  level: AccessLevel,
): DevWarning {
  return {
    kind: "tiered-field-in-output",
    service: service.name,
    method,
    subject: key,
    message:
      `its reply carries "${key}"${where(key, path)}, which the contract gives only to readers with ${level} on ` +
      `the row (fields: { ${key}: "${level}" }), and was sent as the handler returned it to every caller the ` +
      `method's access admits: its output schema has no JSON Schema (a Zod 3 schema), so the reply cannot be ` +
      `reduced to it. Answer "entity" or a projection, which is stripped per caller, give the output a schema ` +
      `with JSON Schema (Zod 4.2 or later), or leave "${key}" out of what the handler returns`,
    meta: { field: key, level, path },
  };
}

/** The warnings `service`'s methods raise: one per tiered key an output schema declares. */
export function tieredOutputWarnings(service: AnyService): DevWarning[] {
  const warnings: DevWarning[] = [];
  for (const [name, method] of Object.entries(service.methods)) {
    const { schemaOutput } = method;
    if (schemaOutput === undefined) {
      continue;
    }
    const exposed = exposedTiers(service, method);
    if (exposed.size === 0) {
      continue;
    }
    const paths = schemaOutput.keyPaths();
    for (const [key, level] of exposed) {
      const path = paths.get(key);
      if (path !== undefined) {
        warnings.push(schemaWarning(service, name, key, path, level));
      }
    }
  }
  return warnings;
}

/**
 * Raises the `tiered-field-in-output` warnings of every service a
 * dispatcher serves: logged once each, or thrown by a test app made with
 * `strictWarnings`, failing its creation.
 */
export function warnTieredOutputs(registry: Registry, warnings: DevWarnings): void {
  if (!warnings.enabled) {
    return;
  }
  for (const service of registry.services.values()) {
    for (const warning of tieredOutputWarnings(service)) {
      warnings.warn(warning);
    }
  }
}

/** The plain objects and arrays a reply check reads at most: a development check, never a reply's cost. */
const MAX_CHECKED = 10_000;

/** Where `value` carries each of `keys`, at any depth of plain objects and arrays: the first path found. */
function carried(value: unknown, keys: ReadonlyMap<string, unknown>): Map<string, string> {
  const found = new Map<string, string>();
  const seen = new Set<object>();
  const queue: { readonly value: unknown; readonly path: string }[] = [{ value, path: "" }];
  for (let index = 0; index < queue.length && seen.size < MAX_CHECKED; index += 1) {
    const { value: item, path } = queue[index] as {
      readonly value: unknown;
      readonly path: string;
    };
    if (typeof item !== "object" || item === null || seen.has(item)) {
      continue;
    }
    seen.add(item);
    if (Array.isArray(item)) {
      for (const member of item) {
        queue.push({ value: member, path: `${path}[]` });
      }
      continue;
    }
    for (const [key, member] of Object.entries(item)) {
      const at = path === "" ? key : `${path}.${key}`;
      if (keys.has(key) && !found.has(key)) {
        found.set(key, at);
      }
      queue.push({ value: member, path: at });
    }
  }
  return found;
}

/** Each method's exposed tiers, for the reply check: worked out on its first reply. */
const replyChecks = new WeakMap<ServiceMethod, ReadonlyMap<string, AccessLevel>>();

/**
 * The development check of a reply whose output schema has no JSON Schema
 * (see the top of this file): raises the warning for each exposed tiered key
 * the reply carries. Every other output is reduced to its schema, or
 * stripped per caller, and needs none.
 */
export function warnTieredReply(
  target: RegisteredMethod,
  value: unknown,
  warnings: DevWarnings,
): void {
  const { service, method } = target;
  if (method.projection !== undefined || method.schemaOutput !== undefined) {
    return;
  }
  let exposed = replyChecks.get(method);
  if (exposed === undefined) {
    exposed = exposedTiers(service, method);
    replyChecks.set(method, exposed);
  }
  if (exposed.size === 0) {
    return;
  }
  for (const [key, path] of carried(value, exposed)) {
    warnings.warn(replyWarning(service, method.name, key, path, exposed.get(key) as AccessLevel));
  }
}
