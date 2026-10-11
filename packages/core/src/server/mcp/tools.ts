// Tools from contracts (RFC 0003 section 10): one tool per method, made when
// the registry is built, from what the contract already holds: the input
// schema, the kind and the `describe` text. 4.1 wrote tool metadata ahead of
// time by parsing service source files with regular expressions
// (4.1 `src/server/mcp/generateToolMetadata.ts:255`); nothing is generated
// ahead of time here.
//
// A tool's `inputSchema` is the method input's Standard JSON Schema (Zod 4.2
// or later), drafted as JSON Schema draft-07, the dialect MCP clients of the
// 2024-11-05 protocol read. MCP tool arguments are always an object, so:
//
// - an object input is the arguments themselves;
// - an input with no JSON Schema form that accepts `undefined`
//   (`z.undefined()`, `z.void()`) is a tool without arguments;
// - any other input (a string, a union) is the `input` argument.
//
// An input whose JSON Schema is a `$ref` to an object (a Zod schema with
// `.meta({ id })`) counts as that object: its definition is inlined at the
// root. A wrapped input keeps its `definitions` at the root of the tool's
// schema, where its `$ref`s resolve for the client.
//
// A registry's `bind` names arguments it fills from the principal: they are
// left out of the `inputSchema` of each object input that has them, and may
// not appear anywhere else in an input, behind a `$ref` or in any `anyOf`,
// `oneOf` or `allOf` branch (`inputKeys`), where they could not be filled.

import type { MethodKind } from "../../contract/methods";
import { defaultToolName } from "../../contract/toolName";
import {
  hasJsonSchema,
  type StandardSchemaV1,
  type StandardSchemaWithJSON,
} from "../../contract/standardSchema";
import { inputKeys, referenced } from "../emit/projection";
import type { AnyService } from "../service";
import type { DescribeToolsOptions, McpInputSchema, McpTool } from "./types";

/** How a tool's arguments become its input. */
export type ArgumentsMode = "object" | "wrapped" | "none";

/** A tool's argument schema, and how its arguments become the input. */
export interface ToolInput {
  readonly schema: McpInputSchema;
  readonly mode: ArgumentsMode;
}

/** A method's tool, with the method it calls. */
export interface MethodTool extends ToolInput {
  readonly tool: McpTool;
  readonly service: string;
  readonly method: string;
  /** The arguments the registry's `bind` fills, which `tool.inputSchema` leaves out. */
  readonly bound: readonly string[];
}

type Fail = (message: string) => never;

const JSON_SCHEMA_TARGET = "draft-07";

const NO_ARGUMENTS: McpInputSchema = Object.freeze({
  type: "object",
  properties: Object.freeze({}),
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when the schema accepts `undefined` without awaiting anything. */
function acceptsUndefined(schema: StandardSchemaV1): boolean {
  try {
    const result: unknown = schema["~standard"].validate(undefined);
    return isRecord(result) && typeof result.then !== "function" && result.issues === undefined;
  } catch {
    return false;
  }
}

/** The JSON Schema of a schema's input, or why the schema could not write one. */
function draftJsonSchema(schema: StandardSchemaWithJSON): Record<string, unknown> | Error {
  try {
    const json: unknown = schema["~standard"].jsonSchema.input({ target: JSON_SCHEMA_TARGET });
    return isRecord(json) ? json : new Error("the schema did not return an object");
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * The argument schema of a tool whose input is `schema`, and how its
 * arguments become that input. Fails when the schema cannot describe itself
 * as JSON Schema, naming `label` (what the tool calls) and the fix; `instead`
 * is the other way out. A method can be left out with `exclude`.
 */
export function toolInputOf(
  label: string,
  schema: StandardSchemaV1,
  fail: Fail,
  instead = `leave ${label} out with exclude`,
): ToolInput {
  if (!hasJsonSchema(schema)) {
    fail(
      `the input schema of ${label} cannot describe itself as JSON Schema, which an MCP tool needs: use Zod 4.2 or later for that schema, or ${instead}`,
    );
  }
  const json = draftJsonSchema(schema);
  if (json instanceof Error) {
    if (acceptsUndefined(schema)) {
      return { schema: NO_ARGUMENTS, mode: "none" };
    }
    fail(
      `the input schema of ${label} cannot be written as JSON Schema (${json.message}): change that schema, or ${instead}`,
    );
  }
  const described = referenced(json, json);
  if (described?.type === "object") {
    return { schema: inlined(json, described) as McpInputSchema, mode: "object" };
  }
  const { $schema: dialect, definitions, $defs, ...input } = json;
  return {
    schema: {
      ...(dialect === undefined ? {} : { $schema: dialect }),
      type: "object",
      properties: { input },
      ...(acceptsUndefined(schema) ? {} : { required: ["input"] }),
      ...(definitions === undefined ? {} : { definitions }),
      ...($defs === undefined ? {} : { $defs }),
    },
    mode: "wrapped",
  };
}

/** True when `value` holds a `$ref` to `ref` anywhere inside it. */
function refersTo(value: unknown, ref: string): boolean {
  if (Array.isArray(value)) {
    return value.some((item) => refersTo(item, ref));
  }
  if (!isRecord(value)) {
    return false;
  }
  return value.$ref === ref || Object.values(value).some((item) => refersTo(item, ref));
}

/**
 * The object schema a root `$ref` names, inlined at the root (Zod writes an
 * id'd schema as `{ $schema, $ref: "#/definitions/<id>", definitions }`):
 * the root's dialect and definitions beside the target's keywords, without
 * the target's own definition unless something still refers to it.
 */
function inlined(
  json: Readonly<Record<string, unknown>>,
  target: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (target === json) {
    return json;
  }
  const ref = String(json.$ref);
  const { $schema: dialect } = json;
  const schema: Record<string, unknown> = {
    ...(dialect === undefined ? {} : { $schema: dialect }),
    ...target,
  };
  for (const keyword of ["definitions", "$defs"]) {
    const defs = json[keyword];
    if (!isRecord(defs)) {
      continue;
    }
    const others = Object.fromEntries(
      Object.entries(defs).filter(([name]) => `#/${keyword}/${name}` !== ref),
    );
    // The target's own entry stays only for a schema that still refers to it (a recursive one).
    const kept = refersTo({ ...schema, [keyword]: others }, ref) ? defs : others;
    if (Object.keys(kept).length > 0) {
      schema[keyword] = kept;
    }
  }
  return schema;
}

/** The input a call passes to a tool's handler or method, from the tool's arguments. */
export function inputOf(mode: ArgumentsMode, args: unknown): unknown {
  if (mode === "object") {
    return args ?? {};
  }
  return mode === "wrapped" && isRecord(args) ? args.input : undefined;
}

/** Whether a method is selected by `include` and `exclude`, after checking every reference names one. */
function selector(
  services: readonly AnyService[],
  options: DescribeToolsOptions,
  fail: Fail,
): (service: string, method: string) => boolean {
  const known = new Set<string>();
  for (const service of services) {
    known.add(service.name);
    for (const method of Object.keys(service.contract.methods)) {
      known.add(`${service.name}.${method}`);
    }
  }
  const refs = (key: "include" | "exclude"): ReadonlySet<string> | undefined => {
    const list: unknown = options[key];
    if (list === undefined) {
      return undefined;
    }
    if (!Array.isArray(list) || !list.every((ref) => typeof ref === "string")) {
      fail(`${key} must be a list of "service" and "service.method" names`);
    }
    const unknownRef = list.find((ref) => !known.has(ref));
    if (unknownRef !== undefined) {
      fail(`${key} names "${unknownRef}", which is not a service or method being served`);
    }
    return new Set(list);
  };
  const include = refs("include");
  const exclude = refs("exclude");
  const names = (set: ReadonlySet<string>, service: string, method: string): boolean =>
    set.has(service) || set.has(`${service}.${method}`);
  return (service, method) =>
    (include === undefined || names(include, service, method)) &&
    (exclude === undefined || !names(exclude, service, method));
}

/** The function that names a method's tool: the `name` option, checked, or `{service}_{method}`. */
function toolNamer(
  options: DescribeToolsOptions,
  fail: Fail,
): (service: string, method: string) => string {
  const { name } = options;
  if (name !== undefined && typeof name !== "function") {
    fail("name must be a function of (service, method)");
  }
  return (service, method) => {
    const named: unknown =
      name === undefined ? defaultToolName(service, method) : name(service, method);
    if (typeof named !== "string" || named === "") {
      const shown = typeof named === "string" ? `""` : String(named);
      fail(`name returned ${shown} for ${service}.${method}; a tool name is a non-empty string`);
    }
    return named;
  };
}

function describeMethod(service: string, method: string, kind: MethodKind, text: unknown): string {
  return typeof text === "string" && text !== "" ? text : `${service}.${method} (${kind})`;
}

function propertiesOf(schema: unknown): string[] {
  return isRecord(schema) && isRecord(schema.properties) ? Object.keys(schema.properties) : [];
}

/**
 * The arguments of `bind` that are properties of the object input of
 * `label`. Fails when one of them is a key the input `schema` may have
 * anywhere else (`inputKeys`: behind a `$ref`, in an `anyOf`, `oneOf` or
 * `allOf` branch, or the input is not an object), where it cannot be
 * filled. An input without arguments has none.
 */
function boundArguments(
  label: string,
  input: ToolInput,
  schema: StandardSchemaV1,
  bind: readonly string[],
  fail: Fail,
): string[] {
  if (bind.length === 0) {
    return [];
  }
  const bindable = input.mode === "object" ? propertiesOf(input.schema) : [];
  const keys = inputKeys(schema) ?? [];
  const misplaced = bind.find((key) => keys.includes(key) && !bindable.includes(key));
  if (misplaced !== undefined) {
    fail(
      `bind.${misplaced} names a property of the input of ${label}, which is not an object: bind fills properties of object inputs only; leave ${label} out with exclude, or make its input an object`,
    );
  }
  return bind.filter((key) => bindable.includes(key));
}

/** An object input's schema without the bound arguments, as the tool lists it. */
function withoutArguments(schema: McpInputSchema, bound: readonly string[]): McpInputSchema {
  const kept = (key: string) => !bound.includes(key);
  const { properties = {}, required, ...rest } = schema;
  const stillRequired = required?.filter(kept) ?? [];
  return {
    ...rest,
    properties: Object.fromEntries(Object.entries(properties).filter(([key]) => kept(key))),
    ...(stillRequired.length === 0 ? {} : { required: stillRequired }),
  };
}

/**
 * The method tools of `services`, in service order and then contract order,
 * with what each calls. Fails on a reference, name or schema that cannot
 * make a tool; `fail` prefixes the message with the caller's name. `bind`
 * names the arguments a registry fills from the principal.
 */
export function planMethodTools(
  services: readonly AnyService[],
  options: DescribeToolsOptions,
  fail: Fail,
  bind: readonly string[] = [],
): MethodTool[] {
  const given: unknown = services;
  if (!Array.isArray(given)) {
    fail("services must be an array of services from qd.defineService");
  }
  const selected = selector(services, options, fail);
  const toolName = toolNamer(options, fail);
  const planned: MethodTool[] = [];
  for (const service of services) {
    for (const [method, def] of Object.entries(service.contract.methods)) {
      if (!selected(service.name, method)) {
        continue;
      }
      const label = `${service.name}.${method}`;
      const input = toolInputOf(label, def.input, fail);
      const bound = boundArguments(label, input, def.input, bind, fail);
      const tool: McpTool = {
        name: toolName(service.name, method),
        description: describeMethod(service.name, method, def.kind, def.describe),
        inputSchema: bound.length === 0 ? input.schema : withoutArguments(input.schema, bound),
        ...(def.kind === "query" ? { annotations: { readOnlyHint: true } } : {}),
      };
      planned.push({ ...input, tool: Object.freeze(tool), service: service.name, method, bound });
    }
  }
  return planned;
}

/** Fails when two tools share a name. `owners` names what each tool comes from, for the message. */
export function checkUniqueNames(
  tools: readonly { readonly tool: McpTool; readonly owner: string }[],
  fail: Fail,
): void {
  const seen = new Map<string, string>();
  for (const { tool, owner } of tools) {
    const first = seen.get(tool.name);
    if (first !== undefined) {
      fail(`two tools are named "${tool.name}": ${first} and ${owner}`);
    }
    seen.set(tool.name, owner);
  }
}

/**
 * The MCP tools of `services`: one per contract method, named
 * `{service}_{method}` unless `name` says otherwise, described by the
 * method's `describe` text, with the input schema's JSON Schema as
 * `inputSchema` and `readOnlyHint` on every query. Throws when a method's
 * input schema cannot describe itself as JSON Schema (use Zod 4.2 or later),
 * when `include` or `exclude` names something that is not served, and when
 * two tools would share a name.
 *
 * @example
 * describeTools([taskService], { exclude: ["taskService.purge"] });
 */
export function describeTools<const S extends readonly AnyService[]>(
  services: S,
  options: DescribeToolsOptions<S> = {},
): McpTool[] {
  const fail: Fail = (message) => {
    throw new TypeError(`describeTools: ${message}`);
  };
  const planned = planMethodTools(services, options as DescribeToolsOptions, fail);
  checkUniqueNames(
    planned.map((entry) => ({ tool: entry.tool, owner: `${entry.service}.${entry.method}` })),
    fail,
  );
  return planned.map((entry) => entry.tool);
}
