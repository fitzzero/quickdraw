// Projections (RFC 0003 sections 2 and 6): the wire shape of a row. A
// projection's keys decide what a read selects, so a row is never loaded
// wider than what is sent, and `Date` values go out as ISO strings. This
// replaces 4.1's `toDto` (`legacy-src/server/BaseService.ts:615-617`), an
// identity mapping that sent every column a handler happened to read.
//
// The keys come from the schema's Standard JSON Schema (Zod 4.2 or later):
// the `properties` of its output's object schema. A schema that cannot
// describe itself names its keys in the service's `project` option instead,
// or the service fails when it is defined (section 2). `project` also gives a
// projection a `select` of its own and a `map`, for relations and computed
// fields: reads use that select, and `map` turns the row read into the
// projection's row.

import type { AccessLevel } from "../../contract/access";
import type { AnyContract } from "../../contract/defineContract";
import type { MethodOutput } from "../../contract/methods";
import { hasJsonSchema, type StandardSchemaV1 } from "../../contract/standardSchema";
import type { RowLevels } from "../access/policy";
import type { StorageRow } from "../storage";
import { strip, tiersOf, type Tiers } from "./tiers";

type Fail = (message: string) => never;

type UnknownRecord = Readonly<Record<string, unknown>>;

/** A projection as a service compiles it once, from its schema and its `project` option. */
export interface Projection {
  /** `"entity"`, or the name of one of the contract's projections. */
  readonly name: string;
  /** Its keys, `id` first. */
  readonly keys: readonly string[];
  /** The `select` its rows are read with: the one `project` gives it, or its keys. */
  readonly select: UnknownRecord;
  /** Turns a row read with `select` into the projection's row; absent for a plain projection. */
  readonly map: ((row: StorageRow) => unknown) | undefined;
  /** The contract's field tiers over the projection's keys. */
  readonly tiers: Tiers;
}

/** How a method's output names a projection: one row, one row or `null`, or a list. */
export interface ProjectedOutput {
  readonly projection: Projection;
  readonly kind: "one" | "nullable" | "list";
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A plain object or an array: what a projected value is made of. */
function isPlain(value: unknown): value is object {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return Array.isArray(value) || prototype === Object.prototype || prototype === null;
}

/** The object schema a JSON Schema document describes, following one top-level `$ref`. */
function objectSchema(json: UnknownRecord): UnknownRecord | undefined {
  const ref = json.$ref;
  if (typeof ref !== "string") {
    return json;
  }
  const match = /^#\/(definitions|\$defs)\/(.+)$/.exec(ref);
  const defs = match === null ? undefined : json[match[1] ?? ""];
  const target = isRecord(defs) ? defs[match?.[2] ?? ""] : undefined;
  return isRecord(target) ? target : undefined;
}

/**
 * The keys a schema's output has, read from its Standard JSON Schema, or
 * `undefined` when it cannot say: no JSON Schema (a Zod 3 schema), a value
 * JSON Schema cannot write (a `Date`, a transform), or an output that is not
 * one object (a union).
 */
export function schemaKeys(schema: StandardSchemaV1): readonly string[] | undefined {
  if (!hasJsonSchema(schema)) {
    return undefined;
  }
  let json: unknown;
  try {
    json = schema["~standard"].jsonSchema.output({ target: "draft-07" });
  } catch {
    return undefined;
  }
  const described = isRecord(json) ? objectSchema(json) : undefined;
  const properties = described?.properties;
  return isRecord(properties) ? Object.keys(properties) : undefined;
}

const OPTION_KEYS = new Set(["keys", "select", "map"]);

function checkKeyList(owner: string, keys: unknown, fail: Fail): readonly string[] {
  const valid =
    Array.isArray(keys) &&
    keys.every((key) => typeof key === "string" && key.length > 0) &&
    new Set(keys).size === keys.length;
  if (!valid) {
    fail(`${owner}: keys must be a list of distinct field names`);
  }
  if (!keys.includes("id")) {
    fail(`${owner}: keys must include "id"; every row is keyed by it`);
  }
  return keys as readonly string[];
}

/** One projection's `project` entry, checked: unknown options, keys, select and map. */
function checkOption(owner: string, option: unknown, fail: Fail): UnknownRecord {
  if (option === undefined) {
    return {};
  }
  if (!isRecord(option)) {
    fail(`${owner} must be { keys?, select?, map? }`);
  }
  const unknownKey = Object.keys(option).find((key) => !OPTION_KEYS.has(key));
  if (unknownKey !== undefined) {
    fail(`${owner} has an unknown option "${unknownKey}"; the options are keys, select and map`);
  }
  if (option.select !== undefined && !isRecord(option.select)) {
    fail(`${owner}: select must be a select object, as in { id: true, labels: { select: ... } }`);
  }
  if (option.map !== undefined && typeof option.map !== "function") {
    fail(`${owner}: map must be a function of the row its select reads`);
  }
  return option;
}

function keysFor(
  name: string,
  schema: StandardSchemaV1,
  option: UnknownRecord,
  fail: Fail,
): readonly string[] {
  const owner = `projection "${name}"`;
  if (option.keys !== undefined) {
    return checkKeyList(owner, option.keys, fail);
  }
  const keys = schemaKeys(schema);
  if (keys === undefined) {
    fail(
      `${owner}: its schema cannot list its keys (it has no Standard JSON Schema the framework can read); use Zod 4.2 or later for it, or declare them with project: { ${name}: { keys: [...] } }`,
    );
  }
  return keys;
}

function compileOne(
  name: string,
  schema: StandardSchemaV1,
  option: unknown,
  fields: Readonly<Record<string, AccessLevel>>,
  fail: Fail,
): Projection {
  const checked = checkOption(`projection "${name}"`, option, fail);
  const keys = keysFor(name, schema, checked, fail);
  const ordered = ["id", ...keys.filter((key) => key !== "id")];
  const select = isRecord(checked.select)
    ? { id: true, ...checked.select }
    : Object.fromEntries(ordered.map((key) => [key, true]));
  return Object.freeze({
    name,
    keys: Object.freeze(ordered),
    select: Object.freeze(select),
    map: checked.map as Projection["map"],
    tiers: tiersOf(fields, ordered),
  });
}

/**
 * Compiles every projection of `contract` (the entity and its named
 * projections) with the service's `project` option. Fails, through `fail`,
 * for a projection whose keys cannot be found, a `project` entry naming no
 * projection, and a malformed entry.
 */
export function compileProjections(
  contract: AnyContract,
  option: unknown,
  fail: Fail,
): ReadonlyMap<string, Projection> {
  if (option !== undefined && !isRecord(option)) {
    fail("project must map projection names to { keys?, select?, map? }");
  }
  const options = option ?? {};
  const schemas = new Map<string, StandardSchemaV1>(Object.entries(contract.projections));
  if (contract.entity !== undefined) {
    schemas.set("entity", contract.entity);
  }
  const unknownName = Object.keys(options).find((name) => !schemas.has(name));
  if (unknownName !== undefined) {
    fail(
      `project names "${unknownName}", which is not a projection of the contract; the projections are ${[...schemas.keys()].map((name) => `"${name}"`).join(", ") || "none"}`,
    );
  }
  const compiled = new Map<string, Projection>();
  for (const [name, schema] of schemas) {
    compiled.set(name, compileOne(name, schema, options[name], contract.fields, fail));
  }
  return compiled;
}

/** The projection a method output names, or `undefined` when the output is a schema. */
export function projectedOutput(
  output: MethodOutput,
  projections: ReadonlyMap<string, Projection>,
): ProjectedOutput | undefined {
  if (typeof output === "string") {
    const projection = projections.get(output);
    return projection === undefined ? undefined : { projection, kind: "one" };
  }
  if (!("kind" in output)) {
    return undefined;
  }
  const projection = projections.get(output.projection);
  const kind = output.kind === "nullable" ? "nullable" : "list";
  return projection === undefined ? undefined : { projection, kind };
}

/**
 * `value` with every `Date` in it, at any depth of plain objects and arrays,
 * replaced by its ISO string. Anything else is kept as it is.
 */
export function isoDates(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (!isPlain(value)) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(isoDates);
  }
  const copy: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    copy[key] = isoDates(item);
  }
  return copy;
}

/** The members of `row` named by `keys` that it has, with their dates as ISO strings. */
export function pickKeys(row: UnknownRecord, keys: Iterable<string>): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  for (const key of keys) {
    if (Object.hasOwn(row, key)) {
      picked[key] = isoDates(row[key]);
    }
  }
  return picked;
}

/**
 * One row in the projection's shape: `map` applied (when the projection has
 * one), then its keys picked, dates as ISO strings. A value that is not an
 * object is returned as it is, for output validation to report.
 */
export function projectRow(projection: Projection, row: unknown): unknown {
  if (!isRecord(row)) {
    return row;
  }
  const source = projection.map === undefined ? row : projection.map(row);
  return isRecord(source) ? pickKeys(source, projection.keys) : source;
}

/** A method's result in its projection's shape: one row, `null`, or a list of rows. */
export function projectOutput(output: ProjectedOutput, value: unknown): unknown {
  if (output.kind === "list") {
    return Array.isArray(value)
      ? value.map((row: unknown) => projectRow(output.projection, row))
      : value;
  }
  if (value === null && output.kind === "nullable") {
    return null;
  }
  return projectRow(output.projection, value);
}

/** The ids of the rows in a projected value: one row, `null`, or a list. */
export function rowIds(value: unknown): string[] {
  const rows: readonly unknown[] = Array.isArray(value) ? value : [value];
  const ids: string[] = [];
  for (const row of rows) {
    if (isRecord(row) && typeof row.id === "string" && row.id.length > 0) {
      ids.push(row.id);
    }
  }
  return ids;
}

/**
 * A projected method result as one reader may see it: each row without the
 * fields its reader's level on that row does not reach (RFC 0003 section 6).
 * `levelsOf` answers the reader's level per row id; it is asked only when the
 * projection has tiered keys. Rows are copied, never changed in place, so a
 * shared run's result stays whole for the other callers.
 */
export async function stripForReader(
  output: ProjectedOutput,
  value: unknown,
  levelsOf: (ids: readonly string[]) => Promise<RowLevels>,
): Promise<unknown> {
  const { tiers } = output.projection;
  if (!tiers.tiered || value === null || value === undefined) {
    return value;
  }
  const ids = [...new Set(rowIds(value))];
  const levels: RowLevels = ids.length === 0 ? new Map() : await levelsOf(ids);
  const one = (row: unknown): unknown => {
    if (!isRecord(row)) {
      return row;
    }
    const level = typeof row.id === "string" ? (levels.get(row.id) ?? null) : null;
    return strip(row, tiers.hidden(level));
  };
  return Array.isArray(value) ? value.map(one) : one(value);
}
