// The `tiered-field-in-output` development warning (finding F7.4 of the
// quickdraw-chat review). Field tiers (RFC 0003 section 6) strip what a
// reader may not receive from projection outputs only: `"entity"`, a named
// projection, and `nullable(...)` or `listOf(...)` of one. A method whose
// output is a schema of its own is sent as its handler returned it (section
// 9, step 6: output validation checks, never strips), so a key there that
// the contract tiers reaches every caller the method's access admits: the
// template's `updateUser` answered `email`, an `Admin` field, to a
// service-wide `Moderate` grant. When a dispatcher is made, each such key of
// each method of its services raises the warning once, naming the method,
// the key and the fix: answer `"entity"` (or a projection), which is
// stripped per caller, or leave the key out.
//
// The keys are the top-level keys of every object the output may be (each
// branch of a union, and the rows of a list), read from its Standard JSON
// Schema; an output without one (a Zod 3 schema) is not checked. A method
// whose access admits no caller below the field's level is left alone: a
// service-wide `Admin` grant (`{ service: "Admin" }`, while the service's
// Admin bypass is on, as it is by default), and `{ entry: L }` with `L` at or
// above the field's level, whose caller holds that level on the row its
// input names (the row such a method answers with). A form with both halves
// must pass on both. Every other form warns: `"public"`, `"authenticated"`,
// `{ service: L }` below `Admin`, `{ scope }` (a level on another service's
// row) and `custom`.

import type { AccessLevel } from "../../contract/access";
import { isStandardSchema } from "../../contract/standardSchema";
import { isCustomAccess } from "../access/forms";
import { meetsLevel } from "../access/levels";
import type { AccessForm } from "../access/types";
import type { DevWarning, DevWarnings } from "../devWarnings";
import type { Registry } from "../registry";
import type { AnyService } from "../service";
import { outputKeys } from "./projection";

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

function warningFor(
  service: AnyService,
  method: string,
  key: string,
  level: AccessLevel,
): DevWarning {
  return {
    kind: "tiered-field-in-output",
    service: service.name,
    method,
    subject: key,
    message:
      `its output schema names "${key}", which the contract gives only to readers with ${level} on the row ` +
      `(fields: { ${key}: "${level}" }), but a schema output is sent as the handler returns it to every caller ` +
      `its access admits: field tiers strip only projection outputs. Answer "entity" (or a projection, ` +
      `nullable(...) or listOf(...)), which is stripped per caller, or leave "${key}" out of the schema`,
    meta: { field: key, level },
  };
}

/** The warnings `service`'s methods raise: one per tiered key a schema output names. */
export function tieredOutputWarnings(service: AnyService): DevWarning[] {
  const { fields } = service.contract;
  if (fields === undefined || Object.keys(fields).length === 0) {
    return [];
  }
  const warnings: DevWarning[] = [];
  for (const [name, def] of Object.entries(service.contract.methods)) {
    const method = service.methods[name];
    if (method === undefined || !isStandardSchema(def.output)) {
      continue;
    }
    for (const key of outputKeys(def.output) ?? []) {
      const level = Object.hasOwn(fields, key) ? fields[key] : undefined;
      if (level !== undefined && !admitsOnlyAt(method.access, level, service.adminBypass)) {
        warnings.push(warningFor(service, name, key, level));
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
