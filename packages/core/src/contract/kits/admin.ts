// The admin kit's contract half (RFC 0003 section 12.4). `admin.contract`
// returns ordinary `query` and `mutation` entries to spread into a
// contract's `methods`: the back-office methods 4.1's `installAdminMethods`
// registered outside the type map (4.1 `src/server/BaseService.ts:1185-1333`),
// so every app called them through untyped hooks:
//
//   export const task = defineContract("taskService", {
//     entity: taskSchema,
//     methods: {
//       ...admin.contract({ entity: taskSchema, filter: ["status"], sort: ["createdAt", "title"] }),
//       rename: mutation({ ... }),
//     },
//   });
//
// `adminList` pages every row by page number; `adminGet`, `adminCreate`,
// `adminUpdate` and `adminDelete` read and write one row; `adminMeta`
// describes the entity's fields for an admin screen; `adminSubscribers`
// counts the sockets subscribed to a row and `adminReemit` sends it to them
// again. `expose` picks the methods to add; all eight without it. The entity
// schema must describe itself as JSON Schema (Zod 4.2 or later): the fields
// come from it, so `admin.contract` refuses a schema that cannot.
//
// The server half (`admin.handlers` on `./server`) finds the kit's entries in
// the contract by what they were made for (`adminSpecOf`), its types by their
// tag (`AdminTag`), and the client adds `qd.<service>.admin`, every admin
// method's member in one place.

import type { AnyContract, RowSchema } from "../defineContract";
import type { MethodName } from "../infer";
import { mutation, query, type MethodDef, type MutationDef, type QueryDef } from "../methods";
import { isStandardSchema, type InferOutput, type StandardSchemaV1 } from "../standardSchema";
import {
  ADMIN_NEVER_WRITABLE,
  entityFieldsOf,
  type AdminEntityField,
  type AdminServiceMeta,
} from "./adminFields";
import {
  adminCreateInput,
  adminListInput,
  adminMetaInput,
  adminMetaOutput,
  adminPageOutput,
  adminRowOutput,
  adminSubscribersOutput,
  adminUpdateInput,
  type AdminCreateInput,
  type AdminCreateQuery,
  type AdminListInput,
  type AdminListQuery,
  type AdminMetaInput,
  type AdminPage,
  type AdminSubscribers,
  type AdminUpdateInput,
  type AdminUpdateQuery,
} from "./adminSchemas";
import type { ScalarFieldOf } from "./crud";
import { idInput, nullOutput, type IdInput } from "./crudSchemas";
import type { KitSchema } from "./schemas";

/** The methods the admin kit can add. */
export type AdminMethodName =
  | "adminList"
  | "adminGet"
  | "adminCreate"
  | "adminUpdate"
  | "adminDelete"
  | "adminMeta"
  | "adminSubscribers"
  | "adminReemit";

/** Every method of the admin kit, in the order `expose` defaults to. */
export const ADMIN_METHODS: readonly AdminMethodName[] = Object.freeze([
  "adminList",
  "adminGet",
  "adminCreate",
  "adminUpdate",
  "adminDelete",
  "adminMeta",
  "adminSubscribers",
  "adminReemit",
]);

/** Type-only: marks a method the admin kit made, and which one. Never set. */
export interface AdminTag<Kind extends AdminMethodName> {
  readonly "~admin"?: Kind;
}

/** The names of a contract's methods the admin kit made. */
export type AdminMethodsOf<C extends AnyContract> = {
  [M in MethodName<C>]: "~admin" extends keyof C["methods"][M] ? M : never;
}[MethodName<C>];

/** `admin.contract`'s options. */
export interface AdminContractOptions {
  /** The contract's entity schema, which must describe itself as JSON Schema (Zod 4.2 or later). */
  readonly entity: RowSchema;
  /** The fields `adminList` may filter on, by equality. */
  readonly filter?: readonly string[];
  /** The fields `adminList` may sort by; the first is the default order (else `id`). */
  readonly sort?: readonly string[];
  /** The methods to add; all eight when absent. */
  readonly expose?: readonly AdminMethodName[];
  /** Descriptions for people and agents, per method; the kit's own for the rest. */
  readonly describe?: { readonly [Name in AdminMethodName]?: string };
}

type RowOf<Entity> = Entity extends StandardSchemaV1 ? InferOutput<Entity> : never;

type Quoted<Names> = `"${Names & string}"`;

type FieldsIn<O, Key extends "filter" | "sort"> = O extends {
  readonly [K in Key]: readonly (infer Field extends string)[];
}
  ? Field
  : never;

/** A broken option becomes a message: replacing the whole option keeps TypeScript from printing `never`. */
type Problem<Option extends "filter" | "sort", Wrong> = [Wrong] extends [never]
  ? unknown
  : {
      readonly [K in Option]: `admin.contract: ${Option}: ${Quoted<Wrong>} is not a field of the entity holding strings, numbers or booleans`;
    };

/** The check of `filter` and `sort` against the entity that the option types alone cannot state. */
type AdminChecks<O> = O extends { readonly entity: infer Entity }
  ? Problem<"filter", Exclude<FieldsIn<O, "filter">, ScalarFieldOf<RowOf<Entity>>>> &
      Problem<"sort", Exclude<FieldsIn<O, "sort">, ScalarFieldOf<RowOf<Entity>>>>
  : unknown;

export type AdminListDef<Row, Filter extends string, Sort extends string> = QueryDef<
  KitSchema<AdminListInput<Row, Filter, Sort> | undefined, AdminListQuery<Filter, Sort>>,
  KitSchema<AdminPage<Row>>
> &
  AdminTag<"adminList">;
export type AdminGetDef<Row> = QueryDef<KitSchema<IdInput>, KitSchema<Row>> & AdminTag<"adminGet">;
export type AdminCreateDef<Row> = MutationDef<
  KitSchema<AdminCreateInput<Row>, AdminCreateQuery>,
  KitSchema<Row>
> &
  AdminTag<"adminCreate">;
export type AdminUpdateDef<Row> = MutationDef<
  KitSchema<AdminUpdateInput<Row>, AdminUpdateQuery>,
  KitSchema<Row>
> &
  AdminTag<"adminUpdate">;
export type AdminDeleteDef = MutationDef<KitSchema<IdInput>, KitSchema<null>> &
  AdminTag<"adminDelete">;
export type AdminMetaDef = QueryDef<
  KitSchema<AdminMetaInput | undefined, undefined>,
  KitSchema<AdminServiceMeta>
> &
  AdminTag<"adminMeta">;
export type AdminSubscribersDef = QueryDef<KitSchema<IdInput>, KitSchema<AdminSubscribers>> &
  AdminTag<"adminSubscribers">;
export type AdminReemitDef = MutationDef<KitSchema<IdInput>, KitSchema<AdminSubscribers>> &
  AdminTag<"adminReemit">;

type EntityRowIn<O> = O extends { readonly entity: infer Entity } ? RowOf<Entity> : never;

type AdminDefOf<O, Name extends AdminMethodName> = {
  adminList: AdminListDef<EntityRowIn<O>, FieldsIn<O, "filter">, FieldsIn<O, "sort">>;
  adminGet: AdminGetDef<EntityRowIn<O>>;
  adminCreate: AdminCreateDef<EntityRowIn<O>>;
  adminUpdate: AdminUpdateDef<EntityRowIn<O>>;
  adminDelete: AdminDeleteDef;
  adminMeta: AdminMetaDef;
  adminSubscribers: AdminSubscribersDef;
  adminReemit: AdminReemitDef;
}[Name];

type ExposedIn<O> = O extends { readonly expose: readonly (infer Name extends AdminMethodName)[] }
  ? Name
  : AdminMethodName;

/** The entries `admin.contract(options)` returns: one per method it adds. */
export type AdminMethods<O> = { readonly [Name in ExposedIn<O>]: AdminDefOf<O, Name> };

/** What the server half and the client need to know about a method the admin kit made. */
export interface AdminSpec {
  readonly method: AdminMethodName;
  /** The entity schema the kit was made for: the contract's own, which the server half checks. */
  readonly entity: RowSchema;
  /** The fields `adminList` may filter on. */
  readonly filter: readonly string[];
  /** The fields `adminList` may sort by. */
  readonly sort: readonly string[];
  /** The entity's fields, from its JSON Schema, in its order. */
  readonly fields: readonly AdminEntityField[];
}

const SPECS = new WeakMap<object, AdminSpec>();

/** What the admin kit made `method` for, or `undefined` for any other method. */
export function adminSpecOf(method: unknown): AdminSpec | undefined {
  return typeof method === "object" && method !== null ? SPECS.get(method) : undefined;
}

const DESCRIBE: Readonly<Record<AdminMethodName, string>> = Object.freeze({
  adminList:
    "Lists every row for a service administrator, a page at a time (page numbers from 1, at most 100 rows a page), filtered and sorted by the declared fields.",
  adminGet: "Reads one row by id, as a service administrator sees it.",
  adminCreate:
    "Creates a row from data, the new row's field values; the database sets its id and timestamps.",
  adminUpdate: "Changes the given fields of one row; its id and timestamps cannot be changed.",
  adminDelete: "Deletes one row.",
  adminMeta:
    "Describes the service's fields for an admin screen: their types, labels, and which can be edited, sorted and filtered.",
  adminSubscribers: "Counts the sockets subscribed to one row, per access level.",
  adminReemit: "Sends one row as it is now to every socket subscribed to it.",
});

type UnknownRecord = Readonly<Record<string, unknown>>;

const OPTIONS = ["entity", "filter", "sort", "expose", "describe"];

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(message: string): never {
  throw new TypeError(`admin.contract: ${message}`);
}

function quoted(names: readonly string[]): string {
  return names.map((name) => `"${name}"`).join(", ");
}

function checkOptions(options: unknown): UnknownRecord & { readonly entity: RowSchema } {
  if (!isRecord(options)) {
    fail("options must be { entity, filter?, sort?, expose?, describe? }");
  }
  const unknownKey = Object.keys(options).find((key) => !OPTIONS.includes(key));
  if (unknownKey !== undefined) {
    fail(`unknown option "${unknownKey}"; the options are ${OPTIONS.join(", ")}`);
  }
  if (!isStandardSchema(options.entity)) {
    fail("entity must be the contract's entity schema");
  }
  return options as UnknownRecord & { readonly entity: RowSchema };
}

/** `filter` or `sort`: distinct fields of the entity holding strings, numbers or booleans. */
function checkFields(
  owner: "filter" | "sort",
  names: unknown,
  fields: readonly AdminEntityField[],
): readonly string[] {
  if (names === undefined) {
    return Object.freeze([]);
  }
  const valid =
    Array.isArray(names) &&
    names.every((name) => typeof name === "string") &&
    new Set(names).size === names.length;
  if (!valid) {
    fail(`${owner} must be a list of distinct field names`);
  }
  for (const name of names as string[]) {
    const field = fields.find((candidate) => candidate.name === name);
    if (field === undefined || field.type === "json") {
      fail(`${owner}: "${name}" is not a field of the entity holding strings, numbers or booleans`);
    }
  }
  return Object.freeze([...(names as string[])]);
}

/** The methods the options add: those `expose` names, or all of them. */
function exposedOf(expose: unknown): readonly AdminMethodName[] {
  if (expose === undefined) {
    return ADMIN_METHODS;
  }
  const valid =
    Array.isArray(expose) &&
    expose.length > 0 &&
    expose.every((name) => ADMIN_METHODS.some((known) => known === name)) &&
    new Set(expose).size === expose.length;
  if (!valid) {
    fail(`expose must name one or more distinct admin methods: ${quoted(ADMIN_METHODS)}`);
  }
  return expose as AdminMethodName[];
}

/** The descriptions the options give, each for a method they add. */
function describedOf(names: readonly AdminMethodName[], describe: unknown): UnknownRecord {
  if (describe === undefined) {
    return {};
  }
  if (!isRecord(describe)) {
    fail("describe must map method names to descriptions");
  }
  for (const [name, text] of Object.entries(describe)) {
    if (!names.some((added) => added === name)) {
      fail(`describe names "${name}", which these options do not add`);
    }
    if (typeof text !== "string" || text.length === 0) {
      fail(`describe for "${name}" must be a non-empty string`);
    }
  }
  return describe;
}

/** What every entry is made from: the entity, its fields, and the declared filter and sort fields. */
type SpecBase = Omit<AdminSpec, "method">;

/** The entry of one admin method; `writable` are the fields its writes may set. */
function build(
  name: AdminMethodName,
  base: SpecBase,
  writable: readonly string[],
  describe: string,
): MethodDef {
  const { entity } = base;
  switch (name) {
    case "adminList":
      return query({
        input: adminListInput(base, entity),
        output: adminPageOutput(entity),
        describe,
      });
    case "adminGet":
      return query({ input: idInput(), output: adminRowOutput(entity), describe });
    case "adminCreate":
      return mutation({
        input: adminCreateInput(entity, writable),
        output: adminRowOutput(entity),
        describe,
      });
    case "adminUpdate":
      return mutation({
        input: adminUpdateInput(entity, writable),
        output: adminRowOutput(entity),
        describe,
      });
    case "adminDelete":
      return mutation({ input: idInput(), output: nullOutput(), describe });
    case "adminMeta":
      return query({ input: adminMetaInput(), output: adminMetaOutput(), describe });
    case "adminSubscribers":
      return query({ input: idInput(), output: adminSubscribersOutput(), describe });
    default:
      return mutation({ input: idInput(), output: adminSubscribersOutput(), describe });
  }
}

function contract<const O extends AdminContractOptions>(
  options: O & NoInfer<AdminChecks<O>>,
): AdminMethods<O> {
  const checked = checkOptions(options);
  const { entity } = checked;
  const fields = entityFieldsOf(entity, fail);
  const base: SpecBase = Object.freeze({
    entity,
    filter: checkFields("filter", checked.filter, fields),
    sort: checkFields("sort", checked.sort, fields),
    fields,
  });
  const names = exposedOf(checked.expose);
  const described = describedOf(names, checked.describe);
  const writable = fields
    .map((field) => field.name)
    .filter((field) => !ADMIN_NEVER_WRITABLE.includes(field));
  const methods: Record<string, MethodDef> = {};
  for (const name of names) {
    const own = described[name];
    const def = build(name, base, writable, typeof own === "string" ? own : DESCRIBE[name]);
    SPECS.set(def, Object.freeze({ ...base, method: name }));
    methods[name] = def;
  }
  return Object.freeze(methods) as unknown as AdminMethods<O>;
}

/**
 * The admin kit's contract half: `admin.contract({ entity, filter?, sort?,
 * expose?, describe? })` makes the admin methods, which the server half
 * (`admin.handlers` on `./server`) implements, each open to a service-wide
 * `Admin` grant unless the service says otherwise.
 */
export const admin = Object.freeze({ contract });

export type {
  AdminEntityField,
  AdminFieldConfig,
  AdminFieldType,
  AdminServiceMeta,
  EntityFieldType,
} from "./adminFields";
