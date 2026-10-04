// `admin.handlers(contract, { access?, displayName?, hiddenFields?,
// fieldOverrides?, rowless? })` (RFC 0003 section 12.4): the admin kit's
// server half.
// It finds the methods `admin.contract` made in the contract and returns an
// implementation of each, to spread into `defineService`'s `methods`:
//
//   export const taskService = qd.defineService(task, {
//     model: "task",
//     access: inherit({ from: project, via: "projectId" }),
//     methods: {
//       ...admin.handlers(task, { displayName: "Tasks", hiddenFields: ["internalNotes"] }),
//       rename: { access: { entry: "Moderate" }, handler: ... },
//     },
//   });
//
// Every method runs under `{ service: "Admin" }` unless `access` gives
// another: the caller's service-wide grant must be `Admin`, and a row-level
// `Admin` (the row's owner, say) is refused. That replaces the nine-key
// access block 4.1 apps repeated for `installAdminMethods`. `adminMeta`'s
// answer is worked out here, once (`meta.ts`). The handlers find their
// service through the call, so `defineService` refuses a service without a
// model, or one of another contract. On a service with an access policy, it
// also refuses a method on one row (`adminGet`, `adminUpdate`,
// `adminDelete`) given a form that checks no row below `Admin` (`{ service:
// "Moderate" }`, `"authenticated"`) unless `rowless` names it, since such a
// method reaches any row by its id.

import type { AnyContract } from "../../../contract/defineContract";
import { admin as contractHalf, adminSpecOf, type AdminSpec } from "../../../contract/kits/admin";
import { accessFormProblem } from "../../access/forms";
import type { AccessForm } from "../../access/types";
import { checkWhenDefined, type AnyService } from "../../service";
import { kitEntry, rowlessMethods } from "../rowless";
import { adminFieldsOf, type AdminFields } from "./meta";
import { ADMIN_DEFAULT_ACCESS, handlerOf } from "./methods";
import type {
  AdminAccess,
  AdminContract,
  AdminHandlersOptions,
  AdminImplementations,
} from "./types";

type UnknownRecord = Readonly<Record<string, unknown>>;

type Empty = Record<never, never>;

const OPTION_KEYS: readonly string[] = [
  "access",
  "displayName",
  "hiddenFields",
  "fieldOverrides",
  "rowless",
];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new TypeError(`admin.handlers: ${message}`);
}

/** The admin kit's methods in the contract, with what each was made for; at least one. */
function kitMethods(contract: unknown): [string, AdminSpec][] {
  const valid =
    isRecord(contract) &&
    typeof contract.name === "string" &&
    isRecord(contract.methods) &&
    Object.isFrozen(contract);
  if (!valid) {
    fail("the first argument must be a contract from defineContract");
  }
  const found: [string, AdminSpec][] = [];
  for (const [name, def] of Object.entries(contract.methods as UnknownRecord)) {
    const spec = adminSpecOf(def);
    if (spec !== undefined) {
      found.push([name, spec]);
    }
  }
  if (found.length === 0) {
    fail(`${String(contract.name)} has no method admin.contract made`);
  }
  if (found.some(([, spec]) => spec.entity !== contract.entity)) {
    fail(
      `admin.contract was given another schema than ${String(contract.name)}'s entity: pass the contract's entity schema`,
    );
  }
  return found;
}

function checkOptions(options: unknown): UnknownRecord {
  if (options === undefined) {
    return {};
  }
  if (!isRecord(options)) {
    fail("options must be { access?, displayName?, hiddenFields?, fieldOverrides?, rowless? }");
  }
  const unknownKey = Object.keys(options).find((key) => !OPTION_KEYS.includes(key));
  if (unknownKey !== undefined) {
    fail(`options has an unknown key "${unknownKey}"; the options are ${OPTION_KEYS.join(", ")}`);
  }
  return options;
}

/** The forms `access` gives, each for one of the kit's methods. */
function checkAccess(access: unknown, names: readonly string[]): UnknownRecord {
  if (access === undefined) {
    return {};
  }
  if (!isRecord(access)) {
    fail("access must map the kit's methods to access forms");
  }
  for (const [name, form] of Object.entries(access)) {
    if (!names.includes(name)) {
      fail(`access names "${name}", which is not a method admin.contract made`);
    }
    const problem = form === undefined ? undefined : accessFormProblem(form);
    if (problem !== undefined) {
      fail(`access for "${name}" ${problem}`);
    }
  }
  return access;
}

/** The kit's fields across its methods: every method's declared filter and sort fields. */
function fieldsOf(
  contract: AnyContract,
  kit: readonly [string, AdminSpec][],
  options: UnknownRecord,
): AdminFields {
  const specs = kit.map(([, spec]) => spec);
  const [first] = specs;
  const spec = {
    fields: first?.fields ?? [],
    filter: [...new Set(specs.flatMap((one) => one.filter))],
    sort: [...new Set(specs.flatMap((one) => one.sort))],
  };
  return adminFieldsOf(
    contract.name,
    spec,
    {
      displayName: options.displayName,
      hiddenFields: options.hiddenFields,
      fieldOverrides: options.fieldOverrides,
    },
    fail,
  );
}

/** Why a service cannot run the admin kit's handlers made for `contract`. */
function serviceProblem(service: AnyService, contract: AnyContract): string | undefined {
  if (service.contract !== contract) {
    return `its admin kit handlers were made for another contract; pass ${service.name}'s own contract to admin.handlers`;
  }
  return service.model === undefined
    ? "the admin kit reads and writes the service's rows: declare its model"
    : undefined;
}

function handlers<C extends AnyContract, const A extends AdminAccess<C> = Empty>(
  contract: C & NoInfer<AdminContract<C>>,
  options?: AdminHandlersOptions<C, A>,
): AdminImplementations<C, A> {
  const kit = kitMethods(contract);
  const checked = checkOptions(options);
  const names = kit.map(([name]) => name);
  const access = checkAccess(checked.access, names);
  const rowless = rowlessMethods(checked.rowless, names, fail);
  const fields = fieldsOf(contract, kit, checked);
  const entries: Record<string, object> = {};
  for (const [name, spec] of kit) {
    const form = (access[name] as AccessForm | undefined) ?? ADMIN_DEFAULT_ACCESS;
    const handler = handlerOf({ spec, fields, form });
    checkWhenDefined(handler, (service) => serviceProblem(service, contract));
    entries[name] = kitEntry(name, form, handler, rowless);
  }
  return Object.freeze(entries) as AdminImplementations<C, A>;
}

/**
 * The admin kit: `admin.handlers(contract, { access?, displayName?,
 * hiddenFields?, fieldOverrides?, rowless? })` implements the methods
 * `admin.contract` made in `contract`, each open to a service-wide `Admin`
 * grant unless `access` gives another form. `admin.contract` is here too,
 * for server code; a shared package imports it from the root export.
 */
export const admin = Object.freeze({ contract: contractHalf.contract, handlers });
