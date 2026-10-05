// Contract schemas as text for `quickdraw-docs`: each schema's Standard JSON
// Schema (Zod 4.2 or later), drafted as draft-07 like the MCP bridge's tools,
// written as a TypeScript-like type (`{ id: string; notes: string | null }`)
// plus notes for the constraints a type cannot say (`1 to 200; default 50`).
// A schema that cannot describe itself as JSON Schema (Zod 3, a hand-written
// Standard Schema) is shown as such: the generator reads contracts, never
// source code.

import { hasJsonSchema, isStandardSchema } from "../contract/standardSchema";

/** A JSON Schema object, as a schema library wrote it. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** One property of an object schema, as a row of a field table. */
export interface SchemaField {
  readonly name: string;
  readonly optional: boolean;
  readonly type: string;
  readonly notes: string;
}

/** What a schema cannot describe itself as: shown wherever its type would be. */
export const NO_JSON_SCHEMA = "unknown (no JSON Schema)";

const TARGET = "draft-07";
const MAX_DEPTH = 8;
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** The `$ref` of the whole schema, which a recursive schema uses to refer to itself. */
const ROOT = "#";

function isRecord(value: unknown): value is JsonSchema {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The JSON Schema of `schema`'s input or output, or `undefined` when the
 * schema cannot describe itself (no Standard JSON Schema, or it throws).
 */
export function jsonSchemaOf(schema: unknown, mode: "input" | "output"): JsonSchema | undefined {
  if (!isStandardSchema(schema) || !hasJsonSchema(schema)) {
    return undefined;
  }
  try {
    const json: unknown = schema["~standard"].jsonSchema[mode]({ target: TARGET });
    return isRecord(json) ? json : undefined;
  } catch {
    return undefined;
  }
}

/** Where `$ref`s resolve, and the refs being written (a recursive schema prints its name). */
interface Scope {
  readonly root: JsonSchema;
  readonly open: readonly string[];
  readonly depth: number;
}

function definitionOf(root: JsonSchema, ref: string): JsonSchema | undefined {
  const match = /^#\/(definitions|\$defs)\/(.+)$/.exec(ref);
  if (match === null) {
    return undefined;
  }
  const [, group = "", name = ""] = match;
  const definitions = root[group];
  const found = isRecord(definitions) ? definitions[decodeURIComponent(name)] : undefined;
  return isRecord(found) ? found : undefined;
}

function literal(value: unknown): string {
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function joined(parts: readonly string[], separator: " | " | " & "): string {
  const unique = [...new Set(parts)];
  return unique.length === 0 ? "never" : unique.join(separator);
}

const OPENING = new Set(["{", "[", "(", "<"]);
const CLOSING = new Set(["}", "]", ")", ">"]);

/** `text` without the contents of its JSON string literals: `"a | b"` becomes `""`. */
function withoutStrings(text: string): string {
  return text.replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

/** True when `text` is a union or intersection at its top level, outside brackets and strings. */
function isCompound(text: string): boolean {
  let depth = 0;
  const bare = withoutStrings(text);
  for (const [index, char] of [...bare].entries()) {
    if (OPENING.has(char)) {
      depth += 1;
    } else if (CLOSING.has(char)) {
      depth -= 1;
    } else if (depth === 0 && (char === "|" || char === "&") && bare[index - 1] === " ") {
      return true;
    }
  }
  return false;
}

/** `T[]`, with a union or intersection in parentheses. */
function arrayOf(item: string): string {
  return isCompound(item) ? `(${item})[]` : `${item}[]`;
}

function propertyName(name: string, optional: boolean): string {
  const key = IDENTIFIER.test(name) ? name : JSON.stringify(name);
  return optional ? `${key}?` : key;
}

function requiredOf(schema: JsonSchema): ReadonlySet<string> {
  return new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
}

function objectText(schema: JsonSchema, scope: Scope): string {
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const required = requiredOf(schema);
  const members = Object.entries(properties).map(
    ([name, value]) => `${propertyName(name, !required.has(name))}: ${textOf(value, scope)}`,
  );
  const extra = schema.additionalProperties;
  if (isRecord(extra)) {
    const value = textOf(extra, scope);
    if (members.length === 0) {
      return `Record<string, ${value}>`;
    }
    members.push(`[key: string]: ${value}`);
  }
  return members.length === 0 ? "{}" : `{ ${members.join("; ")} }`;
}

function arrayText(schema: JsonSchema, scope: Scope): string {
  const tuple = Array.isArray(schema.prefixItems)
    ? schema.prefixItems
    : Array.isArray(schema.items)
      ? schema.items
      : undefined;
  if (tuple !== undefined) {
    return `[${tuple.map((item) => textOf(item, scope)).join(", ")}]`;
  }
  return arrayOf(schema.items === undefined ? "unknown" : textOf(schema.items, scope));
}

function typeNameText(type: string, schema: JsonSchema, scope: Scope): string {
  switch (type) {
    case "object":
      return objectText(schema, scope);
    case "array":
      return arrayText(schema, scope);
    case "string":
    case "number":
    case "integer":
    case "boolean":
    case "null":
      return type;
    default:
      return "unknown";
  }
}

/** The members of a union or intersection keyword, written. */
function combined(schema: JsonSchema, scope: Scope): string | undefined {
  for (const [keyword, separator] of [
    ["anyOf", " | "],
    ["oneOf", " | "],
    ["allOf", " & "],
  ] as const) {
    const options = schema[keyword];
    if (Array.isArray(options)) {
      return joined(
        options.map((option) => textOf(option, scope)),
        separator,
      );
    }
  }
  return undefined;
}

/** A `$ref`: the schema it names written out, or its name where it refers to itself. */
function refText(ref: string, scope: Scope): string {
  const target = ref === ROOT ? scope.root : definitionOf(scope.root, ref);
  const title = target?.title;
  const name =
    typeof title === "string"
      ? title
      : ref === ROOT
        ? "Self"
        : decodeURIComponent(ref.replace(/^#\/(definitions|\$defs)\//, ""));
  if (target === undefined || scope.open.includes(ref)) {
    return name;
  }
  return textOf(target, { ...scope, open: [...scope.open, ref] });
}

/** `schema` written as a TypeScript-like type. */
function textOf(schema: unknown, scope: Scope): string {
  if (schema === true || (isRecord(schema) && Object.keys(schema).length === 0)) {
    return "unknown";
  }
  if (!isRecord(schema) || scope.depth > MAX_DEPTH) {
    return schema === false ? "never" : "unknown";
  }
  const inner: Scope = { ...scope, depth: scope.depth + 1 };
  if (typeof schema.$ref === "string") {
    return refText(schema.$ref, inner);
  }
  if ("const" in schema) {
    return literal(schema.const);
  }
  if (Array.isArray(schema.enum)) {
    return joined(schema.enum.map(literal), " | ");
  }
  const union = combined(schema, inner);
  if (union !== undefined) {
    return union;
  }
  const { type } = schema;
  if (Array.isArray(type)) {
    return joined(
      type.map((name) => typeNameText(String(name), schema, inner)),
      " | ",
    );
  }
  if (typeof type === "string") {
    return typeNameText(type, schema, inner);
  }
  return isRecord(schema.properties) ? objectText(schema, inner) : "unknown";
}

/** `schema` written as a TypeScript-like type: `{ id: string; title: string }`. */
export function schemaText(schema: JsonSchema): string {
  return textOf(schema, { root: schema, open: [ROOT], depth: 0 });
}

function isNumber(value: unknown): value is number {
  return typeof value === "number";
}

/** `count` and its unit, singular for 1: "1 character", "20 items". */
function counted(count: number, unit: string): string {
  return `${count} ${count === 1 ? unit : `${unit}s`}`;
}

/** A length or size range: "1 to 200 characters", "at least 1 character", "exactly 3 items". */
function sizeNote(low: unknown, high: unknown, unit: string): string | undefined {
  if (isNumber(low) && isNumber(high)) {
    return low === high ? `exactly ${counted(high, unit)}` : `${low} to ${counted(high, unit)}`;
  }
  if (isNumber(low)) {
    return `at least ${counted(low, unit)}`;
  }
  return isNumber(high) ? `at most ${counted(high, unit)}` : undefined;
}

/**
 * A bound of a number, or `undefined` for none: Zod writes the safe-integer
 * range as the bounds of every integer (`z.number().int()`), which says no
 * more than the type does.
 */
function numberBound(value: unknown): number | undefined {
  return isNumber(value) && Math.abs(value) !== Number.MAX_SAFE_INTEGER ? value : undefined;
}

/** A number's lower bound in words: "positive", "more than 5", "non-negative", "at least 1". */
function lowerNote(
  inclusive: number | undefined,
  exclusive: number | undefined,
): string | undefined {
  if (exclusive !== undefined) {
    return exclusive === 0 ? "positive" : `more than ${exclusive}`;
  }
  if (inclusive === undefined) {
    return undefined;
  }
  return inclusive === 0 ? "non-negative" : `at least ${inclusive}`;
}

/** A number's upper bound in words: "negative", "less than 5", "non-positive", "at most 10". */
function upperNote(
  inclusive: number | undefined,
  exclusive: number | undefined,
): string | undefined {
  if (exclusive !== undefined) {
    return exclusive === 0 ? "negative" : `less than ${exclusive}`;
  }
  if (inclusive === undefined) {
    return undefined;
  }
  return inclusive === 0 ? "non-positive" : `at most ${inclusive}`;
}

/** A number's range: "1 to 200", "non-negative", "positive", "at most 10", "more than 5". */
function numberNote(schema: JsonSchema): string | undefined {
  const low = numberBound(schema.minimum);
  const high = numberBound(schema.maximum);
  if (low !== undefined && high !== undefined) {
    return low === high ? `exactly ${low}` : `${low} to ${high}`;
  }
  const parts = [
    lowerNote(low, numberBound(schema.exclusiveMinimum)),
    upperNote(high, numberBound(schema.exclusiveMaximum)),
  ].filter((part) => part !== undefined);
  return parts.length === 0 ? undefined : parts.join(", ");
}

/** The constraints of `schema` a type does not show: ranges, a format, a default, its description. */
export function schemaNotes(schema: JsonSchema): string {
  const notes = [
    sizeNote(schema.minLength, schema.maxLength, "character"),
    numberNote(schema),
    sizeNote(schema.minItems, schema.maxItems, "item"),
    typeof schema.format === "string" ? `format ${schema.format}` : undefined,
    "default" in schema ? `default ${literal(schema.default)}` : undefined,
    typeof schema.description === "string" ? schema.description : undefined,
  ];
  return notes.filter((note): note is string => note !== undefined && note !== "").join("; ");
}

/**
 * The properties of an object schema, one row each, or `undefined` when
 * `schema` is not an object with properties (its type is shown whole).
 */
export function schemaFields(schema: JsonSchema): readonly SchemaField[] | undefined {
  const properties = schema.properties;
  if (schema.type !== "object" || !isRecord(properties) || Object.keys(properties).length === 0) {
    return undefined;
  }
  const required = requiredOf(schema);
  const scope: Scope = { root: schema, open: [ROOT], depth: 1 };
  return Object.entries(properties).map(([name, value]) => ({
    name,
    optional: !required.has(name),
    type: textOf(value, scope),
    notes: isRecord(value) ? schemaNotes(value) : "",
  }));
}
