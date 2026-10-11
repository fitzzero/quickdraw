// The run-time checks of `defineService`'s data options (RFC 0003 sections 3,
// 4.1, 5.3, 6 and 11.3): the `model` the rows live in and its `access`
// policy, the other models the service `writes`, the rows a write `affects`,
// the `versionColumn` "not modified" answers read, who may watch the
// service's change topic (`watchAccess`), and the kinds of principal it
// admits (`kinds`, within the app's; each method's within the service's,
// `access/kinds.ts`). The types make the same checks, kinds' narrowing
// aside; these repeat them for JavaScript callers and casts.

import { isAccessLevel } from "../contract/access";
import type { AnyContract } from "../contract/defineContract";
import { narrowKinds } from "./access/kinds";
import { isAccessPolicy, type AnyAccessPolicy } from "./access/policy";
import type { WatchAccess } from "./access/types";
import type { AffectsLink } from "./service";
import { modelKey } from "./storage";

type Fail = (message: string) => never;

type UnknownRecord = Readonly<Record<string, unknown>>;

/** The checked data options of a service definition. */
export interface ServiceData {
  readonly model: string | undefined;
  readonly access: AnyAccessPolicy | undefined;
  readonly writes: readonly string[];
  readonly affects: readonly AffectsLink[];
  readonly versionColumn: string | undefined;
  readonly watchAccess: WatchAccess | undefined;
  /** The kinds of principal the service admits: its own `kinds`, else the app's; `undefined` admits every kind. */
  readonly kinds: readonly string[] | undefined;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isContract(value: unknown): value is AnyContract {
  return isRecord(value) && isName(value.name) && Object.isFrozen(value);
}

/** The ids a link's value holds: a row id, a list of them, or nothing. */
function idsIn(value: unknown): readonly string[] {
  if (isName(value)) {
    return [value];
  }
  return Array.isArray(value) ? value.filter(isName) : [];
}

function checkLink(index: number, entry: unknown, fail: Fail): AffectsLink {
  const owner = `affects[${index}]`;
  if (!isRecord(entry) || !isContract(entry.service)) {
    fail(`${owner} must be { service: contract, id }`);
  }
  const { id, columns } = entry;
  if (isName(id)) {
    if (columns !== undefined) {
      fail(`${owner}: columns belong to an id function; an id column is its own column`);
    }
    return Object.freeze({
      service: entry.service,
      columns: Object.freeze([id]),
      ids: (values: UnknownRecord) => idsIn(values[id]),
    });
  }
  const listed = Array.isArray(columns) && columns.length > 0 && columns.every(isName);
  if (typeof id !== "function" || !listed) {
    fail(
      `${owner}: id must be a column holding the affected row's id, or a function of the written row with the columns it reads in columns`,
    );
  }
  const read = id as (values: UnknownRecord) => unknown;
  return Object.freeze({
    service: entry.service,
    columns: Object.freeze([...(columns as readonly string[])]),
    ids: (values: UnknownRecord) => idsIn(read(values)),
  });
}

function checkAffects(value: unknown, model: string | undefined, fail: Fail): AffectsLink[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail("affects must be a list of { service, id }");
  }
  if (model === undefined) {
    fail("affects needs model: it reads the written rows of the service's model");
  }
  return value.map((entry: unknown, index) => checkLink(index, entry, fail));
}

function checkWrites(value: unknown, fail: Fail): readonly string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every(isName)) {
    fail('writes must be a list of model names, as the client names them ("taskLabel")');
  }
  return Object.freeze([...(value as readonly string[])]);
}

/** `watchAccess`: `"public"`, `"authenticated"` or `{ service: level }`; none keeps the service topic closed. */
function checkWatchAccess(value: unknown, fail: Fail): WatchAccess | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === "public" || value === "authenticated") {
    return value;
  }
  if (!isRecord(value) || Object.keys(value).length !== 1 || !isAccessLevel(value.service)) {
    fail('watchAccess must be "public", "authenticated" or { service: level }');
  }
  return Object.freeze({ service: value.service });
}

/**
 * `initQuickdraw`'s `kinds`, checked: the kinds of principal every service
 * the instance defines admits, unless it narrows them.
 */
export function checkAppKinds(value: unknown): readonly string[] | undefined {
  return narrowKinds(value, undefined, (message) => {
    throw new TypeError(`initQuickdraw: ${message}`);
  });
}

/**
 * A method's own `kinds`, within its service's: the kinds it admits, its
 * service's when it declares none. A `"public"` method declares none, since a
 * caller of a kind it left out would call it signed out; it keeps the
 * service's list, which signed-in callers meet.
 */
export function checkMethodKinds(
  owner: string,
  entry: UnknownRecord,
  data: ServiceData,
  fail: Fail,
): readonly string[] | undefined {
  if (entry.kinds !== undefined && entry.access === "public") {
    fail(
      `${owner} is "public", so kinds cannot narrow who may call it: a caller of a kind it left out would call it signed out. Leave kinds out, or give it a form that needs a principal`,
    );
  }
  return narrowKinds(entry.kinds, { kinds: data.kinds, by: "its service" }, (message) =>
    fail(`${owner}: ${message}`),
  );
}

/**
 * Checks a definition's `model`, `access`, `writes`, `affects`,
 * `versionColumn`, `watchAccess` and `kinds`, the last within `appKinds`, the
 * kinds of principal `initQuickdraw` admits.
 */
export function checkServiceData(
  definition: UnknownRecord,
  appKinds: readonly string[] | undefined,
  fail: Fail,
): ServiceData {
  const { model, access, versionColumn } = definition;
  if (model !== undefined && !isName(model)) {
    fail('model must be the database model the rows live in, as the client names it ("task")');
  }
  if (access !== undefined && !isAccessPolicy(access)) {
    fail("access must be an access policy: owner, jsonAcl, members, inherit, anyOf or resolver");
  }
  if (access !== undefined && model === undefined) {
    fail("access needs model: an access policy reads the rows of the service's model");
  }
  if (versionColumn !== undefined && (!isName(versionColumn) || model === undefined)) {
    fail("versionColumn must be a column of the service's model, so it needs model");
  }
  return {
    model,
    access,
    writes: checkWrites(definition.writes, fail),
    affects: Object.freeze(checkAffects(definition.affects, model, fail)),
    versionColumn,
    watchAccess: checkWatchAccess(definition.watchAccess, fail),
    kinds: narrowKinds(definition.kinds, { kinds: appKinds, by: "initQuickdraw" }, fail),
  };
}

/**
 * `watch: { service: [models] }` names models whose writes change the
 * service's topic: its `model` and those in its `writes` (finding F7.3).
 * Any other name could never match, so the query would never be told.
 */
export function checkWatchedModels(
  contract: AnyContract,
  name: string,
  models: unknown,
  data: ServiceData,
  fail: Fail,
): void {
  const own = [data.model, ...data.writes].filter((model) => model !== undefined).map(modelKey);
  const listed = Array.isArray(models) ? models : [];
  const valid =
    listed.length > 0 &&
    listed.every((model) => typeof model === "string" && model !== "") &&
    new Set(listed.map((model) => modelKey(String(model)))).size === listed.length;
  if (!valid) {
    fail(
      `method "${name}": watch { service } lists the models of the service it watches: { service: ["gameScore"] }`,
    );
  }
  for (const model of listed as string[]) {
    if (!own.includes(modelKey(model))) {
      const known = own.length === 0 ? "none" : own.map((key) => `"${key}"`).join(", ");
      fail(
        `method "${name}" watches the model "${model}", which ${contract.name} neither declares as its model nor lists in writes (its models: ${known})`,
      );
    }
  }
}
