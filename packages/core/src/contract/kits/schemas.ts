// The schemas kits generate (RFC 0003 section 12): plain Standard Schemas that
// also describe themselves as JSON Schema (Standard JSON Schema v1), so a
// kit's methods become MCP tools like any method whose schemas come from
// Zod 4.2 or later. Dependency-free and browser-safe, like the rest of the
// contract layer: a kit takes the app's own schemas (any Standard Schema
// library) and wraps them, and builds the parts it adds (ids, cursors,
// limits) itself.

import type {
  StandardJSONSchemaV1,
  StandardSchemaV1,
  StandardSchemaWithJSON,
} from "../standardSchema";

/** A JSON Schema document, as a kit schema writes it. */
export type JsonSchema = Record<string, unknown>;

/** A schema a kit generates: validation, and its JSON Schema. */
export type KitSchema<Input, Output = Input> = StandardSchemaWithJSON<Input, Output>;

/** A schema's validation result: `{ value }` or `{ issues }`. */
export type Validated<Output> = StandardSchemaV1.Result<Output>;

type Validator<Output> = (value: unknown) => Validated<Output> | Promise<Validated<Output>>;

/** Writes the JSON Schema of a kit schema's input and output for one target. */
export interface JsonWriter {
  readonly input: (target: string) => JsonSchema;
  readonly output?: (target: string) => JsonSchema;
}

const DIALECTS: Readonly<Record<string, string>> = Object.freeze({
  "draft-07": "http://json-schema.org/draft-07/schema#",
  "draft-2020-12": "https://json-schema.org/draft/2020-12/schema",
});

/** The `$schema` of a JSON Schema target a kit schema writes, or an error for one it does not. */
function dialectOf(options: StandardJSONSchemaV1.Options): string {
  const dialect = DIALECTS[options.target];
  if (dialect === undefined) {
    throw new Error(
      `quickdraw's kit schemas write JSON Schema draft-07 and draft-2020-12, not ${options.target}`,
    );
  }
  return dialect;
}

/** A Standard Schema with Standard JSON Schema, from a validator and a JSON Schema writer. */
export function kitSchema<Input, Output = Input>(
  validate: Validator<Output>,
  json: JsonWriter,
): KitSchema<Input, Output> {
  const write =
    (side: (target: string) => JsonSchema) =>
    (options: StandardJSONSchemaV1.Options): Record<string, unknown> => ({
      $schema: dialectOf(options),
      ...side(options.target),
    });
  const jsonSchema = Object.freeze({
    input: write(json.input),
    output: write(json.output ?? json.input),
  });
  return Object.freeze({
    "~standard": Object.freeze({ version: 1, vendor: "quickdraw", validate, jsonSchema }),
  }) as KitSchema<Input, Output>;
}

/** A failed validation with one issue. */
export function invalid(message: string, path: readonly PropertyKey[] = []): Validated<never> {
  return { issues: [{ message, path: [...path] }] };
}

/** A plain object: what kit inputs are made of. */
export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A row id: a non-empty string. */
export function isId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** The keys of `value` that are not in `allowed`, as issues at `path`. */
export function unknownKeys(
  value: Readonly<Record<string, unknown>>,
  allowed: readonly string[],
  path: readonly PropertyKey[] = [],
): StandardSchemaV1.Issue[] {
  const known = allowed.length === 0 ? "none" : allowed.map((key) => `"${key}"`).join(", ");
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => ({
      message: `Unknown key "${key}"; the keys are ${known}`,
      path: [...path, key],
    }));
}

/** Issues from another schema, moved under `path`. */
export function nested(
  issues: readonly StandardSchemaV1.Issue[],
  path: readonly PropertyKey[],
): StandardSchemaV1.Issue[] {
  return issues.map((issue) => ({
    message: issue.message,
    path: [...path, ...(issue.path ?? [])],
  }));
}

/** The JSON Schema of a row id. */
export function idJson(): JsonSchema {
  return { type: "string", minLength: 1 };
}

/** The JSON Schema of an object with `properties`, all of `required` present and nothing else. */
export function objectJson(
  properties: Readonly<Record<string, JsonSchema>>,
  required: readonly string[] = [],
): JsonSchema {
  return {
    type: "object",
    properties: { ...properties },
    ...(required.length === 0 ? {} : { required: [...required] }),
    additionalProperties: false,
  };
}

/** True when `schema` can describe itself as JSON Schema. */
function describes(schema: StandardSchemaV1): schema is StandardSchemaWithJSON {
  const props: object = schema["~standard"];
  return "jsonSchema" in props && isRecord(props.jsonSchema);
}

/**
 * The JSON Schema a Standard Schema writes for `target`, without its
 * `$schema` (the kit schema around it writes its own), or `undefined` when
 * the schema cannot describe itself.
 */
export function jsonOf(
  schema: StandardSchemaV1,
  side: "input" | "output",
  target: string,
): JsonSchema | undefined {
  if (!describes(schema)) {
    return undefined;
  }
  const { $schema: _dialect, ...json } = schema["~standard"].jsonSchema[side]({ target });
  return json;
}

/** True when `schema` can describe itself as JSON Schema: a kit schema wrapping it can too. */
export function hasJson(schema: StandardSchemaV1): boolean {
  return describes(schema);
}
