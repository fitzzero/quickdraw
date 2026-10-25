// The JSON-RPC 2.0 core of the MCP transports (RFC 0003 section 10), taken
// out of the stdio server, which kept 4.1's wire format
// (4.1 `src/server/mcp/McpStdioServer.ts:22`): what a message is, and the
// answer to each request of a tools server, `initialize`, `ping`,
// `tools/list`, and `tools/call` through `registry.call`, with JSON-RPC's
// error codes for the rest:
//
// - a message that is no object, that has no `method` and is no response,
//   or whose `id` is neither a string nor a number is an invalid request
//   (-32600); a response from the client is never answered (answering it
//   could loop), nor is a notification;
// - an unknown method is -32601, and a `tools/call` that names no tool of
//   the registry -32602;
// - a tool call's failure is a tool result with `isError` whose text carries
//   the error's code, never a JSON-RPC error.
//
// The stdio server (`stdio.ts`) and the Streamable HTTP endpoint
// (`streamable.ts`) each give the core a peer: how a response leaves, which
// protocol version `initialize` answers, how a tool call runs and is
// cancelled, and what a notification does. Each parses the JSON itself, and
// answers what is not JSON with -32700.

import type { Logger } from "../../contract/logger";
import { INTERNAL_MESSAGE, QuickdrawError } from "../../protocol/errors";
import { describeError } from "../pipeline/metrics";
import type { McpRegistry } from "./registry";
import { toToolResult } from "./result";
import type { McpCallResult } from "./types";

/** Invalid JSON. */
export const PARSE_ERROR = -32700;
/** A message that is no valid JSON-RPC message. */
export const INVALID_REQUEST = -32600;
/** A method the server does not have. */
export const METHOD_NOT_FOUND = -32601;
/** A method's params it cannot take. */
export const INVALID_PARAMS = -32602;

/** MCP request ids are strings or numbers, never `null`. */
export type RequestId = string | number;

/** A JSON-RPC response: a request's result, or an error, whose id is `null` when the request's could not be read. */
export type JsonRpcResponse =
  | { readonly jsonrpc: "2.0"; readonly id: RequestId; readonly result: unknown }
  | {
      readonly jsonrpc: "2.0";
      readonly id: RequestId | null;
      readonly error: { readonly code: number; readonly message: string };
    };

/** A request: a message with a method and an id, which gets one response. */
export interface JsonRpcRequest {
  readonly kind: "request";
  readonly id: RequestId;
  readonly method: string;
  readonly params: unknown;
}

/** One message a client sent, as the core reads it. */
export type JsonRpcMessage =
  | JsonRpcRequest
  | { readonly kind: "notification"; readonly method: string; readonly params: unknown }
  | { readonly kind: "response" }
  | { readonly kind: "invalid"; readonly id: RequestId | null };

/** What a transport gives the core to answer its messages with. */
export interface JsonRpcPeer {
  readonly registry: McpRegistry;
  /** `initialize`'s `serverInfo`. */
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly logger: Logger;
  /** The protocol version `initialize` answers a client that asks for `requested`. */
  readonly protocolVersion: (requested: unknown) => string;
  /** Sends one response; returns its size in bytes, when it was measured. */
  readonly send: (response: JsonRpcResponse) => number | undefined;
  /**
   * Calls the tool a `tools/call` request names, once its params were
   * checked and the registry has the tool: `registry.call` with the
   * transport's request and signal, sending the result `toolResponse`
   * makes of it.
   */
  readonly callTool: (id: RequestId, name: string, args: unknown) => Promise<void>;
  /** Acts on a notification. Without it, notifications do nothing. */
  readonly notify?: (method: string, params: unknown) => void;
}

const CATEGORY = "quickdraw.mcp";

const INTERNAL_FAILURE: McpCallResult = Object.freeze({
  ok: false,
  error: new QuickdrawError("INTERNAL", INTERNAL_MESSAGE),
});

export function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** MCP request ids are strings or numbers, never `null`. */
export function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** What one parsed message is. Only its own fields are read, never what `params` holds. */
export function classify(message: unknown): JsonRpcMessage {
  if (!isRecord(message)) {
    return { kind: "invalid", id: null };
  }
  const { id, method, params } = message;
  if (typeof method !== "string") {
    // A response to a request this server never sends: answering it could loop.
    return "result" in message || "error" in message
      ? { kind: "response" }
      : { kind: "invalid", id: isRequestId(id) ? id : null };
  }
  if (id === undefined) {
    return { kind: "notification", method, params };
  }
  return isRequestId(id) ? { kind: "request", id, method, params } : { kind: "invalid", id: null };
}

/** True for a message that gets a response: a request, or a message that is none. */
export function expectsResponse(
  message: JsonRpcMessage,
): message is Extract<JsonRpcMessage, { kind: "request" | "invalid" }> {
  return message.kind === "request" || message.kind === "invalid";
}

/** A JSON-RPC error response. */
export function errorResponse(
  id: RequestId | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/** The response to a message that is no valid JSON-RPC message. */
export function invalidResponse(id: RequestId | null): JsonRpcResponse {
  return errorResponse(id, INVALID_REQUEST, "Invalid Request");
}

function resultResponse(id: RequestId, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
}

/**
 * The response to a `tools/call`: the tool's value as JSON text, or a
 * failure as a tool error carrying its code. A value JSON cannot write is
 * logged and answered `INTERNAL`.
 */
export function toolResponse(
  logger: Logger,
  id: RequestId,
  result: McpCallResult,
): JsonRpcResponse {
  let content: unknown;
  try {
    content = toToolResult(result);
  } catch (error) {
    logger.error("A tool's value could not be written as JSON; it was answered with INTERNAL", {
      category: CATEGORY,
      error: describeError(error),
    });
    content = toToolResult(INTERNAL_FAILURE);
  }
  return resultResponse(id, content);
}

async function callTool(peer: JsonRpcPeer, id: RequestId, params: unknown): Promise<void> {
  if (!isRecord(params) || typeof params.name !== "string") {
    peer.send(errorResponse(id, INVALID_PARAMS, "tools/call needs params { name, arguments? }"));
    return;
  }
  const { name } = params;
  if (!peer.registry.has(name)) {
    peer.send(errorResponse(id, INVALID_PARAMS, `Unknown tool: ${name}`));
    return;
  }
  await peer.callTool(id, name, params.arguments);
}

async function answer(peer: JsonRpcPeer, request: JsonRpcRequest): Promise<void> {
  const { id, method, params } = request;
  switch (method) {
    case "initialize":
      peer.send(
        resultResponse(id, {
          protocolVersion: peer.protocolVersion(
            isRecord(params) ? params.protocolVersion : undefined,
          ),
          serverInfo: peer.serverInfo,
          capabilities: { tools: {} },
        }),
      );
      return;
    case "ping":
      peer.send(resultResponse(id, {}));
      return;
    case "tools/list":
      peer.send(resultResponse(id, { tools: peer.registry.tools }));
      return;
    case "tools/call":
      await callTool(peer, id, params);
      return;
    default:
      peer.send(errorResponse(id, METHOD_NOT_FOUND, `Method not found: ${method}`));
  }
}

/**
 * Handles one message: a request gets its response through `peer.send`
 * (a tool call's once the registry hands over its result, unless the
 * transport cancelled it), an invalid message gets -32600, a notification
 * goes to `peer.notify`, and a response is ignored. Resolves once the
 * message was handled, a tool call's writes flushed included.
 */
export async function handleMessage(peer: JsonRpcPeer, message: JsonRpcMessage): Promise<void> {
  if (message.kind === "request") {
    await answer(peer, message);
  } else if (message.kind === "invalid") {
    peer.send(invalidResponse(message.id));
  } else if (message.kind === "notification") {
    peer.notify?.(message.method, message.params);
  }
}
