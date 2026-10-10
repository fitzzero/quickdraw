// The inputs `snapshotAccessMatrix` makes for a method the app gives no input
// for (`accessSnapshot.ts`): the row the cell is about, put where the
// method's access form reads it, and the input's other required values made
// from its Standard JSON Schema (Zod 4.2 or later), each as small as the
// schema allows. An input is usable only when it passes the method's input
// schema and, for an `entry` or `scope` form, names the cell's row where the
// form looks for it: the form's own id selector decides, so a function `id`
// is followed too. A keyless `todoSchema()` accepts `{}`, and an `entry` form
// then refuses the missing id with `FORBIDDEN` for everyone: a cell that
// looks plausible and means nothing. A cell without a usable input is never
// called.

import { hasJsonSchema, validate } from "../contract/standardSchema";
import { accessIds, isCustomAccess } from "../server/access/forms";
import type { AccessForm, EntryAccess, ScopeAccess } from "../server/access/types";
import { inputKeys } from "../server/emit/projection";
import type { AnyService, ServiceMethod } from "../server/service";

type Json = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** How deep a schema is followed: past it, a value is left out (a recursive schema). */
const MAX_DEPTH = 12;

/** Values JSON Schema has no form for become `{}` (any value), as the rowless check reads them (Zod 4). */
const UNREPRESENTABLE_AS_ANY = Object.freeze({ unrepresentable: "any" });

/** A string of each string format the schema libraries write, valid for it. */
const FORMATS: Readonly<Record<string, string>> = Object.freeze({
  email: "snapshot@example.com",
  "idn-email": "snapshot@example.com",
  uri: "https://example.com/",
  url: "https://example.com/",
  "uri-reference": "https://example.com/",
  hostname: "example.com",
  uuid: "00000000-0000-4000-8000-000000000000",
  guid: "00000000-0000-4000-8000-000000000000",
  "date-time": "2026-01-01T00:00:00.000Z",
  date: "2026-01-01",
  time: "00:00:00",
  duration: "P1D",
  ipv4: "127.0.0.1",
  ipv6: "::1",
  cuid: "cjld2cjxh0000qzrmn831i7rn",
  cuid2: "tz4a98xxat96iws9zmbrgj3a",
  ulid: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
  nanoid: "V1StGXR8_Z5jdHi6B-myT",
  e164: "+15555550100",
});

/** What a string with a `pattern` is tried with when its format's string does not match it. */
const PATTERN_CANDIDATES: readonly string[] = ["x", ...new Set(Object.values(FORMATS))];

/** The node a JSON Schema node stands for: the one its `$ref` names in `root`, or itself. */
function referenced(node: Json, root: Json): Json | undefined {
  const ref = node.$ref;
  if (typeof ref !== "string") {
    return node;
  }
  if (ref === "#") {
    return root;
  }
  const match = /^#\/(definitions|\$defs)\/(.+)$/.exec(ref);
  const defs = match === null ? undefined : root[match[1] ?? ""];
  const target = isRecord(defs) ? defs[match?.[2] ?? ""] : undefined;
  return isRecord(target) ? target : undefined;
}

/** The node's type: `"null"` when a list of types allows it, `"object"` for bare properties. */
function typeOf(node: Json): string | undefined {
  const { type } = node;
  if (typeof type === "string") {
    return type;
  }
  if (Array.isArray(type)) {
    const types = type.filter((each): each is string => typeof each === "string");
    return types.includes("null") ? "null" : types[0];
  }
  return isRecord(node.properties) ? "object" : undefined;
}

function isNullBranch(node: unknown): boolean {
  return isRecord(node) && typeOf(node) === "null";
}

/** A test of a string against the node's `pattern`; `undefined` without one (or one this engine cannot read). */
function patternOf(node: Json): ((value: string) => boolean) | undefined {
  if (typeof node.pattern !== "string") {
    return undefined;
  }
  try {
    const regex = new RegExp(node.pattern, "u");
    return (value) => regex.test(value);
  } catch {
    return undefined;
  }
}

function sampleString(node: Json): string {
  const format = typeof node.format === "string" ? FORMATS[node.format] : undefined;
  const matches = patternOf(node);
  let value = format ?? "x";
  if (matches !== undefined && !matches(value)) {
    value = PATTERN_CANDIDATES.find(matches) ?? value;
  }
  const min = typeof node.minLength === "number" ? node.minLength : 0;
  if (value.length < min) {
    value += "x".repeat(min - value.length);
  }
  return typeof node.maxLength === "number" ? value.slice(0, node.maxLength) : value;
}

/** The number nearest 0 within the node's bounds, on its `multipleOf`. */
function sampleNumber(node: Json, integer: boolean): number {
  const { minimum, maximum, exclusiveMinimum, exclusiveMaximum, multipleOf } = node;
  let value = 0;
  if (typeof minimum === "number" && value < minimum) {
    value = integer ? Math.ceil(minimum) : minimum;
  }
  if (typeof exclusiveMinimum === "number" && value <= exclusiveMinimum) {
    value = Math.floor(exclusiveMinimum) + 1;
  }
  if (typeof maximum === "number" && value > maximum) {
    value = integer ? Math.floor(maximum) : maximum;
  }
  if (typeof exclusiveMaximum === "number" && value >= exclusiveMaximum) {
    value = Math.ceil(exclusiveMaximum) - 1;
  }
  if (typeof multipleOf === "number" && multipleOf > 0 && value % multipleOf !== 0) {
    value = Math.ceil(value / multipleOf) * multipleOf;
  }
  return value;
}

/** Every required property, each as small as it may be; one that allows anything is `null`. */
function sampleObject(node: Json, root: Json, depth: number): Record<string, unknown> {
  const properties = isRecord(node.properties) ? node.properties : {};
  const required = Array.isArray(node.required) ? node.required : [];
  const value: Record<string, unknown> = {};
  for (const key of required) {
    if (typeof key === "string") {
      value[key] = sample(properties[key], root, depth + 1) ?? null;
    }
  }
  return value;
}

/** A tuple's items, or the fewest items a list allows. */
function sampleArray(node: Json, root: Json, depth: number): unknown[] {
  let tuple: readonly unknown[] | undefined;
  if (Array.isArray(node.prefixItems)) {
    tuple = node.prefixItems;
  } else if (Array.isArray(node.items)) {
    tuple = node.items;
  }
  if (tuple !== undefined) {
    return tuple.map((item) => sample(item, root, depth + 1) ?? null);
  }
  const length = typeof node.minItems === "number" ? node.minItems : 0;
  return Array.from({ length }, () => sample(node.items, root, depth + 1) ?? null);
}

/** A value of each part of an `allOf`, merged when they are objects. */
function sampleAll(parts: readonly unknown[], root: Json, depth: number): unknown {
  const values = parts.map((part) => sample(part, root, depth + 1));
  if (values.every((value) => isRecord(value) || value === undefined)) {
    return Object.assign({}, ...values) as unknown;
  }
  return values.find((value) => value !== undefined);
}

/** A value of the node's type; `undefined` for a node of no type, which allows anything. */
function sampleType(node: Json, root: Json, depth: number): unknown {
  switch (typeOf(node)) {
    case "object":
      return sampleObject(node, root, depth);
    case "array":
      return sampleArray(node, root, depth);
    case "string":
      return sampleString(node);
    case "integer":
      return sampleNumber(node, true);
    case "number":
      return sampleNumber(node, false);
    case "boolean":
      return false;
    case "null":
      return null;
    default:
      return undefined;
  }
}

/**
 * The smallest value JSON Schema `node` allows: its `const`, the first of its
 * `enum`, `null` where a union allows it (else its first branch), the parts
 * of an `allOf` merged, or a value of its type (`sampleType`). `undefined`
 * for a schema that allows anything: at the top level, the input of a method
 * that takes none.
 */
function sample(node: unknown, root: Json, depth: number): unknown {
  const target = isRecord(node) && depth <= MAX_DEPTH ? referenced(node, root) : undefined;
  if (target === undefined) {
    return undefined;
  }
  if (Object.hasOwn(target, "const")) {
    return target.const;
  }
  if (Array.isArray(target.enum) && target.enum.length > 0) {
    return target.enum[0] as unknown;
  }
  const branches = Array.isArray(target.anyOf) ? target.anyOf : target.oneOf;
  if (Array.isArray(branches) && branches.length > 0) {
    return branches.some(isNullBranch) ? null : sample(branches[0], root, depth + 1);
  }
  if (Array.isArray(target.allOf) && target.allOf.length > 0) {
    return sampleAll(target.allOf, root, depth);
  }
  return sampleType(target, root, depth);
}

/** A method's input as its JSON Schema describes it, read once per method. */
interface InputShape {
  /** The smallest input the schema allows; `undefined` without JSON Schema (a Zod 3 schema). */
  readonly skeleton: unknown;
  /** The JSON Schema document, for its `$ref`s. */
  readonly root: Json;
  /** The top-level properties, when the input is one object. */
  readonly properties: Json | undefined;
  /** True when the input itself is a string: a bare id. */
  readonly isString: boolean;
}

const shapes = new WeakMap<ServiceMethod, InputShape>();

/** The input's JSON Schema, or `undefined` when its schema cannot write one. */
function jsonSchemaOf(method: ServiceMethod): Json | undefined {
  if (!hasJsonSchema(method.input)) {
    return undefined;
  }
  try {
    const json = method.input["~standard"].jsonSchema.input({
      target: "draft-07",
      libraryOptions: UNREPRESENTABLE_AS_ANY,
    });
    return isRecord(json) ? json : undefined;
  } catch {
    return undefined;
  }
}

function shapeOf(method: ServiceMethod): InputShape {
  const known = shapes.get(method);
  if (known !== undefined) {
    return known;
  }
  const root = jsonSchemaOf(method);
  const described = root === undefined ? undefined : referenced(root, root);
  const shape: InputShape = {
    skeleton: root === undefined ? undefined : sample(root, root, 0),
    root: root ?? {},
    properties: isRecord(described?.properties) ? described.properties : undefined,
    isString: described !== undefined && typeOf(described) === "string",
  };
  shapes.set(method, shape);
  return shape;
}

/** The `entry` or `scope` part of a form, which reads a row id from the input; `undefined` for any other form. */
export function rowForm(form: AccessForm): EntryAccess | ScopeAccess | undefined {
  if (typeof form !== "object" || isCustomAccess(form)) {
    return undefined;
  }
  return form.entry === undefined && form.scope === undefined ? undefined : form;
}

/**
 * The service whose row a method's cells are about: the method's own for an
 * `entry` form, the `of` contract's for a `scope` form, and for any other
 * form its own when the input has a top-level `id` (a `rowless` method, a
 * `custom` check); `undefined` for a method about no row.
 */
export function rowServiceOf(service: AnyService, method: ServiceMethod): string | undefined {
  const form = rowForm(method.access);
  if (form?.scope !== undefined) {
    return form.of.name;
  }
  if (form !== undefined) {
    return service.name;
  }
  return inputKeys(method.input)?.includes("id") === true ? service.name : undefined;
}

/** True when `node` may hold a row id: a string, a list, or a value it does not describe. */
function mayHoldId(node: unknown): boolean {
  if (!isRecord(node)) {
    return true;
  }
  const type = typeOf(node);
  return type === undefined || type === "string" || type === "array" || type === "null";
}

/** The rank of a key a function selector may read the row from: `id` first, then `...Id` and `...Ids`. */
function keyRank(key: string): number {
  if (key === "id" || key === "ids") {
    return 0;
  }
  return /Ids?$/.test(key) ? 1 : 2;
}

/** The input keys a function selector may read the row from, most likely first. */
function selectorKeys(shape: InputShape): readonly string[] {
  const { properties } = shape;
  if (properties === undefined) {
    return shape.isString ? [] : ["id"];
  }
  return Object.keys(properties)
    .filter((key) => mayHoldId(properties[key]))
    .sort((a, b) => keyRank(a) - keyRank(b));
}

/** The row's id and a list of it, the list first when the key's schema is an array. */
function idValues(shape: InputShape, key: string, row: string): readonly unknown[] {
  const node = shape.properties?.[key];
  const target = isRecord(node) ? referenced(node, shape.root) : undefined;
  return target !== undefined && typeOf(target) === "array" ? [[row], row] : [row, [row]];
}

/** The keys a cell's row may go at: where the form reads it, or `id` for a form that reads none. */
function rowKeys(
  form: EntryAccess | ScopeAccess | undefined,
  shape: InputShape,
): readonly string[] {
  if (form === undefined) {
    return ["id"];
  }
  if (typeof form.id === "function") {
    return selectorKeys(shape);
  }
  return [form.id ?? "id"];
}

/** The inputs a cell tries, in order: the row put at each key it may go at, or the skeleton alone. */
function candidates(method: ServiceMethod, row: string | undefined): readonly unknown[] {
  const shape = shapeOf(method);
  if (row === undefined) {
    return [shape.skeleton];
  }
  const form = rowForm(method.access);
  const base = isRecord(shape.skeleton) ? shape.skeleton : {};
  const placed = rowKeys(form, shape).flatMap((key) =>
    idValues(shape, key, row).map((value) => ({ ...base, [key]: value })),
  );
  const bare = typeof form?.id === "function" && (shape.isString || shape.properties === undefined);
  return bare ? [...placed, row] : placed;
}

/** True when `input` passes the method's input schema. */
export async function isValidInput(method: ServiceMethod, input: unknown): Promise<boolean> {
  const result = await validate(method.input, input);
  return result.issues === undefined;
}

/** True when the form reads `row` from the parsed input, as the access check will. */
function namesRow(form: EntryAccess | ScopeAccess, parsed: unknown, row: string): boolean {
  try {
    return accessIds(form, parsed).includes(row);
  } catch {
    return false;
  }
}

/**
 * The input a cell about `row` calls `method` with, made from the method's
 * input schema: the first candidate that passes the schema and, for an
 * `entry` or `scope` form, names `row` where the form reads it. `undefined`
 * when none does: the cell is inconclusive and never called.
 */
export async function generatedInput(
  method: ServiceMethod,
  row: string | undefined,
): Promise<{ readonly input: unknown } | undefined> {
  const form = rowForm(method.access);
  for (const input of candidates(method, row)) {
    const result = await validate(method.input, input);
    if (result.issues !== undefined) {
      continue;
    }
    if (form === undefined || (row !== undefined && namesRow(form, result.value, row))) {
      return { input };
    }
  }
  return undefined;
}
