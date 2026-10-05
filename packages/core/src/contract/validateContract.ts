// Definition-time checks for `defineContract`. The types catch the same
// mistakes at compile time; these catch them for JavaScript callers and casts,
// and freeze the result so a contract cannot change after it is defined.

import { ACCESS_LEVELS, type AccessLevel, isAccessLevel } from "./access";
import {
  type CollectionDef,
  DEFAULT_COLLECTION_LIMIT,
  DEFAULT_COLLECTION_MAX_LIMIT,
} from "./collections";
import type { AnyContract, RowSchema } from "./defineContract";
import type { MethodDef } from "./methods";
import { isStandardSchema } from "./standardSchema";
import { checkRealtime, type TakenNames } from "./validateRealtime";

type Fail = (message: string) => never;

type UnknownRecord = Readonly<Record<string, unknown>>;

// `useEntity`, `useEntities` and `admin` are members the client proxy places
// beside a service's methods and collections (RFC 0003 sections 11 and 12.4).
// `then` would make a service's caller look like a promise: `await` and
// `Promise.resolve` would call it, so the callers answer `undefined` for it.
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "subscribe",
  "unsubscribe",
  "call",
  "useEntity",
  "useEntities",
  "admin",
  "then",
]);

const DEFINITION_KEYS: ReadonlySet<string> = new Set([
  "entity",
  "projections",
  "fields",
  "methods",
  "collections",
  "streams",
  "channels",
  "events",
]);

const METHOD_KEYS: ReadonlySet<string> = new Set(["kind", "input", "output", "watch", "describe"]);

const COLLECTION_KEYS: ReadonlySet<string> = new Set([
  "scope",
  "item",
  "order",
  "where",
  "limit",
  "maxLimit",
  "index",
  "views",
  "access",
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function quote(names: Iterable<string>): string {
  const list = [...names].map((name) => `"${name}"`);
  return list.length === 0 ? "none" : list.join(", ");
}

function checkKeys(
  value: UnknownRecord,
  allowed: ReadonlySet<string>,
  owner: string,
  fail: Fail,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      fail(`${owner} has an unknown option "${key}"; the options are ${quote(allowed)}`);
    }
  }
}

/** An optional map member: absent is empty, anything else must be a plain object. */
function members(value: unknown, label: string, fail: Fail): UnknownRecord {
  if (value === undefined) {
    return {};
  }
  if (!isRecord(value)) {
    fail(`${label} must be an object`);
  }
  return value;
}

function checkMemberName(kind: "method" | "collection", name: string, fail: Fail): void {
  if (RESERVED_NAMES.has(name) || name.startsWith("$")) {
    fail(
      `${kind} "${name}" uses a reserved name; ${quote(RESERVED_NAMES)} and names starting with "$" are reserved`,
    );
  }
}

function checkEntity(entity: unknown, fail: Fail): RowSchema | undefined {
  if (entity !== undefined && !isStandardSchema(entity)) {
    fail("entity must be a Standard Schema");
  }
  return entity as RowSchema | undefined;
}

function checkProjections(
  value: unknown,
  hasEntity: boolean,
  fail: Fail,
): Record<string, RowSchema> {
  const projections = members(value, "projections", fail);
  const checked: Record<string, RowSchema> = {};
  for (const [name, schema] of Object.entries(projections)) {
    if (!hasEntity) {
      fail(`projection "${name}" needs an entity; declare the contract's entity first`);
    }
    if (name === "entity") {
      fail(`a projection is named "entity", which is the implicit full-row projection`);
    }
    if (!isStandardSchema(schema)) {
      fail(`projection "${name}" must be a Standard Schema`);
    }
    checked[name] = schema as RowSchema;
  }
  return checked;
}

function checkFields(value: unknown, hasEntity: boolean, fail: Fail): Record<string, AccessLevel> {
  const fields = members(value, "fields", fail);
  const checked: Record<string, AccessLevel> = {};
  for (const [field, level] of Object.entries(fields)) {
    if (!hasEntity) {
      fail(`field "${field}" needs an entity; declare the contract's entity first`);
    }
    if (field === "id") {
      fail(`fields cannot restrict "id"; every subscriber receives it`);
    }
    if (!isAccessLevel(level)) {
      fail(`field "${field}" must map to one of ${quote(ACCESS_LEVELS)}`);
    }
    checked[field] = level;
  }
  return checked;
}

/** The projection a method output names, or undefined when the output is not a projection. */
function projectionOf(output: unknown): unknown {
  if (typeof output === "string") {
    return output;
  }
  if (isRecord(output) && (output.kind === "nullable" || output.kind === "list")) {
    return output.projection;
  }
  return undefined;
}

interface MethodScope {
  readonly projections: ReadonlySet<string>;
  readonly collections: ReadonlySet<string>;
}

function checkOutput(name: string, output: unknown, scope: MethodScope, fail: Fail): void {
  if (isStandardSchema(output)) {
    return;
  }
  const projection = projectionOf(output);
  if (typeof projection !== "string") {
    fail(
      `method "${name}": output must be a Standard Schema, a projection name, nullable(...) or listOf(...)`,
    );
  }
  if (!scope.projections.has(projection)) {
    fail(
      `method "${name}" returns unknown projection "${projection}"; the projections are ${quote(scope.projections)}`,
    );
  }
}

/**
 * `watch: { service: [models] }`: a non-empty list of distinct model names
 * and nothing else. Whether they are the service's models (its `model` and
 * `writes`) only `defineService` knows.
 */
function checkServiceModels(name: string, watch: UnknownRecord, fail: Fail): void {
  const models: unknown = watch.service;
  const named =
    Array.isArray(models) &&
    models.length > 0 &&
    models.every((model) => typeof model === "string" && model !== "") &&
    new Set(models).size === models.length;
  if (!named || Object.keys(watch).length !== 1) {
    fail(
      `method "${name}": watch { service } lists the models of the service it watches, by the client's model name: { service: ["gameScore"] }`,
    );
  }
}

function checkWatch(name: string, method: UnknownRecord, scope: MethodScope, fail: Fail): void {
  const { watch } = method;
  if (watch === undefined) {
    return;
  }
  if (method.kind !== "query") {
    fail(`method "${name}" is a mutation; only a query can watch`);
  }
  if (watch === "service") {
    return;
  }
  if (isRecord(watch) && Object.hasOwn(watch, "service")) {
    checkServiceModels(name, watch, fail);
    return;
  }
  if (!isRecord(watch) || typeof watch.scope !== "function") {
    fail(
      `method "${name}": watch must be "service", { service: [models] }, or { collection, scope } with a scope function`,
    );
  }
  if (typeof watch.collection !== "string" || !scope.collections.has(watch.collection)) {
    fail(
      `method "${name}" watches unknown collection "${String(watch.collection)}"; the collections are ${quote(scope.collections)}`,
    );
  }
}

function checkMethod(name: string, method: unknown, scope: MethodScope, fail: Fail): MethodDef {
  checkMemberName("method", name, fail);
  if (!isRecord(method) || (method.kind !== "query" && method.kind !== "mutation")) {
    fail(`method "${name}" must be declared with query(...) or mutation(...)`);
  }
  checkKeys(method, METHOD_KEYS, `method "${name}"`, fail);
  if (!isStandardSchema(method.input)) {
    fail(`method "${name}": input must be a Standard Schema`);
  }
  checkOutput(name, method.output, scope, fail);
  checkWatch(name, method, scope, fail);
  if (method.describe !== undefined && !isName(method.describe)) {
    fail(`method "${name}": describe must be a non-empty string`);
  }
  return method as unknown as MethodDef;
}

function checkMethods(value: unknown, scope: MethodScope, fail: Fail): Record<string, MethodDef> {
  const checked: Record<string, MethodDef> = {};
  for (const [name, method] of Object.entries(members(value, "methods", fail))) {
    checked[name] = checkMethod(name, method, scope, fail);
  }
  return checked;
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function checkScope(owner: string, scope: unknown, fail: Fail): void {
  if (isName(scope)) {
    return;
  }
  const isVia =
    isRecord(scope) &&
    scope.kind === "via" &&
    isName(scope.model) &&
    isName(scope.entry) &&
    isName(scope.scope);
  if (!isVia) {
    fail(`${owner}: scope must be a column name or via({ model, entry, scope })`);
  }
  const { refreshEntry } = scope as { readonly refreshEntry?: unknown };
  if (refreshEntry !== undefined && typeof refreshEntry !== "boolean") {
    fail(`${owner}: via's refreshEntry must be true or false`);
  }
}

function isSortColumn(entry: unknown): entry is readonly [string, string] {
  return (
    Array.isArray(entry) &&
    entry.length === 2 &&
    isName(entry[0]) &&
    (entry[1] === "asc" || entry[1] === "desc")
  );
}

function checkOrder(owner: string, order: unknown, fail: Fail): void {
  if (!Array.isArray(order) || order.length === 0 || !order.every(isSortColumn)) {
    fail(`${owner}: order must be a list of [column, "asc" | "desc"] pairs ending with "id"`);
  }
  const last: unknown = order.at(-1);
  if (!isSortColumn(last) || last[0] !== "id") {
    fail(`${owner}: order must end with "id" so every row has a unique cursor position`);
  }
}

function checkWhere(owner: string, where: unknown, fail: Fail): void {
  if (where === undefined) {
    return;
  }
  const scalar = (value: unknown): boolean =>
    value === null || ["string", "number", "boolean"].includes(typeof value);
  if (!isRecord(where) || !Object.values(where).every(scalar)) {
    fail(`${owner}: where must map columns to strings, numbers, booleans or null`);
  }
}

function checkLimits(owner: string, collection: UnknownRecord, fail: Fail): void {
  const positive = (value: unknown): boolean =>
    value === undefined || (Number.isInteger(value) && (value as number) > 0);
  if (!positive(collection.limit) || !positive(collection.maxLimit)) {
    fail(`${owner}: limit and maxLimit must be positive integers`);
  }
  const limit = (collection.limit as number | undefined) ?? DEFAULT_COLLECTION_LIMIT;
  const maxLimit = (collection.maxLimit as number | undefined) ?? DEFAULT_COLLECTION_MAX_LIMIT;
  if (limit > maxLimit) {
    fail(`${owner}: limit (${limit}) is larger than maxLimit (${maxLimit})`);
  }
}

function checkIndexAndViews(owner: string, collection: UnknownRecord, fail: Fail): void {
  const { index, views } = collection;
  if (index !== undefined && (!Array.isArray(index) || !index.every(isName))) {
    fail(`${owner}: index must be a list of item field names`);
  }
  if (views === undefined) {
    return;
  }
  if (index === undefined) {
    fail(`${owner} declares views but no index; views read index rows`);
  }
  if (!isRecord(views) || !Object.values(views).every((view) => typeof view === "function")) {
    fail(`${owner}: views must map names to predicate functions`);
  }
}

interface CollectionScope {
  readonly hasEntity: boolean;
  readonly projections: ReadonlySet<string>;
  readonly methods: ReadonlySet<string>;
}

function checkCollection(
  name: string,
  value: unknown,
  scope: CollectionScope,
  fail: Fail,
): CollectionDef {
  const owner = `collection "${name}"`;
  checkMemberName("collection", name, fail);
  if (name.includes(":")) {
    fail(
      `${owner} may not contain ":"; a change topic is {collection}:{scope}, split at its first colon`,
    );
  }
  if (scope.methods.has(name)) {
    fail(`${owner} has the same name as a method; the client exposes both as qd.<service>.${name}`);
  }
  if (!scope.hasEntity) {
    fail(`${owner} needs an entity; declare the contract's entity first`);
  }
  if (!isRecord(value)) {
    fail(`${owner} must be an object`);
  }
  checkKeys(value, COLLECTION_KEYS, owner, fail);
  checkScope(owner, value.scope, fail);
  if (typeof value.item !== "string" || !scope.projections.has(value.item)) {
    fail(
      `${owner}: item "${String(value.item)}" is not a projection; the projections are ${quote(scope.projections)}`,
    );
  }
  checkOrder(owner, value.order, fail);
  checkWhere(owner, value.where, fail);
  checkLimits(owner, value, fail);
  checkIndexAndViews(owner, value, fail);
  if (value.access !== undefined && !isAccessLevel(value.access)) {
    fail(`${owner}: access must be one of ${quote(ACCESS_LEVELS)}`);
  }
  return Object.freeze({ ...value }) as unknown as CollectionDef;
}

function checkCollections(
  value: unknown,
  scope: CollectionScope,
  fail: Fail,
): Record<string, CollectionDef> {
  const checked: Record<string, CollectionDef> = {};
  for (const [name, collection] of Object.entries(members(value, "collections", fail))) {
    checked[name] = checkCollection(name, collection, scope, fail);
  }
  return checked;
}

/** The names methods and collections took: streams, channels and events may not take them too. */
function takenNames(
  methods: Readonly<Record<string, MethodDef>>,
  collections: Readonly<Record<string, CollectionDef>>,
): TakenNames {
  const taken: TakenNames = new Map();
  for (const name of Object.keys(methods)) {
    taken.set(name, "method");
  }
  for (const name of Object.keys(collections)) {
    taken.set(name, "collection");
  }
  return taken;
}

/** Checks a contract definition and returns the frozen contract. */
export function assembleContract(name: unknown, def: unknown): AnyContract {
  if (!isName(name)) {
    throw new TypeError("defineContract: the service name must be a non-empty string");
  }
  const fail: Fail = (message) => {
    throw new TypeError(`defineContract("${name}"): ${message}`);
  };
  if (!isRecord(def)) {
    fail("the definition must be an object");
  }
  checkKeys(def, DEFINITION_KEYS, "the contract", fail);
  const entity = checkEntity(def.entity, fail);
  const hasEntity = entity !== undefined;
  const projections = checkProjections(def.projections, hasEntity, fail);
  const projectionNames = new Set(Object.keys(projections));
  if (hasEntity) {
    projectionNames.add("entity");
  }
  const collectionNames = new Set(Object.keys(members(def.collections, "collections", fail)));
  const methods = checkMethods(
    def.methods,
    { projections: projectionNames, collections: collectionNames },
    fail,
  );
  const collections = checkCollections(
    def.collections,
    { hasEntity, projections: projectionNames, methods: new Set(Object.keys(methods)) },
    fail,
  );
  const realtime = checkRealtime(
    def,
    {
      hasEntity,
      collections: collectionNames,
      taken: takenNames(methods, collections),
      reserved: RESERVED_NAMES,
    },
    fail,
  );
  return Object.freeze({
    name,
    entity,
    projections: Object.freeze(projections),
    fields: Object.freeze(checkFields(def.fields, hasEntity, fail)),
    methods: Object.freeze(methods),
    collections: Object.freeze(collections),
    ...realtime,
  });
}
