// The inputs and outputs the admin kit generates (RFC 0003 section 12.4).
//
// `adminList` pages by number, as 4.1's did
// (`legacy-src/server/BaseService.ts:1367-1388`): `page` from 1, `pageSize`
// 20 by default and at most 100 (a larger one is clamped). Its filter and
// sort are restricted to the fields the contract declares and checked as
// the read/write kit's `list` checks them (`crudList.ts`): a filter is
// equality on plain values, so nothing the caller sends reaches the database
// as an operator. 4.1 handed the caller's `where` and `orderBy` to the
// database as they came.
//
// A write's `data` holds field values of the entity: a key that is not one of
// its fields, `id` and the timestamps are refused, and each value is checked
// by the entity schema itself (`adminFields.ts`). A row out is the entity's
// row, checked to have an id: the server leaves out the fields the caller's
// level does not reach and those the service hides.

import type { AccessLevel } from "../access";
import type { SortDirection } from "../collections";
import type { StandardSchemaV1 } from "../standardSchema";
import { ADMIN_FIELD_TYPES, dataIssues, writtenData, type AdminServiceMeta } from "./adminFields";
import {
  filterIssues,
  filterSortJson,
  itemsIssues,
  sortIssues,
  type FilterValue,
  type ListFields,
  type ListSort,
} from "./crudList";
import {
  idJson,
  invalid,
  isId,
  isRecord,
  jsonOf,
  kitSchema,
  objectJson,
  unknownKeys,
  type JsonSchema,
  type KitSchema,
} from "./schemas";

/** `adminList`'s page size when the caller gives none: 4.1's. */
export const ADMIN_DEFAULT_PAGE_SIZE = 20;

/** The largest page `adminList` returns: a larger `pageSize` is clamped to it. */
export const ADMIN_MAX_PAGE_SIZE = 100;

/** The highest page number `adminList` takes: past it the offset alone is a slow scan. */
export const ADMIN_MAX_PAGE = 1_000_000;

/** What an `adminList` call passes: a page, and a filter and a sort over the declared fields. */
export type AdminListInput<Row, Filter extends string, Sort extends string> = {
  /** The page, from 1. Default 1. */
  readonly page?: number;
  /** The rows per page: default 20, at most 100 (a larger one is clamped). */
  readonly pageSize?: number;
  readonly filter?: [Filter] extends [never]
    ? undefined
    : { readonly [Field in Filter]?: Field extends keyof Row ? Row[Field] : never };
  readonly sort?: [Sort] extends [never] ? undefined : ListSort<Sort>;
};

/** `adminList`'s input as its handler receives it: defaults applied, the page size clamped. */
export interface AdminListQuery<Filter extends string = string, Sort extends string = string> {
  readonly page: number;
  /** At least 1 and at most {@link ADMIN_MAX_PAGE_SIZE}. */
  readonly pageSize: number;
  /** Equality per declared field; `{}` for none. */
  readonly filter: { readonly [Field in Filter]?: FilterValue };
  /** The caller's sort, or `undefined` for the default order. */
  readonly sort: { readonly field: Sort; readonly direction: SortDirection } | undefined;
}

/** One page of `adminList`, as 4.1's `AdminListResponse`. */
export interface AdminPage<Item> {
  readonly items: Item[];
  /** Every row the filter matches. */
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
  /** `ceil(total / pageSize)`. */
  readonly totalPages: number;
}

/** The fields no admin write sets: the row's key and its timestamps. */
export type AdminNeverWritable = "id" | "createdAt" | "updatedAt" | "created_at" | "updated_at";

/** The field values an admin write may set: any of the entity's fields but `id` and the timestamps. */
export type AdminData<Row> = {
  readonly [Field in Exclude<keyof Row, AdminNeverWritable>]?: Row[Field];
};

/** `adminCreate`: the new row's field values. */
export interface AdminCreateInput<Row> {
  readonly data: AdminData<Row>;
}

/** `adminUpdate`: the row, and the field values to change. */
export interface AdminUpdateInput<Row> {
  readonly id: string;
  readonly data: AdminData<Row>;
}

/** `adminCreate`'s input as its handler receives it: `data` without `undefined` values. */
export interface AdminCreateQuery {
  readonly data: Readonly<Record<string, unknown>>;
}

/** `adminUpdate`'s input as its handler receives it. */
export interface AdminUpdateQuery {
  readonly id: string;
  readonly data: Readonly<Record<string, unknown>>;
}

/** `adminMeta` takes nothing: no input, or `{}`. */
export type AdminMetaInput = Readonly<Record<string, never>>;

/** A level a subscriber holds a row at: one entity room per level (RFC 0003 section 6). */
export type SubscriberLevel = Exclude<AccessLevel, "Public">;

/** What `adminSubscribers` and `adminReemit` return: the sockets subscribed to one row. */
export interface AdminSubscribers {
  readonly id: string;
  /** Sockets subscribed to the row, at every level. */
  readonly count: number;
  /** The same per level: the sockets in each of the row's tier rooms. */
  readonly levels: { readonly [Level in SubscriberLevel]: number };
  /**
   * `true` when the counts cover every server. Behind a cluster adapter
   * (Redis) a server sees only its own sockets, and this is `false`.
   */
  readonly complete: boolean;
}

type Issues = StandardSchemaV1.Issue[];

type UnknownRecord = Readonly<Record<string, unknown>>;

const LEVELS: readonly SubscriberLevel[] = Object.freeze(["Read", "Moderate", "Admin"]);

function isCount(value: unknown, minimum = 0): boolean {
  return Number.isInteger(value) && (value as number) >= minimum;
}

function pageIssues(value: UnknownRecord): Issues {
  const { page, pageSize } = value;
  const issues: Issues = [];
  if (page !== undefined && !(isCount(page, 1) && (page as number) <= ADMIN_MAX_PAGE)) {
    issues.push({ message: `Expected a page number from 1 to ${ADMIN_MAX_PAGE}`, path: ["page"] });
  }
  if (pageSize !== undefined && !isCount(pageSize, 1)) {
    issues.push({ message: "Expected a whole number of at least 1", path: ["pageSize"] });
  }
  return issues;
}

/** The parsed input of a valid `adminList` call. */
function listQueryOf(value: UnknownRecord): AdminListQuery {
  const sort = value.sort as ListSort | undefined;
  const pageSize = (value.pageSize as number | undefined) ?? ADMIN_DEFAULT_PAGE_SIZE;
  return {
    page: (value.page as number | undefined) ?? 1,
    pageSize: Math.min(pageSize, ADMIN_MAX_PAGE_SIZE),
    filter: { ...(value.filter as Readonly<Record<string, FilterValue>> | undefined) },
    sort:
      sort === undefined ? undefined : { field: sort.field, direction: sort.direction ?? "asc" },
  };
}

/**
 * `adminList`'s input: `{ page?, pageSize?, filter?, sort? }`, or nothing.
 * `entity` gives the filter fields' JSON Schema.
 */
export function adminListInput<Input, Query extends AdminListQuery>(
  fields: ListFields,
  entity: StandardSchemaV1,
): KitSchema<Input, Query> {
  return kitSchema<Input, Query>(
    (input) => {
      const value = input ?? {};
      if (!isRecord(value)) {
        return invalid("Expected an object");
      }
      const issues = [
        ...unknownKeys(value, ["page", "pageSize", "filter", "sort"]),
        ...filterIssues(value.filter, fields.filter),
        ...sortIssues(value.sort, fields.sort),
        ...pageIssues(value),
      ];
      return issues.length > 0 ? { issues } : { value: listQueryOf(value) as Query };
    },
    {
      input: (target) =>
        objectJson({
          ...filterSortJson(fields, entity, target),
          page: { type: "integer", minimum: 1, maximum: ADMIN_MAX_PAGE, default: 1 },
          pageSize: {
            type: "integer",
            minimum: 1,
            maximum: ADMIN_MAX_PAGE_SIZE,
            default: ADMIN_DEFAULT_PAGE_SIZE,
          },
        }),
    },
  );
}

/** The entity's JSON Schema, or nothing when it cannot be written for `target`. */
function entityJson(
  entity: StandardSchemaV1,
  side: "input" | "output",
  target: string,
): JsonSchema {
  try {
    return jsonOf(entity, side, target) ?? {};
  } catch {
    return {};
  }
}

/**
 * The entity's row as JSON Schema, apart from the definitions its `$ref`s
 * point into, which the document holding it carries at its root. Nothing is
 * required: the server leaves out fields the caller may not see.
 */
function rowJson(entity: StandardSchemaV1, target: string): { row: JsonSchema; defs: JsonSchema } {
  const { definitions, $defs, required: _required, ...row } = entityJson(entity, "output", target);
  return {
    row,
    defs: {
      ...(definitions === undefined ? {} : { definitions }),
      ...($defs === undefined ? {} : { $defs }),
    },
  };
}

/** The JSON Schema of a write's `data`: the writable fields' own schemas, none required. */
function dataJson(
  entity: StandardSchemaV1,
  writable: readonly string[],
  target: string,
): { data: JsonSchema; defs: JsonSchema } {
  const json = entityJson(entity, "input", target);
  const properties = isRecord(json.properties) ? json.properties : {};
  const fields = writable
    .filter((name) => Object.hasOwn(properties, name))
    .map((name) => [name, properties[name] as JsonSchema]);
  const { definitions, $defs } = json;
  return {
    data: objectJson(Object.fromEntries(fields) as Record<string, JsonSchema>),
    defs: {
      ...(definitions === undefined ? {} : { definitions }),
      ...($defs === undefined ? {} : { $defs }),
    },
  };
}

/** A write's input: `{ data }`, with `id` too for an update. */
function writeInput<Input, Parsed>(
  entity: StandardSchemaV1,
  writable: readonly string[],
  withId: boolean,
): KitSchema<Input, Parsed> {
  const keys = withId ? ["id", "data"] : ["data"];
  return kitSchema<Input, Parsed>(
    async (input) => {
      if (!isRecord(input)) {
        return invalid(withId ? "Expected { id, data }" : "Expected { data }");
      }
      const issues = [...unknownKeys(input, keys)];
      if (withId && !isId(input.id)) {
        issues.push({ message: "Expected a non-empty string", path: ["id"] });
      }
      issues.push(...(await dataIssues(entity, writable, input.data, ["data"])));
      if (issues.length > 0) {
        return { issues };
      }
      const data = writtenData(input.data as UnknownRecord);
      return { value: (withId ? { id: input.id, data } : { data }) as Parsed };
    },
    {
      input: (target) => {
        const { data, defs } = dataJson(entity, writable, target);
        const properties: Record<string, JsonSchema> = withId ? { id: idJson(), data } : { data };
        return { ...objectJson(properties, keys), ...defs };
      },
    },
  );
}

/** `adminCreate`'s input: `{ data }`, the new row's values of `writable` fields. */
export function adminCreateInput<Row>(
  entity: StandardSchemaV1,
  writable: readonly string[],
): KitSchema<AdminCreateInput<Row>, AdminCreateQuery> {
  return writeInput(entity, writable, false);
}

/** `adminUpdate`'s input: `{ id, data }`, the values of `writable` fields to change. */
export function adminUpdateInput<Row>(
  entity: StandardSchemaV1,
  writable: readonly string[],
): KitSchema<AdminUpdateInput<Row>, AdminUpdateQuery> {
  return writeInput(entity, writable, true);
}

function rowIssues(value: unknown): Issues {
  return isRecord(value) && isId(value.id)
    ? []
    : [{ message: "Expected a row with an id", path: [] }];
}

/** One row of the entity, as `adminGet`, `adminCreate` and `adminUpdate` return it. */
export function adminRowOutput<Row>(entity: StandardSchemaV1): KitSchema<Row> {
  return kitSchema<Row>(
    (value) => {
      const issues = rowIssues(value);
      return issues.length > 0 ? { issues } : { value: value as Row };
    },
    {
      input: (target) => {
        const { row, defs } = rowJson(entity, target);
        return { ...row, ...defs };
      },
    },
  );
}

function pageCountIssues(value: UnknownRecord): Issues {
  const minimums: readonly [string, number][] = [
    ["total", 0],
    ["page", 1],
    ["pageSize", 1],
    ["totalPages", 0],
  ];
  return minimums.flatMap(([key, minimum]) =>
    isCount(value[key], minimum)
      ? []
      : [{ message: `Expected a count of at least ${minimum}`, path: [key] }],
  );
}

/** One page of `adminList`: `{ items, total, page, pageSize, totalPages }`. */
export function adminPageOutput<Item>(entity: StandardSchemaV1): KitSchema<AdminPage<Item>> {
  return kitSchema<AdminPage<Item>>(
    (value) => {
      if (!isRecord(value)) {
        return invalid("Expected a page");
      }
      const issues = [
        ...unknownKeys(value, ["items", "total", "page", "pageSize", "totalPages"]),
        ...itemsIssues(value.items),
        ...pageCountIssues(value),
      ];
      return issues.length > 0 ? { issues } : { value: value as unknown as AdminPage<Item> };
    },
    {
      input: (target) => {
        const { row, defs } = rowJson(entity, target);
        const count = (minimum: number): JsonSchema => ({ type: "integer", minimum });
        return {
          ...objectJson(
            {
              items: { type: "array", items: row },
              total: count(0),
              page: count(1),
              pageSize: { type: "integer", minimum: 1, maximum: ADMIN_MAX_PAGE_SIZE },
              totalPages: count(0),
            },
            ["items", "total", "page", "pageSize", "totalPages"],
          ),
          ...defs,
        };
      },
    },
  );
}

/** `adminMeta`'s input: nothing, or `{}`. */
export function adminMetaInput(): KitSchema<AdminMetaInput | undefined, undefined> {
  return kitSchema<AdminMetaInput | undefined, undefined>(
    (input) => {
      if (input === undefined) {
        return { value: undefined };
      }
      if (!isRecord(input)) {
        return invalid("Expected nothing, or {}");
      }
      const issues = unknownKeys(input, []);
      return issues.length > 0 ? { issues } : { value: undefined };
    },
    { input: () => objectJson({}) },
  );
}

const STRING: JsonSchema = Object.freeze({ type: "string" });
const BOOLEAN: JsonSchema = Object.freeze({ type: "boolean" });

function fieldConfigJson(): JsonSchema {
  return objectJson(
    {
      name: STRING,
      type: { type: "string", enum: [...ADMIN_FIELD_TYPES] },
      label: STRING,
      required: BOOLEAN,
      editable: BOOLEAN,
      showInTable: BOOLEAN,
      sortable: BOOLEAN,
      filterable: BOOLEAN,
      enumValues: { type: "array", items: STRING },
      relationService: STRING,
    },
    ["name", "type", "label", "required", "editable", "showInTable", "sortable", "filterable"],
  );
}

function fieldIssues(fields: unknown): Issues {
  if (!Array.isArray(fields)) {
    return [{ message: "Expected an array of fields", path: ["fields"] }];
  }
  return fields.flatMap((field: unknown, index): Issues => {
    const valid =
      isRecord(field) &&
      typeof field.name === "string" &&
      ADMIN_FIELD_TYPES.some((type) => type === field.type);
    return valid ? [] : [{ message: "Expected a field's configuration", path: ["fields", index] }];
  });
}

/** `adminMeta`'s output: the service's name, display name and field configurations. */
export function adminMetaOutput(): KitSchema<AdminServiceMeta> {
  return kitSchema<AdminServiceMeta>(
    (value) => {
      if (!isRecord(value)) {
        return invalid("Expected { serviceName, displayName, fields }");
      }
      const issues = [...unknownKeys(value, ["serviceName", "displayName", "fields"])];
      for (const key of ["serviceName", "displayName"]) {
        if (typeof value[key] !== "string") {
          issues.push({ message: "Expected a string", path: [key] });
        }
      }
      issues.push(...fieldIssues(value.fields));
      return issues.length > 0 ? { issues } : { value: value as unknown as AdminServiceMeta };
    },
    {
      input: () =>
        objectJson(
          {
            serviceName: STRING,
            displayName: STRING,
            fields: { type: "array", items: fieldConfigJson() },
          },
          ["serviceName", "displayName", "fields"],
        ),
    },
  );
}

function levelsIssues(levels: unknown): Issues {
  const valid =
    isRecord(levels) &&
    Object.keys(levels).length === LEVELS.length &&
    LEVELS.every((level) => isCount(levels[level]));
  return valid ? [] : [{ message: "Expected a count per level", path: ["levels"] }];
}

/** What `adminSubscribers` and `adminReemit` return: `{ id, count, levels, complete }`. */
export function adminSubscribersOutput(): KitSchema<AdminSubscribers> {
  return kitSchema<AdminSubscribers>(
    (value) => {
      if (!isRecord(value)) {
        return invalid("Expected { id, count, levels, complete }");
      }
      const issues = [
        ...unknownKeys(value, ["id", "count", "levels", "complete"]),
        ...(isId(value.id) ? [] : [{ message: "Expected a row id", path: ["id"] }]),
        ...(isCount(value.count) ? [] : [{ message: "Expected a count", path: ["count"] }]),
        ...levelsIssues(value.levels),
        ...(typeof value.complete === "boolean"
          ? []
          : [{ message: "Expected a boolean", path: ["complete"] }]),
      ];
      return issues.length > 0 ? { issues } : { value: value as unknown as AdminSubscribers };
    },
    {
      input: () =>
        objectJson(
          {
            id: idJson(),
            count: { type: "integer", minimum: 0 },
            levels: objectJson(
              Object.fromEntries(LEVELS.map((level) => [level, { type: "integer", minimum: 0 }])),
              LEVELS,
            ),
            complete: BOOLEAN,
          },
          ["id", "count", "levels", "complete"],
        ),
    },
  );
}
