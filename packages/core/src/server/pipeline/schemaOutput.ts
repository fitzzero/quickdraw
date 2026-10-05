// Schema outputs (RFC 0003 section 9, step 8): a method whose output is a
// schema of its own, not `"entity"` and not a projection, sends its result
// reduced to what that schema's JSON Schema declares, on every transport and
// whatever `outputValidation` is. A handler may return a whole row; only the
// keys the schema declares leave the server. rc.5 and before sent what the
// handler returned, so `{ id, name }` answered with `db.user.update(...)`
// sent `email` too (the final review of the release candidates, item B).
//
// The reduction is compiled once per method, when its service is defined,
// from the schema's Standard JSON Schema (draft-07, a value JSON Schema
// cannot write read as any value): a call walks the compiled shapes and
// never reads the schema. What a value keeps, by what the schema says there:
//
// | JSON Schema                               | A value there keeps                                  |
// |-------------------------------------------|------------------------------------------------------|
// | an object with `properties`               | the keys `properties` declares, each reduced by its  |
// |                                           | own schema; another key only where                   |
// |                                           | `patternProperties` matches it or                    |
// |                                           | `additionalProperties` allows it (`true`, `{}`, or a |
// |                                           | schema that reduces its value)                       |
// | an object declaring no key (a record,     | every key, each value reduced by                     |
// | `{ type: "object" }`)                     | `additionalProperties` when it is a schema           |
// | an array                                  | its items, each reduced by `items` (a tuple's by     |
// |                                           | position, the rest by `additionalItems`)             |
// | `anyOf`, `oneOf`, `allOf`                 | what any of its schemas keeps                        |
// | `{}` (any value), `true`, a `$ref` it     | everything, as it is                                 |
// | cannot follow                             |                                                      |
// | a scalar (`string`, `const`, `enum`, ...) | a scalar as it is; a plain object there keeps no key |
//
// Only plain objects and arrays are reduced: a `Date`, a `Decimal` or a
// class instance goes as it is. Nothing is copied unless a key or an item is
// dropped, so a handler that returns exactly its schema's keys costs one
// pass over them. An output without JSON Schema (a Zod 3 schema) cannot be
// reduced and is sent as returned; in development its reply is checked for
// keys the contract tiers instead (`emit/tieredOutputs.ts`).

import { hasJsonSchema, type StandardSchemaV1 } from "../../contract/standardSchema";
import type { SchemaOutput } from "../service";

type JsonNode = Readonly<Record<string, unknown>>;

/** How the values at one place of an output are reduced. */
interface Shape {
  /** Any value: kept as it is. */
  readonly any: boolean;
  /** How a plain object there is reduced; without one, it keeps no key. */
  object: ObjectShape | undefined;
  /** How an array there is reduced; without one, each item is reduced by this shape. */
  array: ArrayShape | undefined;
}

interface ObjectShape {
  /** The declared keys' shapes, in an object without a prototype: a lookup per key is a property read. */
  readonly properties: Readonly<Record<string, Shape | undefined>>;
  readonly patterns: readonly { readonly regex: RegExp; readonly shape: Shape }[];
  /** How the value of a key `properties` and `patterns` do not declare is reduced; `undefined` drops the key. */
  readonly additional: Shape | undefined;
}

interface ArrayShape {
  readonly prefix: readonly Shape[];
  /** How the items past `prefix` are reduced; `undefined` drops them. */
  readonly rest: Shape | undefined;
}

/** Any value, kept as it is. */
const ANY: Shape = Object.freeze({ any: true, object: undefined, array: undefined });

/** What one JSON Schema node declares on its own, before its `anyOf`, `oneOf`, `allOf` and `$ref`. */
interface Node {
  readonly id: number;
  any: boolean;
  object:
    | {
        properties: Map<string, Node>;
        patterns: { regex: RegExp; node: Node }[];
        additional: Node | undefined;
      }
    | undefined;
  array: { prefix: Node[]; rest: Node | undefined } | undefined;
  /** The schemas it is one of, or all of: its branches and the node its `$ref` names. */
  readonly members: Node[];
}

function isRecord(value: unknown): value is JsonNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True for an object literal, or `Object.create(null)`, of any realm: what a reduction may copy. */
function isPlainObject(value: object): value is Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return (
    prototype === Object.prototype ||
    prototype === null ||
    Object.getPrototypeOf(prototype) === null
  );
}

/** The node a `$ref` names in the document: `#`, or a JSON Pointer into it; `undefined` when it names none. */
function follow(ref: string, root: JsonNode): unknown {
  if (ref === "#") {
    return root;
  }
  if (!ref.startsWith("#/")) {
    return undefined;
  }
  let node: unknown = root;
  for (const raw of ref.slice(2).split("/")) {
    let part: string;
    try {
      part = decodeURIComponent(raw).replaceAll("~1", "/").replaceAll("~0", "~");
    } catch {
      return undefined;
    }
    node = isRecord(node) && Object.hasOwn(node, part) ? node[part] : undefined;
  }
  return node;
}

const BRANCHES = ["anyOf", "oneOf", "allOf"] as const;

function hasAny(node: JsonNode, keywords: readonly string[]): boolean {
  return keywords.some((keyword) => node[keyword] !== undefined);
}

function typesOf(node: JsonNode): readonly unknown[] | undefined {
  const { type } = node;
  if (typeof type === "string") {
    return [type];
  }
  return Array.isArray(type) ? type : undefined;
}

function patternOf(source: string): RegExp | undefined {
  try {
    return new RegExp(source, "u");
  } catch {
    try {
      return new RegExp(source);
    } catch {
      return undefined;
    }
  }
}

/** Every node `nodes` stand for: themselves and, through their members, the schemas they combine. */
function expand(nodes: readonly Node[]): Node[] {
  const seen = new Set<Node>();
  const pending = [...nodes];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (!seen.has(node)) {
      seen.add(node);
      pending.push(...node.members);
    }
  }
  return [...seen];
}

/**
 * Compiles one JSON Schema document: reads it into nodes (each JSON node
 * once, `$ref` cycles included), then builds the shapes calls walk, one per
 * set of nodes a value may meet, merged once.
 */
class Compiler {
  private next = 0;
  private readonly nodes = new Map<unknown, Node>();
  private readonly shapes = new Map<string, Shape>();

  constructor(private readonly root: JsonNode) {}

  private make(any: boolean): Node {
    this.next += 1;
    return { id: this.next, any, object: undefined, array: undefined, members: [] };
  }

  /** The node a JSON Schema value stands for. `true` and absent are any value. */
  read(value: unknown): Node {
    if (value === undefined || value === true) {
      return this.make(true);
    }
    if (!isRecord(value)) {
      // `false` (no value) and anything malformed: a scalar, which keeps no key of an object.
      return this.make(false);
    }
    const known = this.nodes.get(value);
    if (known !== undefined) {
      return known;
    }
    const node = this.make(false);
    this.nodes.set(value, node);
    this.readMembers(node, value);
    this.readParts(node, value);
    return node;
  }

  /** The node's `$ref` target and its `anyOf`, `oneOf` and `allOf` branches. */
  private readMembers(node: Node, json: JsonNode): void {
    const { $ref } = json;
    if (typeof $ref === "string") {
      const target = follow($ref, this.root);
      node.members.push(target === undefined ? this.make(true) : this.read(target));
    }
    for (const keyword of BRANCHES) {
      const members = json[keyword];
      if (!Array.isArray(members)) {
        continue;
      }
      for (const member of members) {
        const read = this.read(member);
        // A part of an `allOf` that allows any value adds nothing to the others.
        if (!(keyword === "allOf" && read.any && members.length > 1)) {
          node.members.push(read);
        }
      }
    }
  }

  /** What the node declares itself: an object, an array, a scalar, or any value. */
  private readParts(node: Node, json: JsonNode): void {
    const types = typesOf(json);
    const combined = node.members.length > 0;
    const objectKeywords = hasAny(json, [
      "properties",
      "patternProperties",
      "additionalProperties",
    ]);
    const arrayKeywords = hasAny(json, ["items", "prefixItems", "additionalItems"]);
    if (objectKeywords) {
      node.object = this.readObject(json);
    } else if (!combined && types?.includes("object") === true) {
      // An object that declares no key, as a record does: every key.
      node.object = { properties: new Map(), patterns: [], additional: this.make(true) };
    }
    if (arrayKeywords) {
      node.array = this.readArray(json);
    } else if (!combined && types?.includes("array") === true) {
      node.array = { prefix: [], rest: this.make(true) };
    }
    const scalar = types !== undefined || hasAny(json, ["const", "enum"]);
    node.any = !combined && !objectKeywords && !arrayKeywords && !scalar;
  }

  private readObject(json: JsonNode): NonNullable<Node["object"]> {
    const properties = new Map<string, Node>();
    if (isRecord(json.properties)) {
      for (const [key, schema] of Object.entries(json.properties)) {
        properties.set(key, this.read(schema));
      }
    }
    const patterns: { regex: RegExp; node: Node }[] = [];
    let open = false;
    if (isRecord(json.patternProperties)) {
      for (const [source, schema] of Object.entries(json.patternProperties)) {
        const regex = patternOf(source);
        if (regex === undefined) {
          open = true;
        } else {
          patterns.push({ regex, node: this.read(schema) });
        }
      }
    }
    const { additionalProperties } = json;
    let additional: Node | undefined;
    if (open) {
      additional = this.make(true);
    } else if (additionalProperties === undefined) {
      // Properties declared and nothing said of the others: the declared keys only.
      additional =
        json.properties === undefined && json.patternProperties === undefined
          ? this.make(true)
          : undefined;
    } else {
      additional = additionalProperties === false ? undefined : this.read(additionalProperties);
    }
    return { properties, patterns, additional };
  }

  private readArray(json: JsonNode): NonNullable<Node["array"]> {
    const { items, prefixItems, additionalItems } = json;
    if (Array.isArray(items)) {
      // draft-07's tuple: `items` by position, `additionalItems` past them.
      return {
        prefix: items.map((item: unknown) => this.read(item)),
        rest: additionalItems === false ? undefined : this.read(additionalItems),
      };
    }
    const prefix = Array.isArray(prefixItems)
      ? prefixItems.map((item: unknown) => this.read(item))
      : [];
    return { prefix, rest: items === false ? undefined : this.read(items) };
  }

  /** The shape of a value any of `nodes` describes. */
  shapeOf(nodes: readonly Node[]): Shape {
    const all = expand(nodes);
    if (all.some((node) => node.any)) {
      return ANY;
    }
    const key = all
      .map((node) => node.id)
      .sort((a, b) => a - b)
      .join(",");
    const known = this.shapes.get(key);
    if (known !== undefined) {
      return known;
    }
    // Registered before its parts are built, so a recursive schema meets itself.
    const shape: Shape = { any: false, object: undefined, array: undefined };
    this.shapes.set(key, shape);
    const objects = all.flatMap((node) => (node.object === undefined ? [] : [node.object]));
    const arrays = all.flatMap((node) => (node.array === undefined ? [] : [node.array]));
    shape.object = objects.length === 0 ? undefined : this.objectShapeOf(objects);
    shape.array = arrays.length === 0 ? undefined : this.arrayShapeOf(arrays);
    return shape;
  }

  private objectShapeOf(objects: readonly NonNullable<Node["object"]>[]): ObjectShape {
    const keys = new Set(objects.flatMap((object) => [...object.properties.keys()]));
    const properties = Object.create(null) as Record<string, Shape>;
    for (const key of keys) {
      const nodes = objects.flatMap((object) => {
        const declared =
          object.properties.get(key) ??
          object.patterns.find(({ regex }) => regex.test(key))?.node ??
          object.additional;
        return declared === undefined ? [] : [declared];
      });
      properties[key] = this.shapeOf(nodes);
    }
    const patterns = objects.flatMap((object) =>
      object.patterns.map(({ regex, node }) => ({ regex, shape: this.shapeOf([node]) })),
    );
    const additional = objects.flatMap((object) =>
      object.additional === undefined ? [] : [object.additional],
    );
    return {
      properties,
      patterns,
      additional: additional.length === 0 ? undefined : this.shapeOf(additional),
    };
  }

  private arrayShapeOf(arrays: readonly NonNullable<Node["array"]>[]): ArrayShape {
    const length = Math.max(...arrays.map((array) => array.prefix.length));
    const at = (index: number): Node[] =>
      arrays.flatMap((array) => {
        const node = index < array.prefix.length ? array.prefix[index] : array.rest;
        return node === undefined ? [] : [node];
      });
    const prefix = Array.from({ length }, (_, index) => this.shapeOf(at(index)));
    const rest = arrays.flatMap((array) => (array.rest === undefined ? [] : [array.rest]));
    return { prefix, rest: rest.length === 0 ? undefined : this.shapeOf(rest) };
  }
}

/** Marks a key or an item a reduction drops. */
const DROPPED: unique symbol = Symbol("dropped");

/** Sets `key` on a copy, `__proto__` too, as an own key. */
function assign(copy: Record<string, unknown>, key: string, value: unknown): void {
  if (key === "__proto__") {
    Object.defineProperty(copy, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  } else {
    copy[key] = value;
  }
}

function shapeOfKey(object: ObjectShape, key: string): Shape | undefined {
  const declared = object.properties[key];
  if (declared !== undefined) {
    return declared;
  }
  for (const { regex, shape } of object.patterns) {
    if (regex.test(key)) {
      return shape;
    }
  }
  return object.additional;
}

/** `item` as `shape` keeps it, or `DROPPED`; a scalar is kept without a call. */
function keep(shape: Shape | undefined, item: unknown): unknown {
  if (shape === undefined) {
    return DROPPED;
  }
  return shape.any || typeof item !== "object" || item === null ? item : reduce(shape, item);
}

function reduceObject(
  object: ObjectShape | undefined,
  value: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const keys = Object.keys(value);
  let copy: Record<string, unknown> | undefined;
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index] as string;
    const item = value[key];
    const kept = keep(object === undefined ? undefined : shapeOfKey(object, key), item);
    if (copy === undefined) {
      if (kept === item) {
        continue;
      }
      copy = {};
      for (let earlier = 0; earlier < index; earlier += 1) {
        const name = keys[earlier] as string;
        assign(copy, name, value[name]);
      }
    }
    if (kept !== DROPPED) {
      assign(copy, key, kept);
    }
  }
  return copy ?? value;
}

function reduceArray(shape: Shape, value: readonly unknown[]): readonly unknown[] {
  const { array } = shape;
  let copy: unknown[] | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const item: unknown = value[index];
    const kept = keep(
      array === undefined ? shape : index < array.prefix.length ? array.prefix[index] : array.rest,
      item,
    );
    if (copy === undefined) {
      if (kept === item) {
        continue;
      }
      copy = value.slice(0, index);
    }
    if (kept !== DROPPED) {
      copy.push(kept);
    }
  }
  return copy ?? value;
}

/** An object `value` as `shape` keeps it. */
function reduce(shape: Shape, value: object): unknown {
  if (Array.isArray(value)) {
    return reduceArray(shape, value);
  }
  return isPlainObject(value) ? reduceObject(shape.object, value) : value;
}

/** Where a shape declares each key it names, at any depth: the shortest path found first. */
function keyPaths(root: Shape): ReadonlyMap<string, string> {
  const paths = new Map<string, string>();
  const seen = new Set<Shape>();
  const queue: { readonly shape: Shape; readonly path: string }[] = [{ shape: root, path: "" }];
  for (let index = 0; index < queue.length; index += 1) {
    const { shape, path } = queue[index] as { readonly shape: Shape; readonly path: string };
    if (seen.has(shape)) {
      continue;
    }
    seen.add(shape);
    if (shape.object !== undefined) {
      for (const [key, child] of Object.entries(shape.object.properties)) {
        if (child === undefined) {
          continue;
        }
        const at = path === "" ? key : `${path}.${key}`;
        if (!paths.has(key)) {
          paths.set(key, at);
        }
        queue.push({ shape: child, path: at });
      }
      for (const { shape: child } of shape.object.patterns) {
        queue.push({ shape: child, path: `${path}{}` });
      }
      if (shape.object.additional !== undefined) {
        queue.push({ shape: shape.object.additional, path: `${path}{}` });
      }
    }
    if (shape.array !== undefined) {
      for (const child of shape.array.prefix) {
        queue.push({ shape: child, path: `${path}[]` });
      }
      if (shape.array.rest !== undefined) {
        queue.push({ shape: shape.array.rest, path: `${path}[]` });
      }
    }
  }
  return paths;
}

/** Writes values JSON Schema has no form for as `{}` (any value), keeping the keys beside them (Zod 4). */
const UNREPRESENTABLE_AS_ANY = Object.freeze({ unrepresentable: "any" });

/**
 * Compiles a method's output schema (see the top of this file), or
 * `undefined` when it has no Standard JSON Schema or cannot write one: such
 * an output is sent as the handler returns it.
 */
export function compileSchemaOutput(schema: StandardSchemaV1): SchemaOutput | undefined {
  if (!hasJsonSchema(schema)) {
    return undefined;
  }
  let json: unknown;
  try {
    json = schema["~standard"].jsonSchema.output({
      target: "draft-07",
      libraryOptions: UNREPRESENTABLE_AS_ANY,
    });
  } catch {
    return undefined;
  }
  if (!isRecord(json)) {
    return undefined;
  }
  const compiler = new Compiler(json);
  const root = compiler.shapeOf([compiler.read(json)]);
  let paths: ReadonlyMap<string, string> | undefined;
  return Object.freeze({
    pick: (value: unknown) => keep(root, value),
    keyPaths: () => (paths ??= keyPaths(root)),
  });
}
