// Collections as a service defines them (RFC 0003 section 7.1). The contract
// declares what a collection is: its scope column or junction, its item
// projection, its membership filter, its order and its page sizes. The
// service adds what a contract cannot carry, because access policies live on
// the server: the contract whose rows the scope values are ids of (`anchor`),
// or `scopeAccess: "self"` for a scope whose value is the subscriber's own
// user id; and the `bulkThreshold` past which one flush's changes to a scope
// go out as a single `reset`. Every collection of the contract needs one or
// the other, so a scope nobody could authorize fails when the service is
// defined rather than when a client subscribes.
//
// 4.1 defined a collection with functions (`resolveScopeId`,
// `checkScopeAccess`, `snapshot`, `toItem`;
// `legacy-src/server/collections.ts:36-72`), so the framework could not know
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

function scopeOf(def: CollectionDef): CollectionScope {
  const { scope } = def;
  if (typeof scope === "string") {
    return Object.freeze({ kind: "column", column: scope });
  }
  return Object.freeze({ kind: "via", model: scope.model, entry: scope.entry, scope: scope.scope });
}

function compileOne(
  name: string,
  def: CollectionDef,
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
  return Object.freeze({
    name,
    scope: scopeOf(def),
    item,
    where: Object.freeze({ ...def.where }),
    order: def.order,
    limit: def.limit ?? DEFAULT_COLLECTION_LIMIT,
    maxLimit: def.maxLimit ?? DEFAULT_COLLECTION_MAX_LIMIT,
    access: def.access ?? "Read",
    anchor,
    bulkThreshold,
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
    compiled.set(name, compileOne(name, def, projections, options[name], fail));
  }
  return compiled;
}
