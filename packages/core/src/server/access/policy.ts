// Access policies (RFC 0003 section 4.2): how a principal's level on a row of
// a service is found. A service declares one with `defineService(contract,
// { model, access })`, and every surface (method calls, list filters, and
// later subscriptions and collections) asks it the same two questions:
//
// - `levelsFor(principal, ids)`: the principal's level on each row, in one
//   batched lookup. A row that is not found, a malformed column or an
//   unknown level gives `null`: no access.
// - `accessWhere(principal, level)`: a filter matching exactly the rows on
//   which the principal has at least `level`, or `"none"`.
//
// The builders (`owner`, `jsonAcl`, `members`, `inherit`, `anyOf`,
// `resolver`, `everyone`) live in `policies/`. A policy reads the database only through
// the `PolicyTools` it is given, which batch, memoize per request and, when
// the dispatcher enables it, cache across requests; `reads` tells the engine
// which columns and models a policy depends on, so tracked writes to them
// evict the cache (`changes.ts`). It replaces 4.1's `checkAccess`,
// `checkEntryACL` and `checkBatchSubscriptionAccess`
// (`legacy-src/server/BaseService.ts:292-306, 513-547`).
//
// The framework never imports generated Prisma types. A policy's type
// carries the column names it reads, and `defineService` checks them against
// the app's database client structurally, through each model delegate's
// `fields` (`ModelColumn`); with a client that has no such members any name
// passes.

import type { AccessLevel } from "../../contract/access";
import type { AnyContract } from "../../contract/defineContract";
import type { StorageAdapter, StorageRow, StorageWhere } from "../storage";
import type { Principal } from "../types";

/** A principal's level on one row: an access level, or `null` for none. */
export type RowLevel = AccessLevel | null;

/** Levels by row id. An id missing from the map has no level. */
export type RowLevels = ReadonlyMap<string, RowLevel>;

/** A storage filter matching the rows a principal may see, or `"none"` when no row matches. */
export type AccessFilter = StorageWhere | "none";

/** A membership table a `members` policy reads: one row per user and entry. */
export interface MembershipRead {
  /** The membership model, named as the client names it: `"projectMember"`. */
  readonly model: string;
  /** The column holding the id of the row the membership is on: `"projectId"`. */
  readonly entry: string;
  /** The column holding the member's user id: `"userId"`. */
  readonly user: string;
  /** The column holding the member's role. */
  readonly level: string;
  /** Maps stored roles to access levels; without it a role must be a level name. */
  readonly levels: Readonly<Record<string, AccessLevel>> | undefined;
}

/** A parent row a policy takes its level from: `inherit({ from, via })`. */
export interface ParentLink {
  /** The parent service's contract. */
  readonly from: AnyContract;
  /** The column of the service's model holding the parent row's id. */
  readonly via: string;
}

/**
 * What a policy reads, so the engine can register interest in those columns
 * with the storage adapter (tracked writes then carry their `before` and
 * `after` values) and evict cached lookups when they are written.
 */
export interface PolicyReads {
  /** Columns of the service's own model. */
  readonly columns: readonly string[];
  /** Membership tables. */
  readonly memberships: readonly MembershipRead[];
  /** The services whose policies this one asks (`inherit`). */
  readonly inherits: readonly AnyContract[];
  /**
   * The parent rows a level comes from (`inherit`), with the column naming
   * each: the rows a live subscription's access is anchored on besides its
   * own (RFC 0003 section 4.4).
   */
  readonly parents?: readonly ParentLink[];
  /** Whether the policy reads the database through the storage adapter. */
  readonly storage: boolean;
}

/** What a policy reads the database with: batched, memoized per request, and cached when enabled. */
export interface PolicyTools {
  /** The dispatcher's storage adapter. */
  readonly storage: StorageAdapter;
  /** The database model of the service the policy guards, named as the client names it. */
  readonly model: string;
  /**
   * The service's rows `ids`, with the columns its policy reads (`reads.columns`),
   * in one query for every id not read yet in this request. `null` for a row
   * that does not exist.
   */
  rows(ids: readonly string[]): Promise<ReadonlyMap<string, StorageRow | null>>;
  /** The level each of `userId`'s memberships in `read` gives on the rows `ids`, in one query. */
  memberships(read: MembershipRead, userId: string, ids: readonly string[]): Promise<RowLevels>;
  /** The principal's level on rows of another service, from that service's policy. */
  levelsOf(contract: AnyContract, principal: Principal, ids: readonly string[]): Promise<RowLevels>;
  /** Another service's filter for the principal and `level`, from that service's policy. */
  whereOf(contract: AnyContract, principal: Principal, level: AccessLevel): Promise<AccessFilter>;
  /** The ids of the rows of another service the principal has at least `level` on. */
  idsWhere(
    contract: AnyContract,
    principal: Principal,
    level: AccessLevel,
  ): Promise<readonly string[]>;
}

/** The other models a policy reads, and their columns: `{ model: "projectMember", columns: "projectId" | "userId" | "role" }`. */
export interface ForeignColumns {
  readonly model: string;
  readonly columns: string;
}

/** The builder a policy came from. */
export type PolicyKind =
  | "owner"
  | "jsonAcl"
  | "members"
  | "inherit"
  | "anyOf"
  | "resolver"
  | "everyone";

/**
 * A service's access policy, from one of the builders. `Columns` names the
 * columns of the service's own model it reads and `Foreign` the other models
 * and columns; `defineService` checks both against the app's database client.
 */
export interface AccessPolicy<
  Columns extends string = string,
  Foreign extends ForeignColumns = ForeignColumns,
> {
  readonly kind: PolicyKind;
  /** The columns and models the policy depends on. */
  readonly reads: PolicyReads;
  /** The principal's level on each of `ids`, from one batched lookup. */
  levelsFor(principal: Principal, ids: readonly string[], tools: PolicyTools): Promise<RowLevels>;
  /** A filter matching exactly the rows on which the principal has at least `level`. */
  accessWhere(principal: Principal, level: AccessLevel, tools: PolicyTools): Promise<AccessFilter>;
  /** Type-only: the columns of the service's model this policy reads. Never set. */
  readonly "~columns"?: Columns;
  /** Type-only: the other models and columns this policy reads. Never set. */
  readonly "~foreign"?: Foreign;
}

/** Any access policy. */
export type AnyAccessPolicy = AccessPolicy<string, ForeignColumns>;

/** The own-model columns an access policy type reads. */
export type PolicyColumns<P> =
  P extends AccessPolicy<infer Columns, ForeignColumns> ? Columns : never;

/** The other models and columns an access policy type reads. */
export type PolicyForeign<P> = P extends AccessPolicy<string, infer Foreign> ? Foreign : never;

// ---------------------------------------------------------------------------
// The app's models, read structurally from its database client: a model
// delegate (`db.project`) lists its scalar fields in `fields`, as Prisma's
// generated client does. Nothing here names a Prisma type.
// ---------------------------------------------------------------------------

interface ModelDelegateLike {
  readonly fields: object;
  findMany(...args: never[]): unknown;
}

type DelegateNames<Db> = {
  [Name in keyof Db]-?: Db[Name] extends ModelDelegateLike ? Name : never;
}[keyof Db] &
  string;

/** The model names of the app's database client, or any string when the client lists none. */
export type ModelName<Db> = [DelegateNames<Db>] extends [never] ? string : DelegateNames<Db>;

type FieldsOf<Db, Model> = Model extends keyof Db
  ? Db[Model] extends { readonly fields: infer Fields }
    ? Fields
    : never
  : never;

/** The columns of `Model` in the app's database client, or any string when the client does not list them. */
export type ModelColumn<Db, Model extends string> = [FieldsOf<Db, Model>] extends [never]
  ? string
  : keyof FieldsOf<Db, Model> & string;

/** Every model of the app's database client with its columns: what a policy may read besides its own model. */
export type ForeignColumnsOf<Db> = [DelegateNames<Db>] extends [never]
  ? ForeignColumns
  : {
      [Name in DelegateNames<Db>]: {
        readonly model: Name;
        readonly columns: ModelColumn<Db, Name>;
      };
    }[DelegateNames<Db>];

/** The access policies a service of `Model` may declare, given the app's database client. */
export type PolicyFor<Db, Model> = Model extends string
  ? AccessPolicy<ModelColumn<Db, Model>, ForeignColumnsOf<Db>>
  : never;

// ---------------------------------------------------------------------------
// Run time: the builders brand what they return, so `defineService` can tell
// a policy from a look-alike object.
// ---------------------------------------------------------------------------

const POLICIES = new WeakSet<object>();

/** What a builder provides; `definePolicy` freezes and brands it. */
export type PolicySpec = Omit<AnyAccessPolicy, "~columns" | "~foreign"> & Record<string, unknown>;

/** Freezes and brands a policy made by one of the builders. */
export function definePolicy<P extends AnyAccessPolicy>(spec: PolicySpec): P {
  const policy = Object.freeze({ ...spec, reads: Object.freeze(spec.reads) });
  POLICIES.add(policy);
  return policy as unknown as P;
}

/** True when `value` is a policy from one of the builders (`owner`, `members`, ...). */
export function isAccessPolicy(value: unknown): value is AnyAccessPolicy {
  return typeof value === "object" && value !== null && POLICIES.has(value);
}

/** Throws a `TypeError` unless `value` is a non-empty string: a column or model name. */
export function checkName(builder: string, option: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(
      `${builder}: ${option} must be a ${option === "model" ? "model" : "column"} name`,
    );
  }
  return value;
}

/** A map holding the level `levelOf(id)` gives each of `ids`. */
export function levelsById(
  ids: readonly string[],
  levelOf: (id: string) => RowLevel,
): Map<string, RowLevel> {
  return new Map(ids.map((id) => [id, levelOf(id)]));
}

/** `{ id: { in: ids } }`, or `"none"` for no ids. */
export function idFilter(ids: readonly string[]): AccessFilter {
  return ids.length === 0 ? "none" : { id: { in: [...new Set(ids)] } };
}

/** The id list of a filter `idFilter` made, or `undefined` for any other filter. */
export function idsOfFilter(filter: StorageWhere): readonly string[] | undefined {
  const keys = Object.keys(filter);
  const { id } = filter;
  if (keys.length !== 1 || typeof id !== "object" || id === null) {
    return undefined;
  }
  const list: unknown = (id as Readonly<Record<string, unknown>>).in;
  const onlyIn = Object.keys(id).length === 1;
  return onlyIn && Array.isArray(list) && list.every((item) => typeof item === "string")
    ? (list as readonly string[])
    : undefined;
}
