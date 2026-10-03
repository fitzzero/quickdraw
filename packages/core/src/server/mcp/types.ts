// The shapes the MCP bridge works in (RFC 0003 section 10): tools as
// `tools/list` lists them, the session or request a call arrives on, custom
// tools, and how a call ends. The wire format stays as 4.1 implements it
// (protocol version 2024-11-05, `legacy-src/server/mcp/McpStdioServer.ts:22`).
// What changed is where tools come from: one per contract method, generated
// at run time, instead of one per service whose arguments were
// `{ method, payload, userId }` (`legacy-src/server/mcp/McpRegistry.ts:297-328`).

import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { MethodName } from "../../contract/infer";
import type { StandardSchemaV1 } from "../../contract/standardSchema";
import type { QuickdrawError } from "../../protocol/errors";
import type { Caller } from "../caller";
import type { ContractOfServices, PrincipalOfServices } from "../dispatcher";
import type { AnyService } from "../service";
import type { McpContext, McpContextOf } from "../types";

/** The JSON Schema of a tool's arguments. MCP requires an object schema. */
export interface McpInputSchema {
  readonly type: "object";
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly required?: readonly string[];
  readonly [keyword: string]: unknown;
}

/** MCP's hints about how a tool behaves. Clients treat them as hints, never as guarantees. */
export interface McpToolAnnotations {
  readonly title?: string;
  /** The tool changes nothing. Every query's tool sets it. */
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

/** One tool, as `tools/list` lists it. */
export interface McpTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: McpInputSchema;
  readonly annotations?: McpToolAnnotations;
}

type MethodRefOf<Svc> = Svc extends AnyService
  ? Svc["name"] | `${Svc["name"]}.${MethodName<Svc["contract"]>}`
  : never;

/** A service (`"taskService"`) or one of its methods (`"taskService.get"`). */
export type McpMethodRef<S extends readonly AnyService[]> = MethodRefOf<S[number]>;

/** Which methods become tools, and what each tool is called. */
export interface DescribeToolsOptions<S extends readonly AnyService[] = readonly AnyService[]> {
  /** Only these services and methods become tools. Default: every method of every service. */
  readonly include?: readonly McpMethodRef<S>[];
  /** These services and methods never become tools, even when `include` names them. */
  readonly exclude?: readonly McpMethodRef<S>[];
  /**
   * Names a method's tool. Default `{service}_{method}`, for example
   * `taskService_get`. Each name must be unique among the tools.
   */
  readonly name?: (service: string, method: string) => string;
}

/** What a stdio session stands for: one per stdio server, for as long as it runs. */
export interface McpStdioRequest {
  readonly transport: "stdio";
  /** The session's id. Every call of the server carries the same one. */
  readonly sessionId: string;
}

/** What one request to the MCP HTTP routes stands for. Each request is a session of its own. */
export interface McpHttpRequest {
  readonly transport: "http";
  readonly sessionId: string;
  /** The token of the request's `Authorization: Bearer` header, or `null` without one. */
  readonly token: string | null;
  readonly headers: IncomingHttpHeaders;
  readonly req: IncomingMessage;
}

/** The session or request a tool call arrives on, as the registry's `principal` and `context` see it. */
export type McpRequest = McpStdioRequest | McpHttpRequest;

/** The type of `ctx.mcp` for the services of `S`: their app's `QuickdrawTypes["mcp"]`. */
export type McpContextOfServices<S extends readonly AnyService[]> = [S[number]] extends [never]
  ? McpContext
  : McpContextOf<NonNullable<S[number]["~types"]>>;

/** How a tool call ended: what the tool returned, or why it failed. */
export type McpCallResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: QuickdrawError };

/** One block of a tool result's content. The bridge only sends text. */
export interface McpTextContent {
  readonly type: "text";
  readonly text: string;
}

/**
 * The result of `tools/call`: the tool's value as JSON text, or with
 * `isError` the error's `{ code, message, data? }` as JSON text.
 */
export interface McpToolResult {
  readonly content: readonly McpTextContent[];
  readonly isError?: boolean;
}

/** How one tool call is made, and where its result goes. */
export interface McpCallOptions {
  /** The session or request the call arrived on. */
  readonly request: McpRequest;
  /** Cancels the call. Only queries stop early; a mutation runs to its end. */
  readonly signal?: AbortSignal;
  /**
   * Sends the result to the client as soon as it is ready, before the call's
   * writes flush, and returns the reply's size in bytes when it was measured.
   * Called once per call.
   */
  readonly respond?: (result: McpCallResult) => number | undefined;
}

/** What a custom tool's handler receives. */
export interface McpToolCall<S extends readonly AnyService[] = readonly AnyService[]> {
  /**
   * The arguments: what `inputSchema` produced when it is a Standard Schema,
   * or the arguments object as the client sent it when it is a JSON Schema.
   */
  readonly arguments: unknown;
  /**
   * Who the call acts for, from the registry's `principal`. `null` only for
   * an anonymous caller of a tool with `access: "public"`.
   */
  readonly principal: PrincipalOfServices<S> | null;
  /** The fields the registry's `context` produced for the call, if any. */
  readonly mcp: McpContextOfServices<S> | undefined;
  /**
   * Calls the services as this principal, in this session, through the
   * dispatcher with transport `"mcp"`: handlers see the same `ctx.mcp`.
   */
  readonly caller: Caller<ContractOfServices<S>>;
  /** Aborts when the client cancels the call or the session ends. */
  readonly signal: AbortSignal;
  readonly request: McpRequest;
}

/**
 * Who may call a custom tool: `"authenticated"` callers only, or `"public"`,
 * anonymous callers too. These are the two method access forms that need no
 * service or row.
 */
export type McpToolAccess = "public" | "authenticated";

/** An app's own tool, served beside the tools generated from contracts. */
export interface McpCustomTool<S extends readonly AnyService[] = readonly AnyService[]> {
  readonly name: string;
  readonly description: string;
  /**
   * Who may call the tool. Default `"authenticated"`: a caller the registry's
   * `principal` maps to no one fails with `UNAUTHENTICATED` before the
   * arguments are read or the handler runs, as a method's tool fails closed.
   * `"public"` lets anonymous callers in, with `principal: null`.
   */
  readonly access?: McpToolAccess;
  /**
   * The tool's arguments. A Standard Schema that can describe itself as JSON
   * Schema (Zod 4.2 or later) validates them before the handler runs; a JSON
   * Schema object is listed as it is, and the handler checks the arguments.
   */
  readonly inputSchema: StandardSchemaV1 | McpInputSchema;
  readonly annotations?: McpToolAnnotations;
  /**
   * Runs the tool; its value is the result. Throw a `QuickdrawError` to fail
   * with its code; anything else fails as `INTERNAL`.
   */
  readonly handler: (call: McpToolCall<S>) => unknown;
}
