// `resolver({ levelsFor, where?, reads? })` (RFC 0003 section 4.2): a policy
// written in app code, for access rules the other builders cannot state.
//
// `reads` (finding R1.1 of the 5.0.0 review) says what its levels depend on,
// in the terms the other builders use (`PolicyReads`): columns of the
// service's own model, as `owner` and `jsonAcl` read theirs, and membership
// tables, as `members` reads its table. The engine then treats them as it
// treats theirs: tracked writes to them evict cached lookups and report the
// access changes that re-check live rows, collection scopes and change
// topics (`../changes.ts`). Without `reads` nothing a write does re-checks a
// resolver, so a user removed from a table it reads keeps the rows it let
// them subscribe to; `reads: "none"` says its levels depend on nothing a
// tracked write changes (only the principal's grants, say), and a resolver
// with neither raises the `resolver-without-reads` development warning
// (`../resolverReads.ts`).

import { isAccessLevel, type AccessLevel } from "../../../contract/access";
import type { MaybePromise, Principal } from "../../types";
import {
  definePolicy,
  levelsById,
  type AccessFilter,
  type AccessPolicy,
  type AnyAccessPolicy,
  type MembershipRead,
  type PolicyReads,
  type PolicyTools,
  type RowLevel,
} from "../policy";
import { membershipRead, type MembersOptions } from "./members";

/** A membership table a resolver's levels depend on: `{ model, entry, user, level, levels? }`, as `members` takes it. */
export type ResolverMembership = MembersOptions;

/** What a resolver's levels depend on: `resolver({ reads })`. Name at least one column or table. */
export interface ResolverReads<
  Column extends string = string,
  Membership extends ResolverMembership = ResolverMembership,
> {
  /**
   * Columns of the service's own model. A tracked write that sets one (or
   * creates or deletes a row) re-checks that row, for every user. `tools.rows`
   * reads them.
   */
  readonly columns?: readonly Column[];
  /**
   * Membership tables, one row per user and row of this service: `entry`
   * holds the id of this service's row, as for `members`. A tracked write to
   * one re-checks that user on that row.
   */
  readonly memberships?: readonly Membership[];
}

/** Options of {@link resolver}. */
export interface ResolverOptions<
  P extends Principal = Principal,
  Column extends string = string,
  Membership extends ResolverMembership = ResolverMembership,
> {
  /**
   * The principal's level on each of `ids`, as a map or a record by id. An id
   * left out, or given anything but an access level, has no level. Read
   * everything for one call in one query: `ids` holds every row the call asks
   * about. Results are memoized for the request, never kept across requests.
   */
  readonly levelsFor: (
    principal: P,
    ids: readonly string[],
    tools: PolicyTools,
  ) => MaybePromise<ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>>;
  /**
   * A filter matching exactly the rows on which the principal has at least
   * `level`, or `"none"`. Without it, list filters through this policy match
   * no row.
   */
  readonly where?: (
    principal: P,
    level: AccessLevel,
    tools: PolicyTools,
  ) => MaybePromise<AccessFilter>;
  /**
   * What the levels depend on, so tracked writes re-check what they
   * decided: live rows, collection scopes and change topics.
   * `{ columns, memberships }` names the service's columns and the membership
   * tables `levelsFor` and `where` read; `"none"` says nothing a tracked
   * write changes can change a level (the levels come from the principal's
   * grants alone, say). Without it nothing a write does re-checks this
   * policy, and the server says so in development (`resolver-without-reads`).
   */
  readonly reads?: ResolverReads<Column, Membership> | "none";
}

/** The other models and columns the membership tables `M` read: what `defineService` checks. */
export type MembershipColumns<M> = M extends {
  readonly model: infer Model extends string;
  readonly entry: infer Entry extends string;
  readonly user: infer User extends string;
  readonly level: infer Level extends string;
}
  ? { readonly model: Model; readonly columns: Entry | User | Level }
  : never;

const UNDECLARED = new WeakSet<object>();

/** True for a policy `resolver` made without `reads`: nothing a tracked write does re-checks it. */
export function declaresNoReads(policy: AnyAccessPolicy): boolean {
  return UNDECLARED.has(policy);
}

/** What a resolver with `reads: "none"`, or none at all, declares. */
function noReads(): PolicyReads {
  return { columns: [], memberships: [], inherits: [], storage: false };
}

const READ_KEYS: readonly string[] = ["columns", "memberships"];

function readsProblem(message: string): never {
  throw new TypeError(`resolver({ reads }): ${message}`);
}

function checkColumns(columns: unknown): readonly string[] {
  if (columns === undefined) {
    return [];
  }
  const valid =
    Array.isArray(columns) &&
    columns.every((column) => typeof column === "string" && column.length > 0);
  return valid
    ? Object.freeze([...new Set(columns as string[])])
    : readsProblem("columns must be a list of column names");
}

function checkMemberships(memberships: unknown): readonly MembershipRead[] {
  if (memberships === undefined) {
    return [];
  }
  const valid =
    Array.isArray(memberships) &&
    memberships.every((each) => typeof each === "object" && each !== null && !Array.isArray(each));
  if (!valid) {
    readsProblem("memberships must be a list of { model, entry, user, level, levels? }");
  }
  return Object.freeze(
    (memberships as object[]).map((each) =>
      membershipRead(each, () => "resolver({ reads: { memberships } })"),
    ),
  );
}

/**
 * The policy reads `reads` declares, or `undefined` when it declares none.
 * Declared columns and tables make the policy one that reads the database
 * (`storage`): `createDispatcher` then refuses to serve it without a storage
 * adapter, which is where the tables and columns are registered so tracked
 * writes carry their values (`../bindings.ts`; a deleted membership row
 * still says whose it was), and where `tools.rows` reads the columns.
 */
function checkReads(reads: unknown): PolicyReads | undefined {
  if (reads === undefined) {
    return undefined;
  }
  if (reads === "none") {
    return noReads();
  }
  if (typeof reads !== "object" || reads === null || Array.isArray(reads)) {
    readsProblem('reads must be { columns?, memberships? } or "none"');
  }
  const given = reads as Readonly<Record<string, unknown>>;
  const unknownKey = Object.keys(given).find((key) => !READ_KEYS.includes(key));
  if (unknownKey !== undefined) {
    readsProblem(`reads has an unknown key "${unknownKey}"; the keys are columns and memberships`);
  }
  const columns = checkColumns(given.columns);
  const memberships = checkMemberships(given.memberships);
  if (columns.length === 0 && memberships.length === 0) {
    readsProblem('name a column or a membership table, or pass "none"');
  }
  return { columns, memberships, inherits: [], storage: true };
}

function levelIn(
  levels: ReadonlyMap<string, unknown> | Readonly<Record<string, unknown>>,
  id: string,
): RowLevel {
  let level: unknown;
  if (levels instanceof Map) {
    level = levels.get(id);
  } else if (Object.hasOwn(levels, id)) {
    level = (levels as Readonly<Record<string, unknown>>)[id];
  }
  return isAccessLevel(level) ? level : null;
}

/**
 * A policy written in app code: `levelsFor` answers the level per row and
 * `where` the list filter. A resolver's own results are memoized for the
 * request and never cached across requests; what it reads through `tools`
 * is: `tools.rows(ids)` reads `id` and the declared columns in one query,
 * and `tools.memberships(table, userId, ids)` a member's levels, both kept
 * with `cacheMs` and evicted by tracked writes when `reads` declares them.
 *
 * `reads` declares what the levels depend on, so a tracked write to it
 * re-checks the live rows, collection scopes and change topics the policy
 * authorized, as for the other builders: a user removed from a membership
 * table stops receiving the rows it gave them. `defineService` checks the
 * declared columns and tables against the app's database client.
 *
 * @example
 * access: resolver({
 *   levelsFor: (principal, ids, tools) => levelsFromMyTables(principal.userId, ids, tools),
 *   where: (principal) => ({ visibility: "public" }),
 *   reads: {
 *     columns: ["visibility"],
 *     memberships: [{ model: "teamMember", entry: "projectId", user: "userId", level: "role" }],
 *   },
 * }),
 */
export function resolver<
  P extends Principal = Principal,
  const Column extends string = never,
  const Membership extends ResolverMembership = never,
>(
  options: ResolverOptions<P, Column, Membership>,
): AccessPolicy<Column, MembershipColumns<Membership>> {
  const valid =
    typeof options === "object" &&
    options !== null &&
    typeof options.levelsFor === "function" &&
    (options.where === undefined || typeof options.where === "function");
  if (!valid) {
    throw new TypeError(
      "resolver({ levelsFor, where?, reads? }): levelsFor and where must be functions",
    );
  }
  const { levelsFor, where } = options;
  const reads = checkReads(options.reads);
  const policy = definePolicy<AccessPolicy<Column, MembershipColumns<Membership>>>({
    kind: "resolver",
    reads: reads ?? noReads(),
    async levelsFor(principal, ids, tools) {
      const levels = await levelsFor(principal as P, ids, tools);
      if (typeof levels !== "object" || levels === null) {
        return levelsById(ids, () => null);
      }
      return levelsById(ids, (id) => levelIn(levels, id));
    },
    async accessWhere(principal, level, tools) {
      if (where === undefined) {
        return "none";
      }
      const filter: unknown = await where(principal as P, level, tools);
      const isFilter = typeof filter === "object" && filter !== null && !Array.isArray(filter);
      return isFilter ? (filter as AccessFilter) : "none";
    },
  });
  if (reads === undefined) {
    UNDECLARED.add(policy);
  }
  return policy;
}
