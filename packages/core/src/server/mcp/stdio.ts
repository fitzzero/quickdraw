// The MCP stdio server: JSON-RPC 2.0, one message per line, on stdin and
// stdout (RFC 0003 section 10). Ported from 4.1's `createMcpStdioServer`
// (4.1 `src/server/mcp/McpStdioServer.ts:22`), keeping its wire format:
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
// - it never exits the process: `closed` resolves once stdin ends and every
//   call still running has answered (a client that writes its requests and
//   closes stdin still gets every reply), while `close()` and a broken
//   stream cancel the calls in flight instead.
//
// The JSON-RPC handling is the core the Streamable HTTP endpoint shares
// (`jsonRpc.ts`); what is the stdio server's own is the session, the calls
// in flight and their cancel, and the protocol version, which stays 4.1's.
//
// Anything else that writes to stdout corrupts the protocol, so start the
// server through `bootstrapMcpServer`, which sends console output to stderr.

import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import type { Logger } from "../../contract/logger";
import { describeError } from "../pipeline/metrics";
import {
  classify,
  errorResponse,
  handleMessage,
  INVALID_REQUEST,
  isRecord,
  isRequestId,
  PARSE_ERROR,
  toolResponse,
  type JsonRpcPeer,
  type JsonRpcResponse,
  type RequestId,
} from "./jsonRpc";
import type { McpRegistry } from "./registry";
import { stderrLogger } from "./stderr";
import type { McpStdioRequest } from "./types";

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
  /**
   * Resolves once the input has ended and every message in flight has been
   * handled: when stdin ends, the calls still running finish and their
   * replies are written first.
   */
  readonly closed: Promise<void>;
  /** Stops reading and cancels the calls in flight (no reply is written for them); resolves as `closed` does. */
  close(): Promise<void>;
}

/** A stdio session: the core's peer, with the calls it has in flight. */
interface Session extends JsonRpcPeer {
  readonly request: McpStdioRequest;
  readonly output: Writable;
  /** The `tools/call` requests in flight, by id, so they can be cancelled. */
  readonly calls: Map<RequestId, AbortController>;
  /** Every message still being handled. */
  readonly pending: Set<Promise<void>>;
  /** False once the output failed. */
  writable: boolean;
}

const CATEGORY = "quickdraw.mcp";

/** Writes one message as one line; returns its size in bytes. */
function write(session: Session, message: JsonRpcResponse): number | undefined {
  if (!session.writable) {
    return undefined;
  }
  const line = `${JSON.stringify(message)}\n`;
  session.output.write(line);
  return Buffer.byteLength(line);
}

/** Calls a tool for request `id`, which `notifications/cancelled` can stop. */
async function callTool(
  session: Session,
  id: RequestId,
  name: string,
  args: unknown,
): Promise<void> {
  if (session.calls.has(id)) {
    session.send(
      errorResponse(id, INVALID_REQUEST, `Request ${JSON.stringify(id)} is already in flight`),
    );
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
    await session.registry.call(name, args, {
      request: session.request,
      signal: controller.signal,
      respond: (result) => {
        release();
        // A cancelled call gets no reply, nor does one whose session ended.
        return controller.signal.aborted
          ? undefined
          : session.send(toolResponse(session.logger, id, result));
      },
    });
  } finally {
    release();
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
    session.send(errorResponse(null, PARSE_ERROR, "Parse error"));
    return;
  }
  await handleMessage(session, classify(message));
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
  const session: Session = {
    registry: options.registry,
    serverInfo: Object.freeze({ name: options.name, version: options.version }),
    logger: options.logger ?? stderrLogger,
    protocolVersion: () => MCP_PROTOCOL_VERSION,
    send: (response) => write(session, response),
    callTool: (id, name, args) => callTool(session, id, name, args),
    notify: (method, params) => onNotification(session, method, params),
    request: Object.freeze({ transport: "stdio", sessionId: randomUUID() }),
    output: options.output ?? process.stdout,
    calls: new Map(),
    pending: new Set(),
    writable: true,
  };
  return session;
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
  // Ending stdin lets the calls in flight answer; `close()` and a broken stream cancel them.
  let cancel = false;
  const stop = (): void => {
    cancel = true;
    lines.close();
  };
  const fail = (error: Error): void => {
    session.logger.warn("The MCP stdio stream failed; the session ends", {
      category: CATEGORY,
      error: describeError(error),
    });
    stop();
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
      for (const controller of cancel ? session.calls.values() : []) {
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
      stop();
      return closed;
    },
  });
}
