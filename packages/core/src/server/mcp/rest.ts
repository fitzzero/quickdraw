// 4.1's REST routes of the MCP HTTP router (RFC 0003 section 10), ported
// from 4.1's `createMcpRoutes` (4.1 `src/server/mcp/McpHttpRoutes.ts:12`)
// onto the registry, keeping its wire format:
//
//   GET  {path}/tools    ->  { tools }
//   POST {path}/invoke   { service, method, payload }  ->  { success: true, data }
//
// `invoke` also takes `{ name, arguments }`, which reaches every tool, the
// app's own included. What changed from 4.1: the registry's `principal`
// hook decides who a bearer token stands for, and a request without one is
// anonymous (only `"public"` methods and custom tools pass) where 4.1
// refused it; a token the hook refuses is answered 401, and a hook that
// fails otherwise (its token store down) 500 (`session.ts`); a failure
// answers with its error code's HTTP status and
// `{ success: false, error, code, data? }` where 4.1 answered 500 and
// `{ error }`; `invoke` needs `Content-Type: application/json`, as every
// HTTP transport call does; and a client that goes away cancels its call.
// The router (`http.ts`) gates both routes, as it gates the Streamable HTTP
// endpoint at `{path}` (`streamable.ts`).

import type { ServerResponse } from "node:http";
import type { Logger } from "../../contract/logger";
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
import { abortOnClose, send } from "./httpReply";
import { requestOf } from "./httpRequest";
import type { McpRegistry } from "./registry";
import type { McpCallOptions, McpCallResult } from "./types";

/** What `invoke` answers: 4.1's `{ success, data }`, or a failure's message, code and data. */
export type McpHttpReply =
  | { readonly success: true; readonly data: unknown }
  | {
      readonly success: false;
      readonly error: string;
      readonly code: ErrorCode;
      readonly data?: unknown;
    };

/** What the REST routes need of the router's settings. */
export interface RestSettings {
  readonly registry: McpRegistry;
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

const CATEGORY = "quickdraw.mcp";
const NOT_JSON = "Send the call as a JSON body with Content-Type: application/json";
const NO_TARGET =
  "Send { name, arguments } to call a tool, or { service, method, payload } to call a method's tool";

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function failure(error: QuickdrawError): McpCallResult {
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

/** Answers in 4.1's shape, with the HTTP status of a failure's code. */
export function sendResult(
  settings: RestSettings,
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

/** `GET {path}/tools`: the registry's tools, the same list for every caller. */
export function listTools(settings: RestSettings, res: ServerResponse): void {
  send(res, 200, JSON.stringify({ tools: settings.registry.tools }));
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

/** `POST {path}/invoke`: one call, as the bearer token's principal. */
export async function invoke(
  settings: RestSettings,
  req: HttpRequest,
  res: ServerResponse,
): Promise<void> {
  const signal = abortOnClose(res);
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
    signal,
    respond: (result) => sendResult(settings, res, result),
  };
  await (target.kind === "tool"
    ? settings.registry.call(target.name, target.args, options)
    : settings.registry.callMethod(target.service, target.method, target.input, options));
}
