// The MCP HTTP routes (RFC 0003 section 10), ported from 4.1's
// `createMcpRoutes` (`legacy-src/server/mcp/McpHttpRoutes.ts:12`) onto the
// registry, keeping its wire format:
//
//   GET  {path}/tools    ->  { tools }
//   POST {path}/invoke   { service, method, payload }  ->  { success: true, data }
//
// `invoke` also takes `{ name, arguments }`, which reaches every tool, the
// app's own included. Like the HTTP transport, the routes are a plain Node
// request handler rather than an `express.Router`, so they mount with
// `app.use(router)` on Express 4 or 5 and also serve a bare Node server.
//
// What changed from 4.1: the registry's `principal` hook decides who a bearer
// token stands for, and a request without one is anonymous (only `"public"`
// methods and custom tools pass) where 4.1 refused it; a failure answers
// with its error code's HTTP status and `{ success: false, error, code,
// data? }` where 4.1 answered 500 and `{ error }`; `invoke` needs
// `Content-Type: application/json`, as every HTTP transport call does; and a
// client that goes away cancels its call. Each request is a session of its
// own.

import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { consoleLogger, type Logger } from "../../contract/logger";
import {
  httpStatus,
  INTERNAL_MESSAGE,
  QuickdrawError,
  toWire,
  type ErrorCode,
} from "../../protocol/errors";
import { describeError } from "../pipeline/metrics";
import { unreadable } from "../transports/ack";
import { isJsonRequest, readJsonInput, type HttpRequest } from "../transports/body";
import type { HttpRouter } from "../transports/http";
import type { McpRegistry } from "./registry";
import type { McpCallOptions, McpCallResult, McpHttpRequest } from "./types";

/** Options of {@link createMcpHttpRouter}. */
export interface McpHttpRouterOptions {
  /** The tools to serve. */
  readonly registry: McpRegistry;
  /** The prefix of the routes: `GET {path}/tools` and `POST {path}/invoke`. Default `"/mcp"`, as in 4.1. */
  readonly path?: string;
  /**
   * The largest request body read, in bytes. Default 1 MiB. A body the app's
   * own JSON parser already read (`express.json()`) is used as it is.
   */
  readonly maxBodyBytes?: number;
  /** Default: the console. */
  readonly logger?: Logger;
}

/** What `invoke` answers: 4.1's `{ success, data }`, or a failure's message, code and data. */
export type McpHttpReply =
  | { readonly success: true; readonly data: unknown }
  | {
      readonly success: false;
      readonly error: string;
      readonly code: ErrorCode;
      readonly data?: unknown;
    };

interface Settings {
  readonly registry: McpRegistry;
  readonly prefix: string;
  readonly maxBodyBytes: number;
  readonly logger: Logger;
}

/** What an `invoke` body names: any tool by name, or a method's tool by service and method. */
type Target =
  | { readonly kind: "tool"; readonly name: string; readonly args: unknown }
  | {
      readonly kind: "method";
      readonly service: string;
      readonly method: string;
      readonly input: unknown;
    };

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const CATEGORY = "quickdraw.mcp";
const NOT_JSON = "Send the call as a JSON body with Content-Type: application/json";
const NO_TARGET =
  "Send { name, arguments } to call a tool, or { service, method, payload } to call a method's tool";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function failure(error: QuickdrawError): McpCallResult {
  return { ok: false, error };
}

function replyOf(result: McpCallResult): [number, McpHttpReply] {
  if (result.ok) {
    return [200, { success: true, data: result.data }];
  }
  const { code, message, data } = toWire(result.error);
  const reply = { success: false as const, error: message, code };
  return [httpStatus(code), data === undefined ? reply : { ...reply, data }];
}

/** Writes a JSON body, unless the response already ended; returns its size in bytes. */
function send(res: ServerResponse, status: number, body: string): number | undefined {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    return undefined;
  }
  const bytes = Buffer.byteLength(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", bytes);
  res.end(body);
  return bytes;
}

function sendResult(
  settings: Settings,
  res: ServerResponse,
  result: McpCallResult,
): number | undefined {
  const [status, reply] = replyOf(result);
  let body: string;
  try {
    body = JSON.stringify(reply);
  } catch (error) {
    settings.logger.error(
      "An MCP call's reply could not be encoded; it was answered with INTERNAL",
      {
        category: CATEGORY,
        error: describeError(error),
      },
    );
    const [internal, fallback] = replyOf(failure(new QuickdrawError("INTERNAL", INTERNAL_MESSAGE)));
    return send(res, internal, JSON.stringify(fallback));
  }
  return send(res, status, body);
}

function routeOf(req: IncomingMessage, prefix: string): "tools" | "invoke" | undefined {
  const path = (req.url ?? "").split("?", 1)[0] ?? "";
  if (req.method === "GET" && path === `${prefix}/tools`) {
    return "tools";
  }
  return req.method === "POST" && path === `${prefix}/invoke` ? "invoke" : undefined;
}

function targetOf(body: unknown): Target | undefined {
  if (!isRecord(body)) {
    return undefined;
  }
  if (typeof body.name === "string") {
    return { kind: "tool", name: body.name, args: body.arguments };
  }
  if (typeof body.service === "string" && typeof body.method === "string") {
    return { kind: "method", service: body.service, method: body.method, input: body.payload };
  }
  return undefined;
}

/** The session an `invoke` request stands for, with its bearer token. */
function requestOf(req: IncomingMessage): McpHttpRequest {
  const header = req.headers.authorization;
  const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
  return {
    transport: "http",
    sessionId: randomUUID(),
    token: token.trim() === "" ? null : token.trim(),
    headers: req.headers,
    req,
  };
}

async function invoke(settings: Settings, req: HttpRequest, res: ServerResponse): Promise<void> {
  const controller = new AbortController();
  // `req` closes once its body was read; `res` closes when the client leaves.
  res.once("close", () => {
    if (!res.writableFinished) {
      controller.abort();
    }
  });
  if (!isJsonRequest(req)) {
    sendResult(settings, res, failure(unreadable(NOT_JSON)));
    return;
  }
  let body: unknown;
  try {
    body = await readJsonInput(req, settings.maxBodyBytes);
  } catch (error) {
    const reason =
      error instanceof QuickdrawError ? error : unreadable("The request body could not be read");
    sendResult(settings, res, failure(reason));
    return;
  }
  const target = targetOf(body);
  if (target === undefined) {
    sendResult(settings, res, failure(unreadable(NO_TARGET)));
    return;
  }
  const options: McpCallOptions = {
    request: requestOf(req),
    signal: controller.signal,
    respond: (result) => sendResult(settings, res, result),
  };
  await (target.kind === "tool"
    ? settings.registry.call(target.name, target.args, options)
    : settings.registry.callMethod(target.service, target.method, target.input, options));
}

/** `"/mcp/"` and `"mcp"` become `"/mcp"`; `"/"` becomes `""`, serving `/tools` and `/invoke`. */
function normalizePath(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "" : `/${trimmed}`;
}

function resolveSettings(options: McpHttpRouterOptions): Settings {
  if (typeof options !== "object" || options === null || !isRecord(options.registry)) {
    throw new TypeError("createMcpHttpRouter: registry must come from createMcpRegistry");
  }
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new TypeError(
      "createMcpHttpRouter: maxBodyBytes must be a whole number of bytes, 1 or more",
    );
  }
  return {
    registry: options.registry,
    prefix: normalizePath(options.path ?? "/mcp"),
    maxBodyBytes,
    logger: options.logger ?? consoleLogger,
  };
}

/**
 * Serves `registry`'s tools over HTTP: `GET /mcp/tools` lists them, and
 * `POST /mcp/invoke` calls one with `{ name, arguments }`, or a method's
 * tool with 4.1's `{ service, method, payload }`, as the bearer token's
 * principal. Mount it with `app.use(router)` on Express 4 or 5, or pass it to
 * `http.createServer`. A request it does not serve goes to `next`, or gets a
 * 404 when there is no `next`.
 *
 * @example
 * app.use(createMcpHttpRouter({ registry }));
 */
export function createMcpHttpRouter(options: McpHttpRouterOptions): HttpRouter {
  const settings = resolveSettings(options);
  return (req, res, next) => {
    const route = routeOf(req, settings.prefix);
    if (route === undefined) {
      if (next === undefined) {
        sendResult(settings, res, failure(new QuickdrawError("NOT_FOUND", "Not found")));
      } else {
        next();
      }
      return;
    }
    if (route === "tools") {
      send(res, 200, JSON.stringify({ tools: settings.registry.tools }));
      return;
    }
    invoke(settings, req, res).catch((error: unknown) => {
      settings.logger.error("The MCP HTTP routes failed to serve a call", {
        category: CATEGORY,
        error: describeError(error),
      });
      sendResult(settings, res, failure(new QuickdrawError("INTERNAL", INTERNAL_MESSAGE)));
    });
  };
}
