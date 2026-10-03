// The input and output of the read/write kit's `list` (RFC 0003 section
// 12.1). A caller may filter and sort only on the fields the contract
// declares, and a filter value is a plain value (equality), never an object:
// nothing the caller sends reaches the database as an operator. The page
// size defaults to 50 and is clamped to 200; the cursor is opaque here and
// decoded by the server.

import type { SortDirection } from "../collections";
import type { StandardSchemaV1 } from "../standardSchema";
import {
  isRecord,
  jsonOf,
  kitSchema,
  objectJson,
  unknownKeys,
  type JsonSchema,
  type KitSchema,
} from "./schemas";

/** `list`'s page size when the caller gives none. */
export const LIST_DEFAULT_LIMIT = 50;

/** The largest page `list` returns: a larger `limit` is clamped to it. */
export const LIST_MAX_LIMIT = 200;

/** The longest cursor `list` (and `search`) accepts. */
export const MAX_CURSOR_LENGTH = 4096;

/** A value a `list` filter compares a field with. */
export type FilterValue = string | number | boolean | null;

/** A `list` call's sort: one declared field, ascending unless said otherwise. */
export interface ListSort<Field extends string = string> {
  readonly field: Field;
  readonly direction?: SortDirection;
}

/** `list`'s input as its handler receives it: defaults applied, the limit clamped. */
export interface ListQuery<Filter extends string = string, Sort extends string = string> {
  /** Equality per declared field; `{}` for none. */
  readonly filter: { readonly [Field in Filter]?: FilterValue };
  /** The caller's sort, or `undefined` for the default order. */
  readonly sort: { readonly field: Sort; readonly direction: SortDirection } | undefined;
  readonly cursor: string | undefined;
  /** At least 1 and at most {@link LIST_MAX_LIMIT}. */
  readonly limit: number;
  /** Whether to count every matching row, which costs a second statement. */
  readonly totalCount: boolean;
}

/** One page of `list`. */
export interface ListPage<Item> {
  readonly items: Item[];
  /** Passed back as `cursor` for the next page; `null` on the last page. */
  readonly nextCursor: string | null;
  /** Every row the call's filter and access match, when it asked with `totalCount: true`. */
  readonly totalCount?: number;
}

/** What `list` declares: the fields a caller may filter and sort on. */
export interface ListFields {
  readonly filter: readonly string[];
  readonly sort: readonly string[];
}

type Issues = StandardSchemaV1.Issue[];

function isFilterValue(value: unknown): value is FilterValue {
  return value === null || ["string", "number", "boolean"].includes(typeof value);
}

function quoted(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.map((name) => `"${name}"`).join(", ");
}

/** The issues of a `filter`: equality on declared fields only. The admin kit's `adminList` too. */
export function filterIssues(filter: unknown, fields: readonly string[]): Issues {
  if (filter === undefined) {
    return [];
  }
  if (!isRecord(filter)) {
    return [{ message: "Expected an object of field values", path: ["filter"] }];
  }
  return Object.entries(filter).flatMap(([field, value]): Issues => {
    if (!fields.includes(field)) {
      const message = `"${field}" is not a filter field; the filter fields are ${quoted(fields)}`;
      return [{ message, path: ["filter", field] }];
    }
    return isFilterValue(value)
      ? []
      : [{ message: "Expected a string, number, boolean or null", path: ["filter", field] }];
  });
}

/** The issues of a `sort`: one declared field, and a direction. The admin kit's `adminList` too. */
export function sortIssues(sort: unknown, fields: readonly string[]): Issues {
  if (sort === undefined) {
    return [];
  }
  if (!isRecord(sort)) {
    return [{ message: "Expected { field, direction? }", path: ["sort"] }];
  }
  const issues = unknownKeys(sort, ["field", "direction"], ["sort"]);
  if (typeof sort.field !== "string" || !fields.includes(sort.field)) {
    const message = `"${String(sort.field)}" is not a sort field; the sort fields are ${quoted(fields)}`;
    issues.push({ message, path: ["sort", "field"] });
  }
  if (sort.direction !== undefined && sort.direction !== "asc" && sort.direction !== "desc") {
    issues.push({ message: 'Expected "asc" or "desc"', path: ["sort", "direction"] });
  }
  return issues;
}

/** The issues of a page request's `cursor`, `limit` and `totalCount`, those it has. */
export function pagingIssues(value: Readonly<Record<string, unknown>>): Issues {
  const { cursor, limit, totalCount } = value;
  const issues: Issues = [];
  const isCursor =
    typeof cursor === "string" && cursor.length > 0 && cursor.length <= MAX_CURSOR_LENGTH;
  if (cursor !== undefined && !isCursor) {
    issues.push({ message: "Expected a cursor from an earlier page", path: ["cursor"] });
  }
  if (limit !== undefined && !(Number.isInteger(limit) && (limit as number) >= 1)) {
    issues.push({ message: "Expected a whole number of at least 1", path: ["limit"] });
  }
  if (totalCount !== undefined && typeof totalCount !== "boolean") {
    issues.push({ message: "Expected a boolean", path: ["totalCount"] });
  }
  return issues;
}

/** The parsed input of a valid `list` call. */
function queryOf(value: Readonly<Record<string, unknown>>): ListQuery {
  const sort = value.sort as ListSort | undefined;
  const limit = (value.limit as number | undefined) ?? LIST_DEFAULT_LIMIT;
  return {
    filter: { ...(value.filter as Readonly<Record<string, FilterValue>> | undefined) },
    sort:
      sort === undefined ? undefined : { field: sort.field, direction: sort.direction ?? "asc" },
    cursor: value.cursor as string | undefined,
    limit: Math.min(limit, LIST_MAX_LIMIT),
    totalCount: value.totalCount === true,
  };
}

/** The entity's JSON Schema properties, which describe its filter fields; none when it cannot write them. */
function entityProperties(
  entity: StandardSchemaV1 | undefined,
  target: string,
): Readonly<Record<string, unknown>> {
  let properties: unknown;
  try {
    properties = entity === undefined ? undefined : jsonOf(entity, "input", target)?.properties;
  } catch {
    properties = undefined;
  }
  return isRecord(properties) ? properties : {};
}

/** The JSON Schema of one filter field: the entity's own for that field, or any plain value. */
function fieldJson(properties: Readonly<Record<string, unknown>>, field: string): JsonSchema {
  const own = properties[field];
  return isRecord(own) ? { ...own } : { type: ["string", "number", "boolean", "null"] };
}

/**
 * The JSON Schema properties `filter` and `sort` of a list's input, those it
 * declares fields for. The admin kit's `adminList` too.
 */
export function filterSortJson(
  fields: ListFields,
  entity: StandardSchemaV1 | undefined,
  target: string,
): Record<string, JsonSchema> {
  const properties = entityProperties(entity, target);
  const filter = Object.fromEntries(
    fields.filter.map((field) => [field, fieldJson(properties, field)]),
  );
  const sort = objectJson(
    {
      field: { type: "string", enum: [...fields.sort] },
      direction: { type: "string", enum: ["asc", "desc"] },
    },
    ["field"],
  );
  return {
    ...(fields.filter.length === 0 ? {} : { filter: objectJson(filter) }),
    ...(fields.sort.length === 0 ? {} : { sort }),
  };
}

function listJson(fields: ListFields, entity: StandardSchemaV1 | undefined, target: string) {
  return objectJson({
    ...filterSortJson(fields, entity, target),
    cursor: { type: "string", minLength: 1, maxLength: MAX_CURSOR_LENGTH },
    limit: { type: "integer", minimum: 1, maximum: LIST_MAX_LIMIT, default: LIST_DEFAULT_LIMIT },
    totalCount: { type: "boolean" },
  });
}

/**
 * `list`'s input: `{ filter?, sort?, cursor?, limit?, totalCount? }`, or
 * nothing. `entity` gives the filter fields' JSON Schema when it can write one.
 */
export function listInput<Input, Query extends ListQuery>(
  fields: ListFields,
  entity: StandardSchemaV1 | undefined,
): KitSchema<Input, Query> {
  return kitSchema<Input, Query>(
    (input) => {
      const value = input ?? {};
      if (!isRecord(value)) {
        return { issues: [{ message: "Expected an object", path: [] }] };
      }
      const issues = [
        ...unknownKeys(value, ["filter", "sort", "cursor", "limit", "totalCount"]),
        ...filterIssues(value.filter, fields.filter),
        ...sortIssues(value.sort, fields.sort),
        ...pagingIssues(value),
      ];
      return issues.length > 0 ? { issues } : { value: queryOf(value) as Query };
    },
    { input: (target) => listJson(fields, entity, target) },
  );
}

/** The issues of a page's `items`: each must be a row with an id. */
export function itemsIssues(items: unknown): Issues {
  if (!Array.isArray(items)) {
    return [{ message: "Expected an array of rows", path: ["items"] }];
  }
  return items.flatMap((item: unknown, index): Issues => {
    const id = isRecord(item) ? item.id : undefined;
    return typeof id === "string" && id.length > 0
      ? []
      : [{ message: "Expected a row with an id", path: ["items", index] }];
  });
}

/** The JSON Schema of a page's `items`: an array of `item`'s rows, as far as `item` can describe them. */
export function itemsJson(item: StandardSchemaV1, target: string): JsonSchema {
  let items: JsonSchema;
  try {
    items = jsonOf(item, "output", target) ?? {};
  } catch {
    items = {};
  }
  return { type: "array", items };
}

function pageJson(item: StandardSchemaV1, target: string): JsonSchema {
  return objectJson(
    {
      items: itemsJson(item, target),
      nextCursor: { type: ["string", "null"] },
      totalCount: { type: "integer", minimum: 0 },
    },
    ["items", "nextCursor"],
  );
}

/**
 * One page of `list`: `{ items, nextCursor, totalCount? }`. Items are checked
 * to be rows with an id, not against `item`: the server strips the fields a
 * reader's level does not reach from them, which the item's own schema may
 * require.
 */
export function pageOutput<Item>(item: StandardSchemaV1): KitSchema<ListPage<Item>> {
  return kitSchema<ListPage<Item>>(
    (value) => {
      if (!isRecord(value)) {
        return { issues: [{ message: "Expected a page", path: [] }] };
      }
      const { nextCursor, totalCount } = value;
      const issues = [...unknownKeys(value, ["items", "nextCursor", "totalCount"])];
      issues.push(...itemsIssues(value.items));
      if (nextCursor !== null && typeof nextCursor !== "string") {
        issues.push({ message: "Expected a cursor or null", path: ["nextCursor"] });
      }
      if (
        totalCount !== undefined &&
        !(Number.isInteger(totalCount) && (totalCount as number) >= 0)
      ) {
        issues.push({ message: "Expected a count of rows", path: ["totalCount"] });
      }
      return issues.length > 0 ? { issues } : { value: value as unknown as ListPage<Item> };
    },
    { input: (target) => pageJson(item, target) },
  );
}
