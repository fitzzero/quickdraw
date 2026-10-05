// `createMcpRegistry` (RFC 0003 section 10): the tools of an app's services,
// generated from their contracts, plus the app's own, and one `call` every
// MCP transport uses. It replaces 4.1's `McpRegistry`
// (4.1 `src/server/mcp/McpRegistry.ts:13`), which validated input, checked
// access and ran handlers itself, as whatever user the tool's `userId`
// argument named. Here a method's tool call goes through the dispatcher with
// transport `"mcp"`, so validation, access checks and limits apply exactly as
// for a socket call; the transport says who is calling through `principal`,
// and `context` adds the session's own fields to the handler's `ctx.mcp`.

import { consoleLogger, type Logger } from "../../contract/logger";
import { QuickdrawError } from "../../protocol/errors";
import type { Dispatcher, PrincipalOfServices } from "../dispatcher";
import type { AnyService } from "../service";
import type { AuthenticateResult } from "../transports/auth";
import type { MaybePromise } from "../types";
import { checkCustomTools, runCustomTool, type CustomTool } from "./custom";
import {
  failure,
  fromDispatch,
  openSession,
  sessionRequest,
  settle,
  type McpSession,
  type SessionSettings,
} from "./session";
import { checkUniqueNames, inputOf, planMethodTools, type MethodTool } from "./tools";
import type {
  DescribeToolsOptions,
  McpCallOptions,
  McpCallResult,
  McpContextOfServices,
  McpCustomTool,
  McpRequest,
  McpTool,
  McpToolInputSchema,
} from "./types";

/**
 * Options of {@link createMcpRegistry}. `Tools` are the custom tools' input
 * schema types, one per tool, which type each handler's `arguments`.
 */
export interface McpRegistryOptions<
  S extends readonly AnyService[],
  Tools extends readonly McpToolInputSchema[] = readonly McpToolInputSchema[],
> extends DescribeToolsOptions<S> {
  /** The services whose methods become tools. The dispatcher must serve each of them. */
  readonly services: S;
  /** The dispatcher every method's tool calls through, with transport `"mcp"`. */
  readonly dispatcher: Pick<Dispatcher, "call" | "registry">;
  /**
   * Says who an MCP session or request acts for: a principal, a user id when
   * a bare `{ userId }` is a principal of the app's type, or nothing for an
   * anonymous caller, who may call `"public"` methods and `"public"` custom
   * tools only. A stdio server usually reads a token from its environment;
   * an HTTP request carries one as a bearer token. Throwing fails the call
   * with `UNAUTHENTICATED`. Without it every call is anonymous.
   */
  readonly principal?: (
    request: McpRequest,
  ) => MaybePromise<AuthenticateResult<PrincipalOfServices<S>>>;
  /**
   * The fields handlers see as `ctx.mcp` on calls from this registry, typed
   * by the app's `QuickdrawTypes["mcp"]`: the scopes of the agent's token,
   * for example. Runs per call, after `principal`.
   */
  readonly context?: (
    request: McpRequest,
    principal: PrincipalOfServices<S> | null,
  ) => MaybePromise<McpContextOfServices<S>>;
  /** The app's own tools, listed after the generated ones. */
  readonly customTools?: { readonly [K in keyof Tools]: McpCustomTool<S, Tools[K]> };
  /** Receives tool failures and authentication errors. Default: the console. */
  readonly logger?: Logger;
}

/** The tools an MCP transport serves, and the one way to call them. */
export interface McpRegistry {
  /**
   * Every tool, generated ones first, as `tools/list` and `GET /mcp/tools`
   * return them: the same list for every caller, never filtered by the
   * principal, so an agent may see tools whose calls are refused. A
   * registry's `include`/`exclude` decide the list; serve agents of
   * different reach from separate registries.
   */
  readonly tools: readonly McpTool[];
  /** True when a tool has this name. */
  has(name: string): boolean;
  /**
   * Calls the tool `name` with the client's `args` in the session of
   * `options.request`. Resolves with the tool's value or its failure (an
   * unknown name is `NOT_FOUND`), after `options.respond` was given it.
   * Never rejects.
   */
  call(name: string, args: unknown, options: McpCallOptions): Promise<McpCallResult>;
  /**
   * Calls a method's tool by its service and method name with the method's
   * `input` as it is, without the tool's argument mapping: the shape 4.1's
   * HTTP route took. A method that is not a tool is `NOT_FOUND`.
   */
  callMethod(
    service: string,
    method: string,
    input: unknown,
    options: McpCallOptions,
  ): Promise<McpCallResult>;
}

type Entry =
  | ({ readonly kind: "method" } & MethodTool)
  | ({ readonly kind: "custom" } & CustomTool);

interface RegistrySettings extends SessionSettings {
  /** Every tool by name, in listing order. */
  readonly entries: ReadonlyMap<string, Entry>;
  /** The method tools by {@link methodKey}. */
  readonly methods: ReadonlyMap<string, MethodTool>;
}

type Fail = (message: string) => never;

/** A method's key, unambiguous whatever characters its names hold. */
function methodKey(service: string, method: string): string {
  return `${service}\u0000${method}`;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function checkHook(name: string, hook: unknown, fail: Fail): void {
  if (hook !== undefined && typeof hook !== "function") {
    fail(`${name} must be a function of the MCP request`);
  }
}

/** Fails unless `dispatcher` serves every one of `services`, as the very same service objects. */
function checkDispatcher(dispatcher: unknown, services: unknown, fail: Fail): void {
  if (
    !isRecord(dispatcher) ||
    typeof dispatcher.call !== "function" ||
    !isRecord(dispatcher.registry) ||
    !(dispatcher.registry.services instanceof Map)
  ) {
    fail("dispatcher must be a dispatcher from createDispatcher or qd.createServer");
  }
  if (!Array.isArray(services)) {
    fail("services must be an array of services from qd.defineService");
  }
  const served = dispatcher.registry.services as ReadonlyMap<string, unknown>;
  for (const service of services) {
    const name: unknown = isRecord(service) ? service.name : undefined;
    if (typeof name !== "string" || served.get(name) !== service) {
      fail(
        `the dispatcher does not serve ${typeof name === "string" ? name : "one of the services"}; pass services the dispatcher was created with`,
      );
    }
  }
}

function resolveRegistry(options: McpRegistryOptions<readonly AnyService[]>): RegistrySettings {
  const fail: Fail = (message) => {
    throw new TypeError(`createMcpRegistry: ${message}`);
  };
  if (!isRecord(options)) {
    fail("options must be an object with services and dispatcher");
  }
  checkDispatcher(options.dispatcher, options.services, fail);
  checkHook("principal", options.principal, fail);
  checkHook("context", options.context, fail);
  const methodTools = planMethodTools(options.services, options, fail);
  const customTools = checkCustomTools(options.customTools, fail);
  const entries: Entry[] = [
    ...methodTools.map((tool) => ({ kind: "method" as const, ...tool })),
    ...customTools.map((tool) => ({ kind: "custom" as const, ...tool })),
  ];
  checkUniqueNames(
    entries.map((entry) => ({
      tool: entry.tool,
      owner: entry.kind === "method" ? `${entry.service}.${entry.method}` : "a custom tool",
    })),
    fail,
  );
  return {
    dispatcher: options.dispatcher,
    principal: options.principal,
    context: options.context as SessionSettings["context"],
    logger: options.logger ?? consoleLogger,
    entries: new Map(entries.map((entry) => [entry.tool.name, entry])),
    methods: new Map(methodTools.map((tool) => [methodKey(tool.service, tool.method), tool])),
  };
}

/** Runs `run` in the session of `options.request`, or fails the call when the session cannot open. */
async function inSession(
  settings: RegistrySettings,
  name: string,
  options: McpCallOptions,
  run: (session: McpSession) => Promise<McpCallResult>,
): Promise<McpCallResult> {
  let session: McpSession;
  try {
    session = await openSession(settings, options.request);
  } catch (error) {
    return settle(settings, options, failure(settings, error, name));
  }
  return run(session);
}

/** Calls a method through the dispatcher, which hands the result to `respond` before it flushes. */
async function dispatchMethod(
  settings: RegistrySettings,
  tool: MethodTool,
  input: unknown,
  session: McpSession,
  options: McpCallOptions,
): Promise<McpCallResult> {
  const { respond } = options;
  const request = sessionRequest(session, {
    service: tool.service,
    method: tool.method,
    input,
    signal: options.signal,
    respond: respond === undefined ? undefined : (result) => respond(fromDispatch(result)),
  });
  return fromDispatch(await settings.dispatcher.call(request));
}

function callTool(
  settings: RegistrySettings,
  name: string,
  args: unknown,
  options: McpCallOptions,
): Promise<McpCallResult> {
  const entry = settings.entries.get(name);
  if (entry === undefined) {
    const error = new QuickdrawError("NOT_FOUND", `Unknown tool "${name}"`);
    return Promise.resolve(settle(settings, options, { ok: false, error }));
  }
  if (entry.kind === "method") {
    const input = inputOf(entry.mode, args);
    return inSession(settings, name, options, (session) =>
      dispatchMethod(settings, entry, input, session, options),
    );
  }
  return inSession(settings, name, options, async (session) =>
    settle(settings, options, await runCustomTool(settings, entry, args, session, options)),
  );
}

function callMethodTool(
  settings: RegistrySettings,
  service: string,
  method: string,
  input: unknown,
  options: McpCallOptions,
): Promise<McpCallResult> {
  const tool = settings.methods.get(methodKey(service, method));
  if (tool === undefined) {
    const error = new QuickdrawError("NOT_FOUND", `${service}.${method} is not an MCP tool`);
    return Promise.resolve(settle(settings, options, { ok: false, error }));
  }
  return inSession(settings, tool.tool.name, options, (session) =>
    dispatchMethod(settings, tool, input, session, options),
  );
}

/**
 * Builds the MCP tools of `services` (see `describeTools`) and the app's
 * `customTools`, served by `dispatcher`. Throws at once when a method's
 * input schema cannot describe itself as JSON Schema (use Zod 4.2 or later
 * for it, or `exclude` the method), when two tools share a name, or when the
 * dispatcher does not serve one of the services.
 *
 * @example
 * const registry = createMcpRegistry({
 *   services: [taskService, projectService],
 *   dispatcher: server.dispatcher,
 *   principal: (request) => verifyAgentToken(request.transport === "http" ? request.token : process.env.AGENT_TOKEN),
 *   context: (request) => ({ scopes: scopesOf(request) }),
 * });
 */
export function createMcpRegistry<
  const S extends readonly AnyService[],
  const Tools extends readonly McpToolInputSchema[] = [],
>(options: McpRegistryOptions<S, Tools>): McpRegistry {
  const settings = resolveRegistry(options as unknown as McpRegistryOptions<readonly AnyService[]>);
  const tools = Object.freeze([...settings.entries.values()].map((entry) => entry.tool));
  return Object.freeze({
    tools,
    has: (name: string) => settings.entries.has(name),
    call: (name: string, args: unknown, callOptions: McpCallOptions) =>
      callTool(settings, name, args, callOptions),
    callMethod: (service: string, method: string, input: unknown, callOptions: McpCallOptions) =>
      callMethodTool(settings, service, method, input, callOptions),
  });
}
