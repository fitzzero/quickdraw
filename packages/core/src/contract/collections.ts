// Collection declarations for a contract (RFC 0003 section 7.1). A collection
// is the rows of one service grouped by a scope value. Membership is declared
// (a scope column or a junction table, plus an equality filter), never
// computed by a function, so the framework knows which writes can move a row.
// This replaces 4.1's `defineCollection({ resolveScopeId, checkScopeAccess,
// snapshot, toItem })`.

import type { AccessLevel } from "./access";

/** Page size of a collection snapshot when the collection sets no `limit`. */
export const DEFAULT_COLLECTION_LIMIT = 100;

/** Largest page a client may ask for when the collection sets no `maxLimit`. */
export const DEFAULT_COLLECTION_MAX_LIMIT = 500;

/**
 * A scope that comes from a junction table instead of a column on the row:
 * the rows of `model` link an entry (`entry` holds the row's id) to a scope
 * value (`scope`). For example, a chat appears in each member's list through
 * `via({ model: "chatMember", entry: "chatId", scope: "userId" })`.
 */
export interface ViaScope<
  Model extends string = string,
  Entry extends string = string,
  Scope extends string = string,
> {
  readonly kind: "via";
  readonly model: Model;
  readonly entry: Entry;
  readonly scope: Scope;
  /**
   * The item is computed from the junction (a member count): every junction
   * write sends its entry again, whole, to each scope that still holds it.
   * Without it a junction write only adds or removes the entry in the scope
   * it links, so a count over the junction goes stale everywhere else.
   */
  readonly refreshEntry?: boolean;
}

/** What `via(...)` takes: the junction model, its entry and scope columns, and `refreshEntry`. */
export interface ViaOptions<
  Model extends string = string,
  Entry extends string = string,
  Scope extends string = string,
> {
  /** The junction model, as the database client names it: `"chatMember"`. */
  readonly model: Model;
  /** The junction column holding the entry's id: `"chatId"`. */
  readonly entry: Entry;
  /** The junction column holding the scope value: `"userId"`. */
  readonly scope: Scope;
  /**
   * Set when the item reads the junction, as a `memberCount` mapped from a
   * relation count does: a junction create, update or delete then sends the
   * entry again, as `updated`, to every scope that still holds it (one read
   * of the entry's item per flush). Default `false`: a junction write adds
   * or removes the entry for the scope it links, and nothing else.
   */
  readonly refreshEntry?: boolean;
}

/**
 * Declares a collection scope that comes from a junction table.
 *
 * @example
 * myChats: {
 *   scope: via({ model: "chatMember", entry: "chatId", scope: "userId", refreshEntry: true }),
 *   item: "listItem",
 *   order: [["id", "asc"]],
 * }
 */
export function via<
  const Model extends string,
  const Entry extends string,
  const Scope extends string,
>(junction: ViaOptions<Model, Entry, Scope>): ViaScope<Model, Entry, Scope> {
  return Object.freeze({
    kind: "via",
    model: junction.model,
    entry: junction.entry,
    scope: junction.scope,
    ...(junction.refreshEntry === undefined ? {} : { refreshEntry: junction.refreshEntry }),
  });
}

export type SortDirection = "asc" | "desc";

/**
 * Sort columns for the keyset cursor, ending in `id` so every row has a
 * unique position: `[["ordinal", "asc"], ["id", "asc"]]`.
 */
export type OrderBy<Column extends string = string> = readonly [
  ...(readonly [Column, SortDirection])[],
  readonly ["id", SortDirection],
];

/** Who a view is evaluated for, on the client. */
export interface Viewer {
  readonly userId: string;
}

/**
 * A view: a named pure predicate evaluated on the client over the index rows
 * of a scope (RFC 0003 section 7.5). `row` holds only `id` and the
 * collection's `index` fields, which the type enforces.
 */
export type ViewPredicate<Row> = (row: Row, who: Viewer) => boolean;

/** The equality filter that decides membership, for example `{ archived: false }`. */
export interface CollectionWhere {
  readonly [column: string]: string | number | boolean | null;
}

/** Any collection of any contract, as `defineContract` stores it. */
export interface CollectionDef {
  /** A string column of the entity, or `via(...)` for a junction table. */
  readonly scope: string | ViaScope;
  /** The projection each item is sent as: `"entity"` or a named projection. */
  readonly item: string;
  /** Sort columns for the keyset cursor; the last one is `id`. */
  readonly order: OrderBy;
  /** Equality filter that decides membership. */
  readonly where?: CollectionWhere | undefined;
  /** Page size. Default {@link DEFAULT_COLLECTION_LIMIT}. */
  readonly limit?: number | undefined;
  /** Largest page a client may ask for. Default {@link DEFAULT_COLLECTION_MAX_LIMIT}. */
  readonly maxLimit?: number | undefined;
  /** Item fields sent for every member of the scope (RFC 0003 section 7.4). */
  readonly index?: readonly string[] | undefined;
  /** Named predicates over index rows. Requires `index`. */
  readonly views?: { readonly [view: string]: ViewPredicate<never> } | undefined;
  /** Level required on the scope's anchor row. Default `"Read"`, through the anchor's policy. */
  readonly access?: AccessLevel | undefined;
}
