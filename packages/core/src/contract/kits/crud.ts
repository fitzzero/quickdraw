// The read/write kit's contract half (RFC 0003 section 12.1). `crud.contract`
// returns ordinary `query` and `mutation` entries to spread into a contract's
// `methods`, one per method it names and no others:
//
//   export const task = defineContract("taskService", {
//     entity: taskSchema,
//     projections: { card: cardSchema },
//     methods: {
//       ...crud.contract({
//         entity: taskSchema,
//         get: true,
//         list: { item: cardSchema, filter: ["projectId", "status"], sort: ["ordinal"] },
//         update: { input: taskPatch },
//       }),
//       rename: mutation({ ... }),
//     },
//   });
//
// The server half (`crud.handlers` on `./server`) finds the kit's methods in
// the contract and implements exactly those: each entry carries what it
// needs (`crudSpecOf`), and its type carries which kit method it is
// (`CrudTag`), so the two halves cannot disagree. A client sees ordinary
// members. About 270 of the 579 methods in the seven smaller 4.1 apps are
// these shapes, each with its own paging and guards.

import type { RowSchema } from "../defineContract";
import {
  listOf,
  mutation,
  query,
  type MethodDef,
  type MutationDef,
  type ProjectionList,
  type QueryDef,
} from "../methods";
import { isStandardSchema, type InferOutput, type StandardSchemaV1 } from "../standardSchema";
import { listInput, pageOutput, type ListPage, type ListQuery, type ListSort } from "./crudList";
import {
  bulkPatch,
  countOutput,
  CRUD_MAX_IDS,
  idInput,
  idsInput,
  nullOutput,
  reorderInput,
  withId,
  type BulkPatch,
  type BulkResult,
  type IdInput,
  type IdsInput,
  type ReorderInput,
  type WithId,
} from "./crudSchemas";
import type { KitSchema } from "./schemas";

/** The methods the read/write kit can add, each opt-in by name. */
export type CrudMethodName =
  | "get"
  | "getMany"
  | "list"
  | "create"
  | "update"
  | "delete"
  | "reorder"
  | "bulkUpdate"
  | "bulkDelete";

/** Every method of the read/write kit, in the order of RFC 0003 section 12.1. */
export const CRUD_METHODS: readonly CrudMethodName[] = Object.freeze([
  "get",
  "getMany",
  "list",
  "create",
  "update",
  "delete",
  "reorder",
  "bulkUpdate",
  "bulkDelete",
]);

/** Type-only: marks a method the read/write kit made, and which one. Never set. */
export interface CrudTag<Kind extends CrudMethodName> {
  readonly "~crud"?: Kind;
}

type RowOf<Entity> = Entity extends StandardSchemaV1 ? InferOutput<Entity> : never;

/** The entity's fields holding strings, numbers or booleans: what `list` filters and sorts on. */
export type ScalarFieldOf<Row> = {
  [Field in keyof Row]-?: NonNullable<Row[Field]> extends string | number | boolean ? Field : never;
}[keyof Row] &
  string;

/** The entity's fields holding numbers: a `reorder` column. */
export type NumberFieldOf<Row> = {
  [Field in keyof Row]-?: NonNullable<Row[Field]> extends number ? Field : never;
}[keyof Row] &
  string;

interface Described {
  /** The method's description, for people and agents; the kit's own when absent. */
  readonly describe?: string;
}

/** Turns a method without options on: `true`, or `{ describe }`. */
export type CrudToggle = boolean | Described;

/** `list`'s options. */
export interface CrudListOptions<Field extends string = string> extends Described {
  /**
   * The schema of each item: the contract's entity schema (the default) or
   * one of its projections' schemas, the same object.
   */
  readonly item?: RowSchema;
  /** The fields a caller may filter on, by equality. */
  readonly filter?: readonly Field[];
  /** The fields a caller may sort by; the first is the default order. */
  readonly sort?: readonly Field[];
}

/** `create`'s, `update`'s and `bulkUpdate`'s options: the app's schema of the fields written. */
export interface CrudInputOptions extends Described {
  /**
   * `create`: the new row's fields. `update` and `bulkUpdate`: the fields a
   * call may change, every one optional (`z.object({...}).partial()`); the
   * kit adds `id`, or `ids`.
   */
  readonly input: StandardSchemaV1;
}

/** `reorder`'s options. */
export interface CrudReorderOptions<
  Column extends string = string,
  Scope extends string = string,
> extends Described {
  /** The numeric column rows are ordered by, ascending. */
  readonly column: Column;
  /** The columns whose values make one ordered list (`"projectId"`); the whole table when absent. */
  readonly within?: Scope | readonly Scope[];
}

/** `crud.contract`'s options: the entity, and each method to add. */
export interface CrudContractOptions {
  /** The contract's entity schema: the fields `list` and `reorder` name are its fields. */
  readonly entity: RowSchema;
  readonly get?: CrudToggle;
  readonly getMany?: CrudToggle;
  readonly list?: CrudListOptions;
  readonly create?: CrudInputOptions;
  readonly update?: CrudInputOptions;
  readonly delete?: CrudToggle;
  readonly reorder?: CrudReorderOptions;
  readonly bulkUpdate?: CrudInputOptions;
  readonly bulkDelete?: CrudToggle;
}

type Quoted<Names> = `"${Names & string}"`;

type NamesIn<Value> = Value extends string
  ? Value
  : Value extends readonly (infer Name)[]
    ? Name
    : never;

type OptionNames<O, Option extends string, Key extends string> = O extends {
  readonly [K in Option]: { readonly [P in Key]: infer Value };
}
  ? NamesIn<Value>
  : never;

/** A broken option becomes a message: replacing the whole option keeps TypeScript from printing `never`. */
type Problem<Option extends string, Wrong, Text extends string> = [Wrong] extends [never]
  ? unknown
  : { readonly [K in Option]: `crud.contract: ${Option}: ${Quoted<Wrong>} ${Text}` };

/** The checks against the entity's fields that the option types alone cannot state. */
type CrudChecks<O> = O extends { readonly entity: infer Entity }
  ? Problem<
      "list",
      Exclude<
        OptionNames<O, "list", "filter"> | OptionNames<O, "list", "sort">,
        ScalarFieldOf<RowOf<Entity>>
      >,
      "is not a field of the entity holding strings, numbers or booleans"
    > &
      Problem<
        "reorder",
        Exclude<OptionNames<O, "reorder", "column">, NumberFieldOf<RowOf<Entity>>>,
        "is not a field of the entity holding numbers"
      > &
      Problem<
        "reorder",
        Exclude<OptionNames<O, "reorder", "within">, ScalarFieldOf<RowOf<Entity>>>,
        "is not a field of the entity holding strings, numbers or booleans"
      >
  : unknown;

/** What a `list` call passes: a filter and a sort over the declared fields, and paging. */
export type ListInput<Row, Filter extends string, Sort extends string> = {
  readonly filter?: [Filter] extends [never]
    ? undefined
    : { readonly [Field in Filter]?: Field extends keyof Row ? Row[Field] : never };
  readonly sort?: [Sort] extends [never] ? undefined : ListSort<Sort>;
  /** The `nextCursor` of the page before; the first page when absent. */
  readonly cursor?: string;
  /** The page size: default 50, at most 200 (a larger one is clamped). */
  readonly limit?: number;
  /** Also count every matching row (a second statement). */
  readonly totalCount?: boolean;
};

export type CrudGet = QueryDef<KitSchema<IdInput>, "entity"> & CrudTag<"get">;
export type CrudGetMany = QueryDef<
  KitSchema<IdsInput, { readonly ids: string[] }>,
  ProjectionList<"entity">
> &
  CrudTag<"getMany">;
export type CrudList<Row, Item, Filter extends string, Sort extends string> = QueryDef<
  KitSchema<ListInput<Row, Filter, Sort> | undefined, ListQuery<Filter, Sort>>,
  KitSchema<ListPage<Item>>
> &
  CrudTag<"list">;
export type CrudCreate<Input extends StandardSchemaV1> = MutationDef<Input, "entity"> &
  CrudTag<"create">;
export type CrudUpdate<Patch extends StandardSchemaV1> = MutationDef<WithId<Patch>, "entity"> &
  CrudTag<"update">;
export type CrudDelete = MutationDef<KitSchema<IdInput>, KitSchema<null>> & CrudTag<"delete">;
export type CrudReorder = MutationDef<KitSchema<ReorderInput>, "entity"> & CrudTag<"reorder">;
export type CrudBulkUpdate<Patch extends StandardSchemaV1> = MutationDef<
  BulkPatch<Patch>,
  KitSchema<BulkResult>
> &
  CrudTag<"bulkUpdate">;
export type CrudBulkDelete = MutationDef<
  KitSchema<IdsInput, { readonly ids: string[] }>,
  KitSchema<BulkResult>
> &
  CrudTag<"bulkDelete">;

type EntityIn<O> = O extends { readonly entity: infer Entity } ? Entity : never;

type ListFieldsIn<O, Key extends "filter" | "sort"> = O extends {
  readonly list: { readonly [K in Key]: readonly (infer Field extends string)[] };
}
  ? Field
  : never;

type ListItemIn<O> = O extends { readonly list: { readonly item: infer Item } }
  ? RowOf<Item>
  : RowOf<EntityIn<O>>;

type InputIn<O, Name extends "create" | "update" | "bulkUpdate"> = O extends {
  readonly [K in Name]: { readonly input: infer Input extends StandardSchemaV1 };
}
  ? Input
  : never;

type CrudMethodOf<O, Name extends CrudMethodName> = {
  get: CrudGet;
  getMany: CrudGetMany;
  list: CrudList<
    RowOf<EntityIn<O>>,
    ListItemIn<O>,
    ListFieldsIn<O, "filter">,
    ListFieldsIn<O, "sort">
  >;
  create: CrudCreate<InputIn<O, "create">>;
  update: CrudUpdate<InputIn<O, "update">>;
  delete: CrudDelete;
  reorder: CrudReorder;
  bulkUpdate: CrudBulkUpdate<InputIn<O, "bulkUpdate">>;
  bulkDelete: CrudBulkDelete;
}[Name];

type Enabled<O, Name extends CrudMethodName> = Name extends keyof O
  ? [O[Name]] extends [false | undefined]
    ? never
    : Name
  : never;

/** The entries `crud.contract(options)` returns: one per method the options turn on. */
export type CrudMethods<O> = {
  readonly [Name in CrudMethodName as Enabled<O, Name>]: CrudMethodOf<O, Name>;
};

/** What the server half needs to know about one of the kit's methods. */
export type CrudSpec =
  | { readonly method: Exclude<CrudMethodName, "list" | "reorder"> }
  | {
      readonly method: "list";
      readonly filter: readonly string[];
      readonly sort: readonly string[];
      /** The item's schema; `undefined` for the entity. */
      readonly item: RowSchema | undefined;
    }
  | { readonly method: "reorder"; readonly column: string; readonly within: readonly string[] };

const SPECS = new WeakMap<object, CrudSpec>();

/** What the read/write kit made `method` for, or `undefined` for any other method. */
export function crudSpecOf(method: unknown): CrudSpec | undefined {
  return typeof method === "object" && method !== null ? SPECS.get(method) : undefined;
}

const DESCRIBE: Readonly<Record<CrudMethodName, string>> = Object.freeze({
  get: "Reads one row by id.",
  getMany: `Reads up to ${CRUD_MAX_IDS} rows by id, in the order asked; ids the caller cannot read, or with no row, are left out.`,
  list: "Lists the rows the caller can read, a page at a time, filtered and sorted by the declared fields. Pass a page's nextCursor back as cursor for the next page.",
  create: "Creates a row.",
  update: "Changes the given fields of one row.",
  delete: "Deletes one row.",
  reorder:
    "Moves a row between two others: beforeId is the row that will come right before it, afterId the row right after; one is enough.",
  bulkUpdate: `Changes the same fields on up to ${CRUD_MAX_IDS} rows, skipping rows the caller cannot change; returns how many changed.`,
  bulkDelete: `Deletes up to ${CRUD_MAX_IDS} rows, skipping rows the caller cannot delete; returns how many were deleted.`,
});

type UnknownRecord = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new TypeError(`crud.contract: ${message}`);
}

function checkKeys(owner: string, value: UnknownRecord, allowed: readonly string[]): void {
  const unknownKey = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknownKey !== undefined) {
    fail(`${owner} has an unknown option "${unknownKey}"; the options are ${allowed.join(", ")}`);
  }
}

/** The method's description: its own `describe`, or the kit's. */
function describeOf(name: CrudMethodName, option: unknown): string {
  const own = isRecord(option) ? option.describe : undefined;
  if (own !== undefined && (typeof own !== "string" || own.length === 0)) {
    fail(`${name}: describe must be a non-empty string`);
  }
  return own ?? DESCRIBE[name];
}

function checkToggle(name: CrudMethodName, option: unknown): void {
  if (typeof option !== "boolean" && !isRecord(option)) {
    fail(`${name} must be true, false or { describe }`);
  }
  if (isRecord(option)) {
    checkKeys(name, option, ["describe"]);
  }
}

function checkFields(owner: string, fields: unknown): readonly string[] {
  if (fields === undefined) {
    return [];
  }
  const valid =
    Array.isArray(fields) &&
    fields.every((field) => typeof field === "string" && field.length > 0) &&
    new Set(fields).size === fields.length;
  if (!valid) {
    fail(`${owner} must be a list of distinct field names`);
  }
  return Object.freeze([...(fields as string[])]);
}

function listSpec(option: unknown): CrudSpec {
  if (!isRecord(option)) {
    fail("list must be { item?, filter?, sort?, describe? }");
  }
  checkKeys("list", option, ["item", "filter", "sort", "describe"]);
  if (option.item !== undefined && !isStandardSchema(option.item)) {
    fail("list.item must be the entity schema or one of the contract's projection schemas");
  }
  return {
    method: "list",
    filter: checkFields("list.filter", option.filter),
    sort: checkFields("list.sort", option.sort),
    item: option.item as RowSchema | undefined,
  };
}

function inputOf(name: CrudMethodName, option: unknown): StandardSchemaV1 {
  if (!isRecord(option) || !isStandardSchema(option.input)) {
    fail(`${name} must be { input: <Standard Schema>, describe? }`);
  }
  checkKeys(name, option, ["input", "describe"]);
  return option.input;
}

function reorderSpec(option: unknown): CrudSpec {
  if (!isRecord(option) || typeof option.column !== "string" || option.column.length === 0) {
    fail("reorder must be { column, within?, describe? } with the name of a numeric column");
  }
  checkKeys("reorder", option, ["column", "within", "describe"]);
  const { column } = option;
  const within = checkFields(
    "reorder.within",
    typeof option.within === "string" ? [option.within] : option.within,
  );
  if (column === "id" || within.includes(column)) {
    fail("reorder.column must be a numeric column other than id and the within columns");
  }
  return { method: "reorder", column, within };
}

/** One method of the kit: its entry, and what the server half needs to know about it. */
function build(
  name: CrudMethodName,
  options: UnknownRecord,
  entity: StandardSchemaV1,
): { def: MethodDef; spec: CrudSpec } {
  const option = options[name];
  const describe = describeOf(name, option);
  switch (name) {
    case "list": {
      const spec = listSpec(option) as Extract<CrudSpec, { method: "list" }>;
      const input = listInput(spec, entity);
      return { def: query({ input, output: pageOutput(spec.item ?? entity), describe }), spec };
    }
    case "create":
      return {
        def: mutation({ input: inputOf(name, option), output: "entity", describe }),
        spec: { method: name },
      };
    case "update":
      return {
        def: mutation({ input: withId(inputOf(name, option)), output: "entity", describe }),
        spec: { method: name },
      };
    case "bulkUpdate":
      return {
        def: mutation({ input: bulkPatch(inputOf(name, option)), output: countOutput(), describe }),
        spec: { method: name },
      };
    case "reorder":
      return {
        def: mutation({ input: reorderInput(), output: "entity", describe }),
        spec: reorderSpec(option),
      };
    default:
      checkToggle(name, option);
      return { def: toggled(name, describe), spec: { method: name } };
  }
}

/** The entry of a method without options. */
function toggled(name: CrudMethodName, describe: string): MethodDef {
  switch (name) {
    case "get":
      return query({ input: idInput(), output: "entity", describe });
    case "getMany":
      return query({ input: idsInput(), output: listOf("entity"), describe });
    case "delete":
      return mutation({ input: idInput(), output: nullOutput(), describe });
    default:
      return mutation({ input: idsInput(), output: countOutput(), describe });
  }
}

function checkOptions(options: unknown): UnknownRecord {
  if (!isRecord(options)) {
    fail("options must be { entity, ...methods }");
  }
  checkKeys("the options", options, ["entity", ...CRUD_METHODS]);
  if (!isStandardSchema(options.entity)) {
    fail("entity must be the contract's entity schema");
  }
  return options;
}

function contract<const O extends CrudContractOptions>(
  options: O & NoInfer<CrudChecks<O>>,
): CrudMethods<O> {
  const checked = checkOptions(options);
  const entity = checked.entity as StandardSchemaV1;
  const methods: Record<string, MethodDef> = {};
  for (const name of CRUD_METHODS) {
    const option = checked[name];
    if (option === undefined || option === false) {
      continue;
    }
    const { def, spec } = build(name, checked, entity);
    SPECS.set(def, Object.freeze(spec));
    methods[name] = def;
  }
  return Object.freeze(methods) as unknown as CrudMethods<O>;
}

/**
 * The read/write kit's contract half: `crud.contract(options)`. Each method is
 * opt-in by name (`get: true`, `list: { filter, sort }`, `update: { input }`),
 * and the server half (`crud.handlers` on `./server`) implements exactly the
 * methods named.
 */
export const crud = Object.freeze({ contract });
