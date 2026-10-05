// The admin kit's view of an entity (RFC 0003 sections 2 and 12.4): its
// fields, read from the entity schema's Standard JSON Schema (Zod 4.2 or
// later), since Standard Schema exposes validation only, and how a write of
// them is checked. 4.1 read Zod's type names instead
// (4.1 `src/server/utils/zodToAdminFields.ts:33-103`); the same field
// types come from each property's JSON Schema here:
//
// | JSON Schema of the property                     | Admin field type      |
// |-------------------------------------------------|-----------------------|
// | `type: "string"`, `format: "date-time"`/`"date"`| `date`                |
// | `enum` of strings, a string `const`, or a union | `enum` (`enumValues`) |
// |   of those                                      |                       |
// | `type: "string"`                                | `string`              |
// | `type: "number"` or `"integer"`                 | `number`              |
// | `type: "boolean"`                               | `boolean`             |
// | `type: "object"` or `"array"`, a union holding  | `json`                |
// |   one, or no type at all (`z.json()`, `{}`)     |                       |
// | a union of other types                          | `string`, as in 4.1   |
//
// `null` in a union or a type list makes the field nullable. A field is
// required when the schema requires it, it is not nullable and it has no
// default, as 4.1 counted optional, nullable and defaulted fields as not
// required. `relation` is never derived; `fieldOverrides` sets it.
//
// The types here are 4.1's (4.1 `src/shared/types.ts:283-338`).

import { hasJsonSchema, type StandardSchemaV1 } from "../standardSchema";
import { isRecord, nested } from "./schemas";

/** Supported field types for admin UI generation. */
export type AdminFieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "enum"
  | "json"
  | "relation";

/** Every admin field type. */
export const ADMIN_FIELD_TYPES: readonly AdminFieldType[] = Object.freeze([
  "string",
  "number",
  "boolean",
  "date",
  "enum",
  "json",
  "relation",
]);

/** Configuration for a single field in the admin UI: derived from the entity schema, with overrides. */
export interface AdminFieldConfig {
  /** Field name (property key on the entity). */
  readonly name: string;
  /** Field type for rendering the right input. */
  readonly type: AdminFieldType;
  /** Human-readable label. */
  readonly label: string;
  /** Whether the field is required for creation. */
  readonly required: boolean;
  /** Whether `adminCreate` and `adminUpdate` may write it (never `id` or the timestamps). */
  readonly editable: boolean;
  /** Whether to show the field as a table column. */
  readonly showInTable: boolean;
  /** Whether `adminList` may sort by it: the contract declares it in `sort`. */
  readonly sortable: boolean;
  /**
   * Whether `adminList` may filter on it: the contract declares it in
   * `filter`. `adminMeta` always says; optional (default `false`) so field
   * configurations written for 4.x, which had no `filterable`, still type.
   */
  readonly filterable?: boolean;
  /** For enum fields, the allowed values. */
  readonly enumValues?: readonly string[];
  /** For relation fields, the related service's name. */
  readonly relationService?: string;
  /**
   * What the field holds, when the kit knows it: `"grants"` for a user's
   * service-wide grants (`serviceAccess`), which `admin.handlers(contract,
   * { grants: true })` shows. An admin screen with a grants editor of its own
   * finds that field by it, never by its name. Absent for any other field.
   */
  readonly kind?: "grants";
  /**
   * Whether a generic create or edit form shows the field. `false` from a
   * `fieldOverrides` entry (`{ serviceAccess: { showInForm: false } }`) keeps
   * it for an editor of the app's own; the kit still reads and writes it.
   * Absent unless overridden: shown.
   */
  readonly showInForm?: boolean;
}

/** Service metadata for admin UI generation: what `adminMeta` returns. */
export interface AdminServiceMeta {
  /** The service's name on the wire (`"taskService"`). */
  readonly serviceName: string;
  /** Human-readable display name (`"Tasks"`). */
  readonly displayName: string;
  /** The entity's fields, but those the service hides, as configured for an admin screen. */
  readonly fields: readonly AdminFieldConfig[];
}

/** An admin field type the entity schema can give: every type but `relation`. */
export type EntityFieldType = Exclude<AdminFieldType, "relation">;

/** One field of the entity, as its JSON Schema describes it. */
export interface AdminEntityField {
  readonly name: string;
  readonly type: EntityFieldType;
  /** Required, not nullable and without a default. */
  readonly required: boolean;
  /** Whether the field accepts `null`. */
  readonly nullable: boolean;
  /** The values of an `enum` field. */
  readonly enumValues: readonly string[] | undefined;
}

/**
 * Fields no admin call writes, whatever the service configures: the row's key
 * and its timestamps, which the database sets (4.1's non-editable fields,
 * 4.1 `src/server/utils/zodToAdminFields.ts:7`).
 */
export const ADMIN_NEVER_WRITABLE: readonly string[] = Object.freeze([
  "id",
  "createdAt",
  "updatedAt",
  "created_at",
  "updated_at",
]);

/** The JSON Schema target fields are read from: the MCP bridge's. */
const TARGET = "draft-07";

/** How deep `$ref`s are followed before a property counts as JSON. */
const MAX_REFS = 8;

type Node = Readonly<Record<string, unknown>>;

/** The `definitions` and `$defs` of the entity's JSON Schema, which `$ref`s point into. */
type Defs = Readonly<Record<string, unknown>>;

/** What one property's JSON Schema says: its type, whether it takes `null`, and its enum values. */
interface Shape {
  readonly type: EntityFieldType;
  readonly nullable: boolean;
  readonly enumValues?: readonly string[];
}

const JSON_SHAPE: Shape = Object.freeze({ type: "json", nullable: true });

/** `node` with its `$ref` followed, or `undefined` for a node that says nothing (`true`, a dangling ref). */
function resolve(node: unknown, defs: Defs, depth = 0): Node | undefined {
  if (!isRecord(node)) {
    return undefined;
  }
  const ref = node.$ref;
  if (typeof ref !== "string") {
    return node;
  }
  const match = /^#\/(definitions|\$defs)\/(.+)$/.exec(ref);
  const group = match === null ? undefined : defs[match[1] ?? ""];
  const target = isRecord(group) ? group[match?.[2] ?? ""] : undefined;
  return depth < MAX_REFS ? resolve(target, defs, depth + 1) : undefined;
}

function isNullNode(node: Node | undefined): boolean {
  if (node === undefined) {
    return false;
  }
  const values = node.enum;
  return (
    node.type === "null" ||
    (Object.hasOwn(node, "const") && node.const === null) ||
    (Array.isArray(values) && values.length > 0 && values.every((value) => value === null))
  );
}

/** A string `type` alone: `format` makes a string a date. */
function typeShape(type: unknown, format: unknown): EntityFieldType {
  switch (type) {
    case "string":
      return format === "date-time" || format === "date" ? "date" : "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "json";
  }
}

/** The shape of a `const`. */
function constShape(value: unknown): Shape {
  if (typeof value === "string") {
    return { type: "enum", nullable: false, enumValues: [value] };
  }
  return { type: typeShape(typeof value, undefined), nullable: value === null };
}

/** The shape of an `enum`: of strings an `enum` field, otherwise its type. */
function enumShape(values: readonly unknown[], node: Node): Shape {
  const present = values.filter((value) => value !== null);
  const nullable = present.length < values.length;
  if (present.length > 0 && present.every((value) => typeof value === "string")) {
    return { type: "enum", nullable, enumValues: present as string[] };
  }
  const type = typeof node.type === "string" ? node.type : typeof present[0];
  return { type: typeShape(type, undefined), nullable };
}

/** The shape of several types at once: JSON when one is a structure, else a string (4.1's default). */
function mixedShape(shapes: readonly Shape[], nullable: boolean): Shape {
  if (shapes.some((shape) => shape.type === "json")) {
    return { type: "json", nullable };
  }
  if (shapes.every((shape) => shape.type === "enum")) {
    const values = shapes.flatMap((shape) => shape.enumValues ?? []);
    return { type: "enum", nullable, enumValues: [...new Set(values)] };
  }
  return { type: "string", nullable };
}

/** The shape of a `type` list, `["string", "null"]`. */
function typesShape(types: readonly unknown[], node: Node): Shape {
  const present = types.filter((type) => type !== "null");
  const nullable = present.length < types.length;
  if (present.length === 1) {
    return { type: typeShape(present[0], node.format), nullable };
  }
  return mixedShape(
    present.map((type) => ({ type: typeShape(type, undefined), nullable: false })),
    nullable,
  );
}

function shapeOf(node: unknown, defs: Defs, depth = 0): Shape {
  const resolved = resolve(node, defs);
  if (resolved === undefined || depth > MAX_REFS) {
    return JSON_SHAPE;
  }
  const union = resolved.anyOf ?? resolved.oneOf;
  if (Array.isArray(union)) {
    return unionShape(union, defs, depth);
  }
  if (Object.hasOwn(resolved, "const")) {
    return constShape(resolved.const);
  }
  if (Array.isArray(resolved.enum)) {
    return enumShape(resolved.enum, resolved);
  }
  if (Array.isArray(resolved.type)) {
    return typesShape(resolved.type, resolved);
  }
  if (resolved.type === undefined) {
    // No type at all (`z.unknown()`, `z.any()`): any JSON value, null among them.
    return JSON_SHAPE;
  }
  return {
    type: typeShape(resolved.type, resolved.format),
    nullable: resolved.type === "null",
  };
}

/** The shape of `anyOf` or `oneOf`: `null` makes it nullable, one other member is the field. */
function unionShape(members: readonly unknown[], defs: Defs, depth: number): Shape {
  const present = members.filter((member) => !isNullNode(resolve(member, defs)));
  const nullable = present.length < members.length;
  const shapes = present.map((member) => shapeOf(member, defs, depth + 1));
  if (shapes.length === 1 && shapes[0] !== undefined) {
    return { ...shapes[0], nullable: nullable || shapes[0].nullable };
  }
  return mixedShape(shapes, nullable || shapes.some((shape) => shape.nullable));
}

/** The object schema a JSON Schema document describes, following one top-level `$ref`. */
function rootObject(json: Node): Node | undefined {
  const root = resolve(json, { definitions: json.definitions, $defs: json.$defs });
  return isRecord(root?.properties) ? root : undefined;
}

/** Fails with why the entity schema cannot list the admin kit's fields, as a sentence. */
export type FieldsFailure = (message: string) => never;

/** The entity's input JSON Schema (draft-07, as the MCP bridge reads it), or a failure naming why it has none. */
function entityJson(entity: StandardSchemaV1, fail: FieldsFailure): Node {
  if (!hasJsonSchema(entity)) {
    fail(
      "the entity schema cannot describe itself as JSON Schema, which the admin kit's field metadata needs: use Zod 4.2 or later for that schema",
    );
  }
  try {
    const json: unknown = entity["~standard"].jsonSchema.input({ target: TARGET });
    if (isRecord(json)) {
      return json;
    }
    return fail("the entity schema's JSON Schema is not an object");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(
      `the entity schema cannot be written as JSON Schema (${reason}), which the admin kit's field metadata needs: change that schema`,
    );
  }
}

/**
 * The entity's fields, in its schema's order, from its Standard JSON Schema.
 * Fails through `fail` for a schema that cannot describe itself, or that does
 * not describe an object with an `id`.
 */
export function entityFieldsOf(
  entity: StandardSchemaV1,
  fail: FieldsFailure,
): readonly AdminEntityField[] {
  const json = entityJson(entity, fail);
  const root = rootObject(json);
  const properties = root?.properties;
  if (root === undefined || !isRecord(properties) || !Object.hasOwn(properties, "id")) {
    fail("the entity schema must describe an object with an id");
  }
  const required = new Set(Array.isArray(root.required) ? root.required : []);
  const defs: Defs = { definitions: json.definitions, $defs: json.$defs };
  return Object.freeze(
    Object.entries(properties).map(([name, node]) => {
      const shape = shapeOf(node, defs);
      const defaulted = isRecord(node) && Object.hasOwn(node, "default");
      return Object.freeze({
        name,
        type: shape.type,
        required: required.has(name) && !shape.nullable && !defaulted,
        nullable: shape.nullable,
        enumValues:
          shape.enumValues === undefined ? undefined : Object.freeze([...shape.enumValues]),
      });
    }),
  );
}

type Issues = StandardSchemaV1.Issue[];

/** The first key of an issue's path. */
function headOf(issue: StandardSchemaV1.Issue): PropertyKey | undefined {
  const [head] = issue.path ?? [];
  return typeof head === "object" ? head.key : head;
}

function quoted(names: readonly string[]): string {
  return names.length === 0 ? "none" : names.map((name) => `"${name}"`).join(", ");
}

/**
 * The issues of a write's `data` at `path`: a key that is not one of
 * `writable` (the entity's fields but `id` and the timestamps), and a value
 * the entity schema refuses for its field. The entity schema checks the given
 * fields only: a field the write leaves out is the database's to fill.
 */
export async function dataIssues(
  entity: StandardSchemaV1,
  writable: readonly string[],
  data: unknown,
  path: readonly PropertyKey[],
): Promise<Issues> {
  if (!isRecord(data)) {
    return [{ message: "Expected an object of field values", path: [...path] }];
  }
  const given = Object.keys(data).filter((key) => data[key] !== undefined);
  const refused = given.filter((key) => !writable.includes(key));
  if (refused.length > 0) {
    return refused.map((key) => ({
      message: ADMIN_NEVER_WRITABLE.includes(key)
        ? `"${key}" is not writable`
        : `"${key}" is not a writable field; the writable fields are ${quoted(writable)}`,
      path: [...path, key],
    }));
  }
  if (given.length === 0) {
    return [];
  }
  const result = await entity["~standard"].validate(writtenData(data));
  const issues = (result.issues ?? []).filter((issue) => {
    const head = headOf(issue);
    return typeof head === "string" && given.includes(head);
  });
  return nested(issues, path);
}

/** The fields a write sets: `data` without its `undefined` values. */
export function writtenData(data: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined));
}
