// The search kit's contract half (RFC 0003 section 12.2). `search.contract`
// returns one ordinary `query` entry, `search`, to spread into a contract's
// `methods`:
//
//   export const task = defineContract("taskService", {
//     entity: taskSchema,
//     projections: { card: cardSchema },
//     methods: {
//       ...search.contract({ entity: taskSchema, item: cardSchema, fields: ["title"], scope: "byProject" }),
//     },
//     collections: { byProject: { scope: "projectId", item: "card", order: [...] } },
//   });
//
// `fields` are the entity's text fields a search looks in: an explicit list,
// because an unbounded "contains" over every column is slow. `scope` names a
// collection of the contract: a call may then pass one of its scopes, and
// the search keeps to that scope's members, in the collection's order, its
// results the collection's items (so a client keeps them live through the
// collection's cache). The server half (`search.handlers` on `./server`)
// finds the entry in the contract by what it was made for (`searchSpecOf`);
// its type carries that too (`SearchTag`), and the client adds `useSearch`
// to its member.

import type { RowSchema } from "../defineContract";
import { query, type QueryDef } from "../methods";
import { isStandardSchema, type InferOutput, type StandardSchemaV1 } from "../standardSchema";
import type { KitSchema } from "./schemas";
import {
  SEARCH_DEFAULT_MIN_LENGTH,
  SEARCH_MAX_QUERY_LENGTH,
  searchInput,
  searchPageOutput,
  type SearchInput,
  type SearchPage,
  type SearchQuery,
} from "./searchSchemas";

/** Type-only: marks a method the search kit made. Never set. */
export interface SearchTag {
  readonly "~search"?: true;
}

type RowOf<Entity> = Entity extends StandardSchemaV1 ? InferOutput<Entity> : never;

/** The entity's fields holding strings: what a search may look in. */
export type TextFieldOf<Row> = {
  [Field in keyof Row]-?: NonNullable<Row[Field]> extends string ? Field : never;
}[keyof Row] &
  string;

/** `search.contract`'s options. */
export interface SearchContractOptions {
  /** The contract's entity schema: `fields` are its fields. */
  readonly entity: RowSchema;
  /** The text fields a search looks in (at least one). */
  readonly fields: readonly string[];
  /**
   * The schema of each result: the contract's entity schema (the default) or
   * one of its projections' schemas, the same object. With `scope`, the
   * scope collection's item.
   */
  readonly item?: RowSchema;
  /** A collection of the contract: a call may pass one of its scopes, and the search keeps to it. */
  readonly scope?: string;
  /** How long a query must be once trimmed; a shorter one finds nothing. Default 2. */
  readonly minLength?: number;
  /** The method's description, for people and agents; the kit's own when absent. */
  readonly describe?: string;
}

type Quoted<Names> = `"${Names & string}"`;

type FieldsIn<O> = O extends { readonly fields: readonly (infer Field extends string)[] }
  ? Field
  : never;

/** The check of `fields` against the entity that the option types alone cannot state. */
type SearchChecks<O> = O extends { readonly entity: infer Entity }
  ? [Exclude<FieldsIn<O>, TextFieldOf<RowOf<Entity>>>] extends [never]
    ? unknown
    : {
        readonly fields: `search.contract: fields: ${Quoted<
          Exclude<FieldsIn<O>, TextFieldOf<RowOf<Entity>>>
        >} is not a field of the entity holding strings`;
      }
  : unknown;

/** The entry `search.contract` makes: a query of a page of `Item`s. */
export type SearchDef<Item, Scoped extends boolean = false> = QueryDef<
  KitSchema<SearchInput<Scoped>, SearchQuery>,
  KitSchema<SearchPage<Item>>
> &
  SearchTag;

type ItemIn<O> = O extends { readonly item: infer Item }
  ? RowOf<Item>
  : O extends { readonly entity: infer Entity }
    ? RowOf<Entity>
    : never;

type ScopedIn<O> = O extends { readonly scope: string } ? true : false;

/** What `search.contract(options)` returns: one entry, `search`. */
export interface SearchMethods<O> {
  readonly search: SearchDef<ItemIn<O>, ScopedIn<O>>;
}

/** What the server half and the client need to know about a method the search kit made. */
export interface SearchSpec {
  readonly fields: readonly string[];
  /** The item's schema; `undefined` for the entity. */
  readonly item: RowSchema | undefined;
  /** The collection whose scopes a call may keep to. */
  readonly scope: string | undefined;
  readonly minLength: number;
}

const SPECS = new WeakMap<object, SearchSpec>();

/** What the search kit made `method` for, or `undefined` for any other method. */
export function searchSpecOf(method: unknown): SearchSpec | undefined {
  return typeof method === "object" && method !== null ? SPECS.get(method) : undefined;
}

type UnknownRecord = Readonly<Record<string, unknown>>;

const OPTIONS = ["entity", "fields", "item", "scope", "minLength", "describe"];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new TypeError(`search.contract: ${message}`);
}

function checkFields(fields: unknown): readonly string[] {
  const valid =
    Array.isArray(fields) &&
    fields.length > 0 &&
    fields.every((field) => typeof field === "string" && field.length > 0) &&
    new Set(fields).size === fields.length;
  if (!valid) {
    fail("fields must be a list of the distinct text fields to search, at least one");
  }
  return Object.freeze([...(fields as string[])]);
}

function checkMinLength(minLength: unknown): number {
  if (minLength === undefined) {
    return SEARCH_DEFAULT_MIN_LENGTH;
  }
  const valid =
    typeof minLength === "number" &&
    Number.isInteger(minLength) &&
    minLength >= 1 &&
    minLength <= SEARCH_MAX_QUERY_LENGTH;
  if (!valid) {
    fail(`minLength must be a whole number from 1 to ${SEARCH_MAX_QUERY_LENGTH}`);
  }
  return minLength;
}

/** The options, checked: what the server half and the client read. */
function specOf(options: unknown): SearchSpec {
  if (!isRecord(options)) {
    fail("options must be { entity, fields, item?, scope?, minLength?, describe? }");
  }
  const unknownKey = Object.keys(options).find((key) => !OPTIONS.includes(key));
  if (unknownKey !== undefined) {
    fail(`unknown option "${unknownKey}"; the options are ${OPTIONS.join(", ")}`);
  }
  if (!isStandardSchema(options.entity)) {
    fail("entity must be the contract's entity schema");
  }
  if (options.item !== undefined && !isStandardSchema(options.item)) {
    fail("item must be the entity schema or one of the contract's projection schemas");
  }
  const { scope } = options;
  if (scope !== undefined && (typeof scope !== "string" || scope.length === 0)) {
    fail("scope must name a collection of the contract");
  }
  return {
    fields: checkFields(options.fields),
    item: options.item as RowSchema | undefined,
    scope: scope as string | undefined,
    minLength: checkMinLength(options.minLength),
  };
}

/** The method's description: its own `describe`, or the kit's. */
function describeOf(options: UnknownRecord, spec: SearchSpec): string {
  const own = options.describe;
  if (own !== undefined && (typeof own !== "string" || own.length === 0)) {
    fail("describe must be a non-empty string");
  }
  const scoped =
    spec.scope === undefined
      ? ""
      : ` Pass scope (one scope of ${spec.scope}) to search only its members.`;
  return (
    own ??
    `Searches the rows the caller can read for the text q (at least ${spec.minLength} characters), a page at a time.${scoped} Pass a page's nextCursor back as cursor for the next page.`
  );
}

function contract<const O extends SearchContractOptions>(
  options: O & NoInfer<SearchChecks<O>>,
): SearchMethods<O> {
  const spec = specOf(options);
  const entity = options.entity as StandardSchemaV1;
  const def = query({
    input: searchInput(spec.scope !== undefined),
    output: searchPageOutput(spec.item ?? entity),
    describe: describeOf(options as unknown as UnknownRecord, spec),
  });
  SPECS.set(def, Object.freeze(spec));
  return Object.freeze({ search: def }) as unknown as SearchMethods<O>;
}

/**
 * The search kit's contract half: `search.contract({ entity, fields, item?,
 * scope?, minLength? })` makes the `search` query, which the server half
 * (`search.handlers` on `./server`) implements.
 */
export const search = Object.freeze({ contract });
