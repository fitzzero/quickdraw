// `sharing.handlers(contract, { access?, resolveUser?, onChange? })` (RFC
// 0003 section 12.3): the sharing and membership kit's server half. It finds
// the methods `sharing.contract` made in the contract and returns an
// implementation of each, to spread into `defineService`'s `methods`:
//
//   export const projectService = qd.defineService(project, {
//     model: "project",
//     access: anyOf(jsonAcl("acl", { owner: "ownerId" }), members({ ... })),
//     methods: { ...sharing.handlers(project) },
//   });
//
// Each method runs under the kit's default form (a change needs `Admin` on
// the row, a list `Read`, `leave` a signed-in member) unless `access` gives
// another. The kit changes the access list or membership table the service's
// own policy reads, so `defineService` refuses a service whose policy has
// none for a mode the contract uses (`policy.ts`), or that has no model.

import type { AnyContract } from "../../../contract/defineContract";
import {
  sharing as contractHalf,
  sharingSpecOf,
  type SharingMode,
  type SharingSpec,
} from "../../../contract/kits/sharing";
import { accessFormProblem } from "../../access/forms";
import type { AccessForm } from "../../access/types";
import { checkWhenDefined, type AnyService } from "../../service";
import type { HandlerContext } from "./context";
import { DEFAULT_ACCESS, handlerOf } from "./methods";
import { policyProblem } from "./policy";
import type {
  SharingAccess,
  SharingContract,
  SharingImplementations,
  SharingOptionsArgs,
} from "./types";

type UnknownRecord = Readonly<Record<string, unknown>>;

type Empty = Record<never, never>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new TypeError(`sharing.handlers: ${message}`);
}

/** The sharing kit's methods in the contract, with what each was made for; at least one. */
function kitMethods(contract: unknown): [string, SharingSpec][] {
  const valid =
    isRecord(contract) &&
    typeof contract.name === "string" &&
    isRecord(contract.methods) &&
    Object.isFrozen(contract);
  if (!valid) {
    fail("the first argument must be a contract from defineContract");
  }
  const found: [string, SharingSpec][] = [];
  for (const [name, def] of Object.entries(contract.methods as UnknownRecord)) {
    const spec = sharingSpecOf(def);
    if (spec !== undefined) {
      found.push([name, spec]);
    }
  }
  if (found.length === 0) {
    fail(`${String(contract.name)} has no method sharing.contract made`);
  }
  return found;
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
      fail(`access names "${name}", which is not a method sharing.contract made`);
    }
    const problem = form === undefined ? undefined : accessFormProblem(form);
    if (problem !== undefined) {
      fail(`access for "${name}" ${problem}`);
    }
  }
  return access;
}

/** `resolveUser` and `onChange`: functions, and `resolveUser` exactly when a by-name method needs it. */
function checkHooks(
  options: UnknownRecord,
  kit: readonly [string, SharingSpec][],
): Omit<HandlerContext, "form"> {
  const { resolveUser, onChange } = options;
  const byName = kit.some(([, spec]) => ["shareByName", "inviteByName"].includes(spec.method));
  if (byName && typeof resolveUser !== "function") {
    fail("shareByName and inviteByName find their user with resolveUser: give it");
  }
  if (!byName && resolveUser !== undefined) {
    fail("resolveUser is for shareByName and inviteByName, which the contract does not have");
  }
  if (onChange !== undefined && typeof onChange !== "function") {
    fail("onChange must be a function of (change, ctx, db)");
  }
  return {
    resolveUser: resolveUser as HandlerContext["resolveUser"],
    onChange: onChange as HandlerContext["onChange"],
  };
}

function checkOptions(options: unknown): UnknownRecord {
  if (options === undefined) {
    return {};
  }
  if (!isRecord(options)) {
    fail("options must be { access?, resolveUser?, onChange? }");
  }
  const allowed = ["access", "resolveUser", "onChange"];
  const unknownKey = Object.keys(options).find((key) => !allowed.includes(key));
  if (unknownKey !== undefined) {
    fail(`options has an unknown key "${unknownKey}"; the options are ${allowed.join(", ")}`);
  }
  return options;
}

/** Why a service cannot run the sharing kit's handlers of `mode` made for `contract`. */
function serviceProblem(
  service: AnyService,
  contract: AnyContract,
  mode: SharingMode,
): string | undefined {
  if (service.contract !== contract) {
    return `its sharing kit handlers were made for another contract; pass ${service.name}'s own contract to sharing.handlers`;
  }
  if (service.model === undefined) {
    return "the sharing kit changes who may see the service's rows: declare its model";
  }
  return policyProblem(service, mode);
}

function handlers<C extends AnyContract, const A extends SharingAccess<C> = Empty, Db = unknown>(
  contract: C & NoInfer<SharingContract<C>>,
  ...rest: SharingOptionsArgs<C, A, Db>
): SharingImplementations<C, A, Db> {
  const kit = kitMethods(contract);
  const options = checkOptions(rest[0]);
  const access = checkAccess(
    options.access,
    kit.map(([name]) => name),
  );
  const hooks = checkHooks(options, kit);
  const entries: Record<string, object> = {};
  for (const [name, spec] of kit) {
    const form = (access[name] as AccessForm | undefined) ?? DEFAULT_ACCESS[spec.method];
    const handler = handlerOf(spec.method, Object.freeze({ ...hooks, form }));
    checkWhenDefined(handler, (service) => serviceProblem(service, contract, spec.mode));
    entries[name] = Object.freeze({ access: form, handler });
  }
  return Object.freeze(entries) as SharingImplementations<C, A, Db>;
}

/**
 * The sharing and membership kit: `sharing.handlers(contract, { access?,
 * resolveUser?, onChange? })` implements the methods `sharing.contract` made
 * in `contract`. `sharing.contract` is here too, for server code; a shared
 * package imports it from the root export.
 */
export const sharing = Object.freeze({ contract: contractHalf.contract, handlers });
