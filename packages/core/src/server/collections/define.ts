// Collections as a service defines them (RFC 0003 section 7.1). The contract
// declares what a collection is: its scope column or junction, its item
// projection, its membership filter, its order, its page sizes and its index.
// The service adds what a contract cannot carry, because access policies live
// on the server: the contract whose rows the scope values are ids of
// (`anchor`), or `scopeAccess: "self"` for a scope whose value is the
// subscriber's own user id; and the `bulkThreshold` past which one flush's
// changes to a scope go out as a single `reset`. Every collection of the
// contract needs one or the other, so a scope nobody could authorize fails
// when the service is defined rather than when a client subscribes. A
// `"self"` scope is stripped at `Read` and may not declare a higher
// `access`, since no level is checked to subscribe to it. The
// index fields are checked here too, against the item projection only the
// service compiles: a contract cannot see a schema's keys. No order column
// may sit above the collection's `access` in the contract's `fields`, since
// cursors carry order columns' values.
//
// 4.1 defined a collection with functions (`resolveScopeId`,
// `checkScopeAccess`, `snapshot`, `toItem`;
// 4.1 `src/server/collections.ts:36-72`), so the framework could not know
// which writes move a row and read the whole row before every update.

import type { AccessLevel } from "../../contract/access";
import {
  DEFAULT_COLLECTION_LIMIT,
  DEFAULT_COLLECTION_MAX_LIMIT,
  type CollectionDef,
  type CollectionWhere,
  type OrderBy,
} from "../../contract/collections";
import type { AnyContract } from "../../contract/defineContract";
import { meetsLevel } from "../access/levels";
import type { Projection } from "../emit/projection";

type Fail = (message: string) => never;

type UnknownRecord = Readonly<Record<string, unknown>>;

/** How many changed rows of one scope a flush sends as deltas; past it, one `reset` instead. */
export const DEFAULT_BULK_THRESHOLD = 200;

/** Where a collection's scope value comes from: a column of the row, or a junction table. */
export type CollectionScope =
  | { readonly kind: "column"; readonly column: string }
  | {
      readonly kind: "via";
      /** The junction model, as the client names it. */
      readonly model: string;
      /** The junction column holding the row's id. */
      readonly entry: string;
      /** The junction column holding the scope value. */
      readonly scope: string;
      /** A junction write sends its entry again to every scope that still holds it (`via`'s `refreshEntry`). */
      readonly refreshEntry: boolean;
    };

/** One collection of a service: its contract declaration and the service's option, checked. */
export interface ServiceCollection {
  readonly name: string;
  readonly scope: CollectionScope;
  /** The item projection, compiled with the service's `project` option. */
  readonly item: Projection;
  /** The membership filter; empty when the collection declares none. */
  readonly where: CollectionWhere;
  readonly order: OrderBy;
  /** The page size of a snapshot that asks for none. */
  readonly limit: number;
  /** The largest page a snapshot may ask for. */
  readonly maxLimit: number;
  /** The level a subscriber needs on the scope's anchor row. */
  readonly access: AccessLevel;
  /** The contract of the rows scope values are ids of; `undefined` for a `"self"` scope. */
  readonly anchor: AnyContract | undefined;
  /** More changed rows than this for one scope in one flush go out as one `reset`. */
  readonly bulkThreshold: number;
  /**
   * The item fields every member's index row holds (RFC 0003 section 7.4),
   * in the order the contract declares them; `undefined` without an index.
   */
  readonly index: readonly string[] | undefined;
}

const OPTION_KEYS: ReadonlySet<string> = new Set(["anchor", "scopeAccess", "bulkThreshold"]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isContract(value: unknown): value is AnyContract {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    value.name.length > 0 &&
    Object.isFrozen(value)
  );
}

interface CheckedOption {
  readonly anchor: AnyContract | undefined;
  readonly bulkThreshold: number;
}

/** One entry of the service's `collections` option, checked. */
function checkOption(owner: string, option: unknown, fail: Fail): CheckedOption {
  if (!isRecord(option)) {
    fail(`${owner} must be { anchor: contract } or { scopeAccess: "self" }`);
  }
  const unknownKey = Object.keys(option).find((key) => !OPTION_KEYS.has(key));
  if (unknownKey !== undefined) {
    fail(
      `${owner} has an unknown option "${unknownKey}"; the options are anchor, scopeAccess and bulkThreshold`,
    );
  }
  const { anchor, scopeAccess, bulkThreshold = DEFAULT_BULK_THRESHOLD } = option;
  if ((anchor === undefined) === (scopeAccess === undefined)) {
    fail(
      `${owner} needs exactly one of anchor (the contract whose rows its scope values are ids of) and scopeAccess: "self"`,
    );
  }
  if (anchor !== undefined && !isContract(anchor)) {
    fail(`${owner}: anchor must be a contract from defineContract`);
  }
  if (scopeAccess !== undefined && scopeAccess !== "self") {
    fail(
      `${owner}: scopeAccess must be "self", for a scope whose value is the subscriber's user id`,
    );
  }
  if (
    typeof bulkThreshold !== "number" ||
    !Number.isSafeInteger(bulkThreshold) ||
    bulkThreshold < 1
  ) {
    fail(`${owner}: bulkThreshold must be a positive whole number`);
  }
  return { anchor: anchor as AnyContract | undefined, bulkThreshold };
}

/**
 * The collection's index fields, checked against its item (RFC 0003 sections
 * 2 and 7.4): each is a key of the item projection other than `id`, named
 * once, and one the collection's items carry, so not reserved by the
 * contract's `fields` for a level above the collection's `access`. An index
 * row holds what its item holds, nothing more. Every `order` column but `id`
 * is an index field, so a client can keep the index in order as deltas
 * arrive. `views` read index rows, so a collection with views needs an index.
 */
function checkIndex(
  name: string,
  def: CollectionDef,
  item: Projection,
  access: AccessLevel,
  fail: Fail,
): readonly string[] | undefined {
  const { index, views } = def;
  if (index === undefined) {
    if (views !== undefined) {
      fail(`collection "${name}" declares views but no index; views read index rows`);
    }
    return undefined;
  }
  if (!Array.isArray(index) || !index.every((field) => typeof field === "string")) {
    fail(`collection "${name}": index must be a list of item field names`);
  }
  const owner = `collection "${name}": index field`;
  const hidden = item.tiers.hidden(access);
  for (const [position, field] of index.entries()) {
    if (field === "id") {
      fail(`${owner} "id" is not needed; every index row starts with the member's id`);
    }
    if (!item.keys.includes(field)) {
      fail(
        `${owner} "${field}" is not a key of its item "${item.name}"; index fields are item fields`,
      );
    }
    if (hidden.has(field)) {
      fail(
        `${owner} "${field}" is reserved by the contract's fields for a level above the collection's access (${access}), so its items never carry it`,
      );
    }
    if (index.indexOf(field) !== position) {
      fail(`${owner} "${field}" is named twice`);
    }
  }
  checkIndexOrder(name, def.order, index, fail);
  return Object.freeze([...index]);
}

/**
 * No `order` column may be reserved by the contract's `fields` for a level
 * above the collection's `access`, index or not: a page's cursor carries
 * the last row's value of every order column, and the page's order tells
 * how the rows' values compare, so either would hand a subscriber the field.
 */
function checkOrderTiers(
  name: string,
  order: OrderBy,
  fields: Readonly<Record<string, AccessLevel>>,
  access: AccessLevel,
  fail: Fail,
): void {
  for (const [column] of order) {
    const required = Object.hasOwn(fields, column) ? fields[column] : undefined;
    if (required !== undefined && !meetsLevel(access, required)) {
      fail(
        `collection "${name}": order column "${column}" is reserved by the contract's fields for ${required}, above the collection's access (${access}); a page's cursor and order would tell its subscribers what it holds`,
      );
    }
  }
}

/** Every order column but `id` must be an index field: a client keeps the index in order by them. */
function checkIndexOrder(name: string, order: OrderBy, index: readonly string[], fail: Fail): void {
  const missing = order.map(([column]) => column).find((c) => c !== "id" && !index.includes(c));
  if (missing !== undefined) {
    fail(
      `collection "${name}": order column "${missing}" is not an index field; a client keeps the index in order by it`,
    );
  }
}

/**
 * The level a collection's subscribers need on its anchor row, which its
 * items are also stripped at: its `access`, `Read` by default. A `"self"`
 * scope is authorized by the subscriber's own user id, never by a level, so
 * its items are stripped at `Read` and it may not declare more: a higher
 * `access` would hand every subscriber that level's fields of the rows in
 * their own scope.
 */
function accessOf(
  name: string,
  def: CollectionDef,
  anchor: AnyContract | undefined,
  fail: Fail,
): AccessLevel {
  if (anchor !== undefined) {
    return def.access ?? "Read";
  }
  if (def.access !== undefined && meetsLevel(def.access, "Moderate")) {
    fail(
      `collection "${name}" has scopeAccess "self", which is authorized by the subscriber's user id and not by a level, so its access may not be above Read (it declares ${def.access})`,
    );
  }
  return "Read";
}

function scopeOf(def: CollectionDef): CollectionScope {
  const { scope } = def;
  if (typeof scope === "string") {
    return Object.freeze({ kind: "column", column: scope });
  }
  return Object.freeze({
    kind: "via",
    model: scope.model,
    entry: scope.entry,
    scope: scope.scope,
    refreshEntry: scope.refreshEntry === true,
  });
}

function compileOne(
  [name, def]: readonly [string, CollectionDef],
  contract: Pick<AnyContract, "fields">,
  projections: ReadonlyMap<string, Projection>,
  option: unknown,
  fail: Fail,
): ServiceCollection {
  if (option === undefined) {
    fail(
      `collection "${name}" needs its scope's access: collections: { ${name}: { anchor: contract } }, or { scopeAccess: "self" } for a scope that is the subscriber's user id`,
    );
  }
  const { anchor, bulkThreshold } = checkOption(`collections.${name}`, option, fail);
  const item = projections.get(def.item);
  if (item === undefined) {
    fail(`collection "${name}": item "${def.item}" is not a projection of the contract`);
  }
  const access = accessOf(name, def, anchor, fail);
  checkOrderTiers(name, def.order, contract.fields, access, fail);
  return Object.freeze({
    name,
    scope: scopeOf(def),
    item,
    where: Object.freeze({ ...def.where }),
    order: def.order,
    limit: def.limit ?? DEFAULT_COLLECTION_LIMIT,
    maxLimit: def.maxLimit ?? DEFAULT_COLLECTION_MAX_LIMIT,
    access,
    anchor,
    bulkThreshold,
    index: checkIndex(name, def, item, access, fail),
  });
}

/**
 * Compiles the contract's collections with the service's `collections`
 * option. Fails, through `fail`, for a collection without an entry, an entry
 * naming no collection, a malformed entry, and collections on a service
 * without a model.
 */
export function compileCollections(
  contract: AnyContract,
  projections: ReadonlyMap<string, Projection>,
  model: string | undefined,
  option: unknown,
  fail: Fail,
): ReadonlyMap<string, ServiceCollection> {
  if (option !== undefined && !isRecord(option)) {
    fail(
      'collections must map each collection of the contract to { anchor } or { scopeAccess: "self" }',
    );
  }
  const options = option ?? {};
  const unknownName = Object.keys(options).find(
    (name) => !Object.hasOwn(contract.collections, name),
  );
  if (unknownName !== undefined) {
    fail(`collections names "${unknownName}", which is not a collection of the contract`);
  }
  const declared = Object.entries(contract.collections);
  if (declared.length > 0 && model === undefined) {
    fail("collections need model: their items are rows of the service's model");
  }
  const compiled = new Map<string, ServiceCollection>();
  for (const [name, def] of declared) {
    compiled.set(name, compileOne([name, def], contract, projections, options[name], fail));
  }
  return compiled;
}
