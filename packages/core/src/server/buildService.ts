// The run-time half of `defineService`: the checks the types already make,
// repeated for JavaScript callers and casts, so a broken service fails when
// it is defined rather than on its first call. It returns the frozen
// service the registry and the dispatcher read.

import type { AnyContract } from "../contract/defineContract";
import type { MethodDef } from "../contract/methods";
import { accessFormProblem, isCustomAccess } from "./access/forms";
import { isAccessPolicy, type AnyAccessPolicy } from "./access/policy";
import type { AccessForm } from "./access/types";
import { MAX_TIMEOUT_MS } from "./pipeline/settings";
import { outputSchemaOf } from "./pipeline/validation";
import {
  registerRuntime,
  type AnyHandler,
  type AnyService,
  type ServiceMethod,
  type ServiceRuntime,
} from "./service";

type Fail = (message: string) => never;

type UnknownRecord = Readonly<Record<string, unknown>>;

const DEFINITION_KEYS = new Set(["model", "access", "methods", "adminBypass"]);

const METHOD_KEYS = new Set(["access", "handler", "share", "ttlMs", "timeoutMs", "version"]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkKeys(
  value: UnknownRecord,
  allowed: ReadonlySet<string>,
  owner: string,
  fail: Fail,
): void {
  const unknownKey = Object.keys(value).find((key) => !allowed.has(key));
  if (unknownKey !== undefined) {
    fail(
      `${owner} has an unknown option "${unknownKey}"; the options are ${[...allowed].join(", ")}`,
    );
  }
}

function isDuration(value: unknown, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 && value <= max;
}

function checkContract(contract: unknown): AnyContract {
  const valid =
    isRecord(contract) &&
    typeof contract.name === "string" &&
    contract.name.length > 0 &&
    isRecord(contract.methods) &&
    Object.isFrozen(contract);
  if (!valid) {
    throw new TypeError("defineService: the first argument must be a contract from defineContract");
  }
  return contract as unknown as AnyContract;
}

function checkShare(owner: string, entry: UnknownRecord, fail: Fail): void {
  const { share, ttlMs } = entry;
  if (share !== undefined && share !== "caller" && share !== "all") {
    fail(`${owner}: share must be "caller" or "all"`);
  }
  if (share === "all" && isRecord(entry.access) && entry.access.kind === "custom") {
    fail(
      `${owner} has custom access, so it cannot share: "all"; its result may depend on who asks`,
    );
  }
  if (ttlMs !== undefined && (share === undefined || !isDuration(ttlMs, MAX_TIMEOUT_MS))) {
    fail(`${owner}: ttlMs needs share and must be a positive number of milliseconds`);
  }
}

function checkQueryOptions(
  owner: string,
  entry: UnknownRecord,
  kind: MethodDef["kind"],
  fail: Fail,
): void {
  const queryOnly = [entry.share, entry.ttlMs, entry.version].some((value) => value !== undefined);
  if (kind === "mutation" && queryOnly) {
    fail(`${owner} is a mutation; share, ttlMs and version are for queries`);
  }
  checkShare(owner, entry, fail);
  if (entry.version !== undefined && typeof entry.version !== "function") {
    fail(`${owner}: version must be a function of (input, ctx)`);
  }
}

function checkMethod(
  contract: AnyContract,
  name: string,
  entry: unknown,
  fail: Fail,
): ServiceMethod {
  const owner = `method "${name}"`;
  const def = contract.methods[name];
  if (def === undefined) {
    fail(`"${name}" is not a method of the contract`);
  }
  if (!isRecord(entry)) {
    fail(`${owner} must be { access, handler }`);
  }
  checkKeys(entry, METHOD_KEYS, owner, fail);
  const accessProblem = accessFormProblem(entry.access);
  if (accessProblem !== undefined) {
    fail(`${owner}: access ${accessProblem}`);
  }
  if (typeof entry.handler !== "function") {
    fail(`${owner} needs a handler function`);
  }
  if (entry.timeoutMs !== undefined && !isDuration(entry.timeoutMs, MAX_TIMEOUT_MS)) {
    fail(
      `${owner}: timeoutMs must be a positive number of milliseconds, at most ${MAX_TIMEOUT_MS}`,
    );
  }
  checkQueryOptions(owner, entry, def.kind, fail);
  return Object.freeze({
    name,
    kind: def.kind,
    input: def.input,
    output: outputSchemaOf(contract, def.output),
    access: entry.access as AccessForm,
    handler: entry.handler as AnyHandler,
    share: entry.share as ServiceMethod["share"],
    ttlMs: entry.ttlMs as number | undefined,
    timeoutMs: entry.timeoutMs as number | undefined,
    version: entry.version as ServiceMethod["version"],
  });
}

function checkMethods(
  contract: AnyContract,
  value: unknown,
  fail: Fail,
): Record<string, ServiceMethod> {
  if (!isRecord(value)) {
    fail("methods must be an object with one implementation per contract method");
  }
  const missing = Object.keys(contract.methods).filter((name) => !Object.hasOwn(value, name));
  if (missing.length > 0) {
    fail(`methods has no implementation for ${missing.map((name) => `"${name}"`).join(", ")}`);
  }
  const methods: Record<string, ServiceMethod> = {};
  for (const [name, entry] of Object.entries(value)) {
    methods[name] = checkMethod(contract, name, entry, fail);
  }
  return methods;
}

/** The service's `model` and `access`: a policy reads rows of the service's own model, so it needs one. */
function checkData(
  definition: UnknownRecord,
  fail: Fail,
): { model: string | undefined; access: AnyAccessPolicy | undefined } {
  const { model, access } = definition;
  if (model !== undefined && (typeof model !== "string" || model.length === 0)) {
    fail('model must be the database model the rows live in, as the client names it ("task")');
  }
  if (access !== undefined && !isAccessPolicy(access)) {
    fail("access must be an access policy: owner, jsonAcl, members, inherit, anyOf or resolver");
  }
  if (access !== undefined && model === undefined) {
    fail("access needs model: an access policy reads the rows of the service's model");
  }
  return { model, access };
}

/**
 * The row-level access forms need what the service declares (RFC 0003
 * section 3): `entry` asks the service's own policy, and `scope` (another
 * service's policy) is for services that have a model. A service without a
 * model may only use `"public"`, `"authenticated"`, `{ service }` or `custom`.
 */
function checkRowForms(
  methods: Readonly<Record<string, ServiceMethod>>,
  data: { model: string | undefined; access: AnyAccessPolicy | undefined },
  fail: Fail,
): void {
  for (const method of Object.values(methods)) {
    const form = method.access;
    if (typeof form !== "object" || isCustomAccess(form)) {
      continue;
    }
    if (form.entry !== undefined && data.access === undefined) {
      fail(
        `method "${method.name}" uses entry access, which needs the service's access policy: declare model and access`,
      );
    }
    if (form.scope !== undefined && data.model === undefined) {
      fail(
        `method "${method.name}" uses scope access, but the service declares no model; a service without a model may only use "public", "authenticated", { service } or custom access`,
      );
    }
  }
}

/** Checks a service definition and returns the frozen service, registered with `runtime`. */
export function buildService(
  runtime: ServiceRuntime,
  contract: unknown,
  definition: unknown,
): AnyService {
  const checked = checkContract(contract);
  const fail: Fail = (message) => {
    throw new TypeError(`defineService("${checked.name}"): ${message}`);
  };
  if (!isRecord(definition)) {
    fail("the definition must be an object");
  }
  checkKeys(definition, DEFINITION_KEYS, "the definition", fail);
  const { adminBypass = true } = definition;
  if (typeof adminBypass !== "boolean") {
    fail("adminBypass must be a boolean");
  }
  const data = checkData(definition, fail);
  const methods = checkMethods(checked, definition.methods, fail);
  checkRowForms(methods, data, fail);
  const service: AnyService = Object.freeze({
    name: checked.name,
    contract: checked,
    model: data.model,
    access: data.access,
    adminBypass,
    methods: Object.freeze(methods),
  });
  registerRuntime(service, runtime);
  return service;
}
