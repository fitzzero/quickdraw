// `crud.handlers(contract, { access, prepare?, rowless? })` (RFC 0003 section 12.1):
// the read/write kit's server half. It finds the methods `crud.contract` made
// in the contract and returns an implementation of each, to spread into
// `defineService`'s `methods`:
//
//   export const taskService = qd.defineService(task, {
//     model: "task",
//     access: inherit({ from: project, via: "projectId" }),
//     methods: {
//       ...crud.handlers(task, {
//         access: {
//           get: { entry: "Read" },
//           list: "authenticated",
//           update: { entry: "Moderate" },
//         },
//       }),
//       rename: { access: { entry: "Moderate" }, handler: ... },
//     },
//   });
//
// Every kit method needs a form in `access`, and nothing else may be there.
// The handlers find their service through the call (`kitRuntimeOf`), so the
// service must declare its `model`; `defineService` checks that when the
// service is defined, that a method on many rows of a service without an
// access policy has `"public"` or `{ service }` access (`access.ts`), and,
// on a service with one, that `get` under a form that checks no row
// (`"public"`, `"authenticated"`, `{ service }` below `Admin`) is named in
// `rowless`, which says every caller the form admits may read any row.

import type { AnyContract } from "../../../contract/defineContract";
import { crud as contractHalf, crudSpecOf, type CrudSpec } from "../../../contract/kits/crud";
import { accessFormProblem } from "../../access/forms";
import type { AccessForm } from "../../access/types";
import { checkWhenDefined, checksRowsItself, type AnyService } from "../../service";
import { kitEntry, rowlessMethods } from "../rowless";
import { everyRowProblem } from "./access";
import type { AnyPrepare } from "./create";
import { handlerOf } from "./methods";
import type { CrudAccess, CrudHandlersOptions, CrudImplementations } from "./types";

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new TypeError(`crud.handlers: ${message}`);
}

/** The kit's methods in the contract, with what each was made for. */
function kitMethods(contract: unknown): [string, CrudSpec][] {
  const valid =
    isRecord(contract) &&
    typeof contract.name === "string" &&
    isRecord(contract.methods) &&
    Object.isFrozen(contract);
  if (!valid) {
    fail("the first argument must be a contract from defineContract");
  }
  const found: [string, CrudSpec][] = [];
  for (const [name, def] of Object.entries(contract.methods as UnknownRecord)) {
    const spec = crudSpecOf(def);
    if (spec !== undefined) {
      found.push([name, spec]);
    }
  }
  return found;
}

/** The access forms, one per kit method and nothing else. */
function checkAccess(
  access: unknown,
  names: readonly string[],
): Readonly<Record<string, AccessForm>> {
  if (!isRecord(access)) {
    fail("access must map each of the kit's methods to an access form");
  }
  const missing = names.filter((name) => !Object.hasOwn(access, name));
  if (missing.length > 0) {
    fail(`access has no form for ${missing.map((name) => `"${name}"`).join(", ")}`);
  }
  for (const [name, form] of Object.entries(access)) {
    if (!names.includes(name)) {
      fail(`access names "${name}", which is not a method crud.contract made`);
    }
    const problem = accessFormProblem(form);
    if (problem !== undefined) {
      fail(`access for "${name}" ${problem}`);
    }
  }
  return access as Readonly<Record<string, AccessForm>>;
}

/** The projection a `list`'s items are: the one whose schema `item` is, `"entity"` by default. */
function itemProjection(
  contract: AnyContract,
  spec: Extract<CrudSpec, { method: "list" }>,
): string {
  const { item } = spec;
  if (item === undefined || item === contract.entity) {
    return "entity";
  }
  const found = Object.entries(contract.projections).find(([, schema]) => schema === item);
  if (found === undefined) {
    fail(
      `list.item of ${contract.name} must be its entity schema or one of its projections' schemas`,
    );
  }
  return found[0];
}

/** `prepare`: a function, and only for a contract with the kit's `create`. */
function checkPrepare(
  prepare: unknown,
  kit: readonly [string, CrudSpec][],
): AnyPrepare | undefined {
  if (prepare === undefined) {
    return undefined;
  }
  if (typeof prepare !== "function" || !kit.some(([, spec]) => spec.method === "create")) {
    fail("prepare must be a function, for a contract with the kit's create");
  }
  return prepare as AnyPrepare;
}

/** The kit's methods on many rows: on a service without a policy, they reach every row. */
const MANY_ROWS: ReadonlySet<CrudSpec["method"]> = new Set([
  "list",
  "getMany",
  "bulkUpdate",
  "bulkDelete",
]);

/**
 * The kit's methods that check the caller's level on the row their `id`
 * names whatever their form (`checkRowWrite`), and `create`, whose `id` (when
 * its input has one) names a new row: `defineService`'s rowless check leaves
 * them alone. `get` reads the row its form lets the caller read, so a form
 * that checks no row needs `rowless`.
 */
const CHECKS_ROWS: ReadonlySet<CrudSpec["method"]> = new Set([
  "create",
  "update",
  "delete",
  "reorder",
]);

const OPTION_KEYS: readonly string[] = ["access", "prepare", "rowless"];

/** Why a service cannot run the kit's method `name`, made for `contract` with `form`. */
function serviceProblem(
  service: AnyService,
  contract: AnyContract,
  [name, spec]: readonly [string, CrudSpec],
  form: AccessForm,
): string | undefined {
  if (service.contract !== contract) {
    return `its read/write kit handlers were made for another contract; pass ${service.name}'s own contract to crud.handlers`;
  }
  if (service.model === undefined) {
    return "the read/write kit reads and writes the service's rows: declare its model";
  }
  return MANY_ROWS.has(spec.method) ? everyRowProblem(service, name, form) : undefined;
}

function handlers<C extends AnyContract, const A extends CrudAccess<C>, Db = unknown>(
  contract: C,
  options: CrudHandlersOptions<C, A, Db>,
): CrudImplementations<A, Db> {
  const kit = kitMethods(contract);
  if (!isRecord(options)) {
    fail("options must be { access, prepare?, rowless? }");
  }
  const unknownKey = Object.keys(options).find((key) => !OPTION_KEYS.includes(key));
  if (unknownKey !== undefined) {
    fail(`options has an unknown key "${unknownKey}"; the options are ${OPTION_KEYS.join(", ")}`);
  }
  const names = kit.map(([name]) => name);
  const access = checkAccess(options.access, names);
  const prepare = checkPrepare(options.prepare, kit);
  const rowless = rowlessMethods(options.rowless, names, fail);
  const entries: Record<string, object> = {};
  for (const [name, spec] of kit) {
    const form = access[name] as AccessForm;
    const projection = spec.method === "list" ? itemProjection(contract, spec) : "entity";
    const handler = handlerOf({ spec, form, projection, prepare });
    checkWhenDefined(handler, (service) => serviceProblem(service, contract, [name, spec], form));
    if (CHECKS_ROWS.has(spec.method)) {
      checksRowsItself(handler);
    }
    entries[name] = kitEntry(name, form, handler, rowless);
  }
  return Object.freeze(entries) as CrudImplementations<A, Db>;
}

/**
 * The read/write kit: `crud.handlers(contract, { access, prepare?, rowless? })`
 * implements exactly the methods `crud.contract` made in `contract`, each
 * with the access form `access` gives it (and `rowless: true` for the
 * methods `rowless` names). `crud.contract` is here too, for server code; a
 * shared package imports it from the root export.
 */
export const crud = Object.freeze({ contract: contractHalf.contract, handlers });
