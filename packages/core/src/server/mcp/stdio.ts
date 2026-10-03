// The MCP stdio server: JSON-RPC 2.0, one message per line, on stdin and
// stdout (RFC 0003 section 10). Ported from 4.1's `createMcpStdioServer`
// (`legacy-src/server/mcp/McpStdioServer.ts:22`), keeping its wire format:
// protocol version 2024-11-05, `initialize`, `ping`, `tools/list` and
// `tools/call`, a tool's value as one block of JSON text, and the same
// JSON-RPC error codes. What changed:
//
// - tools come from the registry, and who is calling from its `principal`
//   hook, rather than from a `userId` argument any agent could set;
// - a failed call is a tool result with `isError` whose text carries the
//   error's code, where 4.1 answered with a JSON-RPC error;
// - requests are handled concurrently, so the session's queries share one
//   concurrency lane, and `notifications/cancelled` stops a call in flight
//   (MCP sends no reply for a cancelled request);
// - notifications never get a reply, and a JSON-RPC response from the client
//   is ignored;
// - it never exits the process: `closed` resolves once stdin ends.
//
// Anything else that writes to stdout corrupts the protocol, so start the
// server through `bootstrapMcpServer`, which sends console output to stderr.

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Logger } from "../../contract/logger";
import { INTERNAL_MESSAGE, QuickdrawError } from "../../protocol/errors";
import { describeError } from "../pipeline/metrics";
import type { McpRegistry } from "./registry";
import { toToolResult } from "./result";
import { stderrLogger } from "./stderr";
import type { McpCallResult, McpStdioRequest } from "./types";

/** The MCP protocol version the stdio server speaks: 4.1's. */
export const MCP_PROTOCOL_VERSION = "2024-11-05";

/** Options of {@link createMcpStdioServer}. */
export interface McpStdioServerOptions {
  /** The tools to serve. */
  readonly registry: McpRegistry;
  /** The server's name, sent in `initialize`'s `serverInfo`. */
  readonly name: string;
  /** The server's version, sent in `initialize`'s `serverInfo`. */
  readonly version: string;
  /** Where messages arrive. Default `process.stdin`. */
  readonly input?: Readable;
  /** Where replies go. Default `process.stdout`. */
  readonly output?: Writable;
  /** Receives the server's own problems. Default: one line per entry on stderr. */
  readonly logger?: Logger;
}

/** A running stdio server. */
export interface McpStdioServer {
  /** The session id every call of this server carries, and its synthetic connection. */
  readonly sessionId: string;
  /** Resolves once the input has ended and every message in flight has been handled. */
  readonly closed: Promise<void>;
  /** Stops reading and cancels the calls in flight; resolves as `closed` does. */
  close(): Promise<void>;
}

type RequestId = string | number;

interface Session {
  readonly registry: McpRegistry;
  readonly serverInfo: { readonly name: string; readonly version: string };
  readonly request: McpStdioRequest;
  readonly output: Writable;
  readonly logger: Logger;
  /** The `tools/call` requests in flight, by id, so they can be cancelled. */
  readonly calls: Map<RequestId, AbortController>;
  /** Every message still being handled. */
  readonly pending: Set<Promise<void>>;
  /** False once the output failed. */
  writable: boolean;
}

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const CATEGORY = "quickdraw.mcp";

const INTERNAL_FAILURE: McpCallResult = Object.freeze({
  ok: false,
  error: new QuickdrawError("INTERNAL", INTERNAL_MESSAGE),
});

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** MCP request ids are strings or numbers, never `null`. */
function isRequestId(value: unknown): value is RequestId {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/** Writes one message as one line; returns its size in bytes. */
function write(session: Session, message: object): number | undefined {
  if (!session.writable) {
    return undefined;
  }
  const line = `${JSON.stringify(message)}\n`;
  session.output.write(line);
  return Buffer.byteLength(line);
}

function reply(session: Session, id: RequestId, result: unknown): number | undefined {
  return write(session, { jsonrpc: "2.0", id, result });
}

function replyError(session: Session, id: RequestId | null, code: number, message: string): void {
  write(session, { jsonrpc: "2.0", id, error: { code, message } });
}

function replyToolResult(
  session: Session,
  id: RequestId,
  result: McpCallResult,
): number | undefined {
  let content: unknown;
  try {
    content = toToolResult(result);
  } catch (error) {
    session.logger.error(
      "A tool's value could not be written as JSON; it was answered with INTERNAL",
      {
        category: CATEGORY,
        error: describeError(error),
      },
    );
    content = toToolResult(INTERNAL_FAILURE);
  }
  return reply(session, id, content);
}

async function callTool(session: Session, id: RequestId, params: unknown): Promise<void> {
  if (!isRecord(params) || typeof params.name !== "string") {
    replyError(session, id, INVALID_PARAMS, "tools/call needs params { name, arguments? }");
    return;
  }
  const { name } = params;
  if (!session.registry.has(name)) {
    replyError(session, id, INVALID_PARAMS, `Unknown tool: ${name}`);
    return;
  }
  if (session.calls.has(id)) {
    replyError(session, id, INVALID_REQUEST, `Request ${JSON.stringify(id)} is already in flight`);
    return;
  }
  const controller = new AbortController();
  session.calls.set(id, controller);
  const release = (): void => {
    if (session.calls.get(id) === controller) {
      session.calls.delete(id);
    }
  };
  try {
    await session.registry.call(name, params.arguments, {
      request: session.request,
      signal: controller.signal,
      respond: (result) => {
        release();
        // A cancelled call gets no reply, nor does one whose session ended.
        return controller.signal.aborted ? undefined : replyToolResult(session, id, result);
      },
    });
  } finally {
    release();
  }
}

async function onRequest(
  session: Session,
  id: RequestId,
  method: string,
  params: unknown,
): Promise<void> {
  switch (method) {
    case "initialize":
      reply(session, id, {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: session.serverInfo,
        capabilities: { tools: {} },
      });
      return;
    case "ping":
      reply(session, id, {});
      return;
    case "tools/list":
      reply(session, id, { tools: session.registry.tools });
      return;
    case "tools/call":
      await callTool(session, id, params);
      return;
    default:
      replyError(session, id, METHOD_NOT_FOUND, `Method not found: ${method}`);
  }
}

/** `notifications/cancelled` stops a call in flight; every other notification needs nothing. */
function onNotification(session: Session, method: string, params: unknown): void {
  if (method === "notifications/cancelled" && isRecord(params) && isRequestId(params.requestId)) {
    session.calls.get(params.requestId)?.abort();
  }
}

const UNPARSABLE = Symbol("unparsable");

function parse(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return UNPARSABLE;
  }
}

async function onLine(session: Session, line: string): Promise<void> {
  if (line.trim() === "") {
    return;
  }
  const message = parse(line);
  if (message === UNPARSABLE) {
    replyError(session, null, PARSE_ERROR, "Parse error");
    return;
  }
  if (!isRecord(message)) {
    replyError(session, null, INVALID_REQUEST, "Invalid Request");
    return;
  }
  const { id, method, params } = message;
  if (typeof method !== "string") {
    // A response to a request this server never sends: answering it could loop.
    if (!("result" in message) && !("error" in message)) {
      replyError(session, isRequestId(id) ? id : null, INVALID_REQUEST, "Invalid Request");
    }
    return;
  }
  if (id === undefined) {
    onNotification(session, method, params);
    return;
  }
  if (!isRequestId(id)) {
    replyError(session, null, INVALID_REQUEST, "Invalid Request");
    return;
  }
  await onRequest(session, id, method, params);
}

/** Handles one message, keeping track of it until it is done. */
function track(session: Session, work: Promise<void>): void {
  const handled = work.catch((error: unknown) => {
    session.logger.error("The MCP stdio server failed to handle a message", {
      category: CATEGORY,
      error: describeError(error),
    });
  });
  session.pending.add(handled);
  void handled.then(() => session.pending.delete(handled));
}

function openSession(options: McpStdioServerOptions): Session {
  if (
    typeof options !== "object" ||
    options === null ||
    typeof options.registry?.call !== "function"
  ) {
    throw new TypeError("createMcpStdioServer: registry must come from createMcpRegistry");
  }
  if (typeof options.name !== "string" || typeof options.version !== "string") {
    throw new TypeError("createMcpStdioServer: name and version must be strings, for serverInfo");
  }
  return {
    registry: options.registry,
    serverInfo: Object.freeze({ name: options.name, version: options.version }),
    request: Object.freeze({ transport: "stdio", sessionId: randomUUID() }),
    output: options.output ?? process.stdout,
    logger: options.logger ?? stderrLogger,
    calls: new Map(),
    pending: new Set(),
    writable: true,
  };
}

/**
 * Serves `registry`'s tools over MCP's stdio transport: JSON-RPC messages,
 * one per line, read from stdin and answered on stdout. The server is one
 * session: its calls carry one session id and share one concurrency lane,
 * and the registry's `principal` and `context` hooks see the same
 * `{ transport: "stdio", sessionId }` request on every call. It never exits
 * the process.
 *
 * @example
 * // mcp-server.ts, started through bootstrapMcpServer
 * const registry = createMcpRegistry({ services, dispatcher, principal: () => agentFromEnv() });
 * const server = createMcpStdioServer({ registry, name: "my-app", version: "1.0.0" });
 * await server.closed;
 * await prisma.$disconnect();
 */
export function createMcpStdioServer(options: McpStdioServerOptions): McpStdioServer {
  const session = openSession(options);
  const lines = createInterface({
    input: options.input ?? process.stdin,
    crlfDelay: Infinity,
    terminal: false,
  });
  const fail = (error: Error): void => {
    session.logger.warn("The MCP stdio stream failed; the session ends", {
      category: CATEGORY,
      error: describeError(error),
    });
    lines.close();
  };
  const onOutputError = (error: Error): void => {
    session.writable = false;
    fail(error);
  };
  session.output.on("error", onOutputError);
  lines.on("error", fail);
  lines.on("line", (line) => track(session, onLine(session, line)));
  const closed = new Promise<void>((resolve) => {
    lines.once("close", () => {
      for (const controller of session.calls.values()) {
        controller.abort();
      }
      void Promise.allSettled([...session.pending]).then(() => {
        session.output.off("error", onOutputError);
        resolve();
      });
    });
  });
  return Object.freeze({
    sessionId: session.request.sessionId,
    closed,
    close: () => {
      lines.close();
      return closed;
    },
  });
}
