// Custom tools (RFC 0003 section 10): an app's own tools, served beside the
// ones generated from contracts. 4.1's registry had no hook for them
// (4.1 `src/server/mcp/McpRegistry.ts:13`), so apps that needed one ran a
// bridge of their own. A custom tool fails closed like a method: unless it
// declares `access: "public"`, an anonymous caller is refused before anything
// runs, and a principal of a kind the tool does not admit (its `kinds`,
// within the app's `initQuickdraw({ kinds })`, which it admits by default)
// is refused too (`FORBIDDEN`, the 5.1 audit's MCP-6). A custom tool that
// gives a Standard Schema has its arguments validated before its handler
// runs, as a method's input is, and every handler gets a caller that acts in
// the same session.

import { isStandardSchema, type StandardSchemaV1 } from "../../contract/standardSchema";
import { QuickdrawError } from "../../protocol/errors";
import { checkKind, narrowKinds } from "../access/kinds";
import { NEVER_ABORTED } from "../context";
import { parseInput } from "../pipeline/validation";
import { runtimeOf, type AnyService } from "../service";
import { failure, sessionCaller, type McpSession, type SessionSettings } from "./session";
import { inputOf, toolInputOf, type ArgumentsMode, type ToolInput } from "./tools";
import type {
  McpCallOptions,
  McpCallResult,
  McpInputSchema,
  McpTool,
  McpToolAccess,
  McpToolCall,
} from "./types";

/** A checked custom tool. */
export interface CustomTool {
  readonly tool: McpTool;
  /** Who may call it; `"authenticated"` unless the tool said otherwise. */
  readonly access: McpToolAccess;
  /** The kinds of principal that may call it: its own, or the app's; `undefined` admits every kind. */
  readonly kinds: readonly string[] | undefined;
  readonly mode: ArgumentsMode;
  /** The schema that validates the arguments, when the tool gave a Standard Schema. */
  readonly schema: StandardSchemaV1 | undefined;
  readonly handler: (call: McpToolCall) => unknown;
}

type Fail = (message: string) => never;

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function argumentsOf(owner: string, inputSchema: unknown, fail: Fail): ToolInput {
  if (isStandardSchema(inputSchema)) {
    return toolInputOf(owner, inputSchema, fail, "give the tool a JSON Schema object instead");
  }
  if (isRecord(inputSchema) && inputSchema.type === "object") {
    return { schema: inputSchema as McpInputSchema, mode: "object" };
  }
  return fail(
    `${owner}: inputSchema must be a Standard Schema, or a JSON Schema whose type is "object"`,
  );
}

function accessOf(owner: string, access: unknown, fail: Fail): McpToolAccess {
  if (access === undefined) {
    return "authenticated";
  }
  if (access !== "public" && access !== "authenticated") {
    fail(`${owner}: access must be "public" or "authenticated"`);
  }
  return access;
}

/**
 * The kinds every one of `services` admits: what their apps'
 * `initQuickdraw({ kinds })` admit, in common; `undefined` admits every kind.
 */
function appKindsOf(services: readonly AnyService[]): readonly string[] | undefined {
  let kinds: readonly string[] | undefined;
  for (const service of services) {
    const own = runtimeOf(service)?.kinds;
    if (own !== undefined) {
      kinds = kinds === undefined ? own : kinds.filter((kind) => own.includes(kind));
    }
  }
  return kinds;
}

function kindsOf(
  owner: string,
  value: Readonly<Record<string, unknown>>,
  access: McpToolAccess,
  appKinds: readonly string[] | undefined,
  fail: Fail,
): readonly string[] | undefined {
  if (value.kinds !== undefined && access === "public") {
    fail(
      `${owner}: a "public" tool takes no kinds of its own, since a caller of a refused kind could call it signed out; give it access "authenticated"`,
    );
  }
  const above = appKinds === undefined ? undefined : { kinds: appKinds, by: "initQuickdraw" };
  return narrowKinds(value.kinds, above, (message) => fail(`${owner}: ${message}`));
}

function checkCustomTool(
  value: unknown,
  index: number,
  appKinds: readonly string[] | undefined,
  fail: Fail,
): CustomTool {
  if (!isRecord(value)) {
    fail(`customTools[${index}] must be { name, description, inputSchema, handler }`);
  }
  const { name, description, inputSchema, annotations, handler } = value;
  if (typeof name !== "string" || name === "") {
    fail(`customTools[${index}] needs a name, a non-empty string`);
  }
  const owner = `custom tool "${name}"`;
  if (typeof description !== "string" || description === "") {
    fail(`${owner} needs a description, a non-empty string`);
  }
  if (typeof handler !== "function") {
    fail(`${owner} needs a handler function`);
  }
  if (annotations !== undefined && !isRecord(annotations)) {
    fail(`${owner}: annotations must be an object of hints`);
  }
  const access = accessOf(owner, value.access, fail);
  const kinds = kindsOf(owner, value, access, appKinds, fail);
  const input = argumentsOf(owner, inputSchema, fail);
  const tool: McpTool = {
    name,
    description,
    inputSchema: input.schema,
    ...(annotations === undefined ? {} : { annotations }),
  };
  return {
    tool: Object.freeze(tool),
    access,
    kinds,
    mode: input.mode,
    schema: isStandardSchema(inputSchema) ? inputSchema : undefined,
    handler: handler as CustomTool["handler"],
  };
}

/** Checks the registry's `customTools` option, served beside `services`, whose apps' kinds they narrow. */
export function checkCustomTools(
  value: unknown,
  fail: Fail,
  services: readonly AnyService[] = [],
): CustomTool[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    fail("customTools must be an array of { name, description, inputSchema, handler }");
  }
  const appKinds = appKindsOf(services);
  return value.map((tool: unknown, index) => checkCustomTool(tool, index, appKinds, fail));
}

/**
 * Runs a custom tool with the arguments `args` in `session`: refuses an
 * anonymous caller unless the tool's access is `"public"`
 * (`UNAUTHENTICATED`) and a principal of a kind it does not admit
 * (`FORBIDDEN`), validates the arguments when the tool gave a Standard
 * Schema (`VALIDATION` with the issues otherwise), then runs the handler.
 * Never rejects.
 */
export async function runCustomTool(
  settings: SessionSettings,
  custom: CustomTool,
  args: unknown,
  session: McpSession,
  options: McpCallOptions,
): Promise<McpCallResult> {
  const { name } = custom.tool;
  const signal = options.signal ?? NEVER_ABORTED;
  try {
    if (custom.access === "authenticated" && session.principal === null) {
      throw new QuickdrawError("UNAUTHENTICATED", "Authentication required");
    }
    checkKind(custom.kinds, session.principal, `The tool "${name}"`);
    const input = inputOf(custom.mode, args);
    const parsed =
      custom.schema === undefined
        ? input
        : await parseInput(custom.schema, input, `the tool "${name}"`);
    const data: unknown = await custom.handler({
      arguments: parsed,
      principal: session.principal,
      mcp: session.mcp,
      caller: sessionCaller(settings, session, signal) as McpToolCall["caller"],
      signal,
      request: options.request,
    });
    return { ok: true, data };
  } catch (error) {
    return failure(settings, error, name);
  }
}
