// MCP's Streamable HTTP transport (protocol versions 2025-03-26, 2025-06-18
// and 2025-11-25), which createMcpHttpRouter serves at `{path}` itself, in
// its stateless, JSON-only form (RFC 0003 section 10): a POST carries
// JSON-RPC messages, and its response is one JSON body with their answers.
// It keeps no session, so it never sends `Mcp-Session-Id` and ignores one a
// client sends, and it opens no event stream, so GET (a client's stream)
// and DELETE (the end of a session) are answered 405. Each POST is a
// request of the router as `invoke` is (`rest.ts`): the same gate
// (`http.ts`), body limit, `requestOf`, caller's lane and `registry.call`,
// and a client that goes away cancels its call. A `notifications/cancelled`
// names a request of an earlier POST, which a stateless server cannot find,
// so it does nothing: a client cancels a call by closing its POST. A POST
//
// - sends `Content-Type: application/json` (415 otherwise) and an `Accept`
//   that allows `application/json` (406 otherwise);
// - names its version in `MCP-Protocol-Version`, one of the three (400
//   otherwise), or is taken for 2025-03-26 without it, as the spec says.
//   `initialize` alone is not checked: it negotiates the version in its
//   body, and is answered with the client's version when the endpoint
//   speaks it, or else the latest;
// - holds one message, or under 2025-03-26 a batch of at most 16 (400
//   otherwise) with at most one `tools/call`: a rate limit in front of the
//   route counts a POST once, so a batch never makes more calls than a POST
//   of one message;
// - of notifications and responses only is answered 202 with no body, and
//   one with a request 200 with its response, or a batch's responses as an
//   array, in the batch's order.
//
// A body that is not JSON is answered 400 (-32700), and so is one message
// that is no JSON-RPC message (-32600). Server-sent events, sessions,
// resumability and OAuth discovery are not served.

import type { IncomingMessage, ServerResponse } from "node:http";
import type { Logger } from "../../contract/logger";
import { QuickdrawError } from "../../protocol/errors";
import { describeError } from "../pipeline/metrics";
import { isJsonRequest, readJsonInput, type HttpRequest } from "../transports/body";
import { abortOnClose, accepted, send } from "./httpReply";
import { requestOf } from "./httpRequest";
import {
  classify,
  errorResponse,
  expectsResponse,
  handleMessage,
  INVALID_REQUEST,
  invalidResponse,
  PARSE_ERROR,
  toolResponse,
  type JsonRpcMessage,
  type JsonRpcPeer,
  type JsonRpcResponse,
} from "./jsonRpc";
import type { McpRegistry } from "./registry";

/** What the endpoint needs of the router's settings. */
export interface EndpointSettings {
  readonly registry: McpRegistry;
  readonly maxBodyBytes: number;
  readonly logger: Logger;
  /** `initialize`'s `serverInfo`. */
  readonly serverInfo: { readonly name: string; readonly version: string };
}

/** A body the endpoint refuses before any of its messages runs: its HTTP status, and the error. */
interface Refusal {
  readonly status: number;
  readonly response: JsonRpcResponse;
}

/** The messages of a body the endpoint takes. */
interface Plan {
  readonly batch: boolean;
  readonly messages: readonly JsonRpcMessage[];
}

type ExtraHeaders = Readonly<Record<string, string>>;

const LATEST_VERSION = "2025-11-25";
/** The version of a request without `MCP-Protocol-Version`, and the only one with batches. */
const BATCH_VERSION = "2025-03-26";
/** The versions the endpoint speaks, the latest first. */
const VERSIONS: readonly string[] = [LATEST_VERSION, "2025-06-18", BATCH_VERSION];
const MAX_BATCH = 16;
/** JSON-RPC's code for a server's own errors: the endpoint's refusals, as the MCP SDK's server answers them. */
const SERVER_ERROR = -32000;
const INTERNAL_ERROR = -32603;
const CATEGORY = "quickdraw.mcp";
const NO_BODY = Symbol("no body");

/** How closely a media range matches `application/json`. */
const RANKS: ReadonlyMap<string, number> = new Map([
  ["*/*", 1],
  ["application/*", 2],
  ["application/json", 3],
]);

function reply(res: ServerResponse, refusal: Refusal, headers?: ExtraHeaders): void {
  send(res, refusal.status, JSON.stringify(refusal.response), headers);
}

function badRequest(code: number, message: string): Refusal {
  return { status: 400, response: errorResponse(null, code, message) };
}

const UNSUPPORTED_VERSION = badRequest(
  SERVER_ERROR,
  `Unsupported MCP-Protocol-Version: the endpoint speaks ${VERSIONS.join(", ")}`,
);

/** Answers `status` with an error of the endpoint's own (-32000), without an id. */
export function refuse(
  res: ServerResponse,
  status: number,
  message: string,
  headers?: ExtraHeaders,
): void {
  reply(res, { status, response: errorResponse(null, SERVER_ERROR, message) }, headers);
}

/**
 * True when `Accept` allows a JSON body: it is absent, or the most specific
 * of its ranges that matches `application/json` has a quality above 0.
 */
function acceptsJson(header: string | undefined): boolean {
  if (header === undefined || header.trim() === "") {
    return true;
  }
  let rank = 0;
  let quality = 0;
  for (const range of header.split(",")) {
    const [type = "", ...params] = range.split(";").map((part) => part.trim().toLowerCase());
    const matched = RANKS.get(type) ?? 0;
    if (matched > rank) {
      rank = matched;
      const q = params.find((param) => param.startsWith("q="));
      quality = q === undefined ? 1 : Number(q.slice(2));
    }
  }
  return rank > 0 && (quality > 0 || Number.isNaN(quality));
}

/**
 * The version a request names in `MCP-Protocol-Version`: 2025-03-26 without
 * the header, and `undefined` for a version the endpoint does not speak.
 */
function versionOf(req: IncomingMessage): string | undefined {
  const header = req.headers["mcp-protocol-version"];
  if (header === undefined) {
    return BATCH_VERSION;
  }
  const version = typeof header === "string" ? header.trim() : "";
  return VERSIONS.includes(version) ? version : undefined;
}

/** The version `initialize` answers: the client's, when the endpoint speaks it, else the latest. */
function negotiate(requested: unknown): string {
  return typeof requested === "string" && VERSIONS.includes(requested) ? requested : LATEST_VERSION;
}

function isBatch(body: unknown): body is readonly unknown[] {
  return Array.isArray(body);
}

function isToolCall(message: JsonRpcMessage): boolean {
  return message.kind === "request" && message.method === "tools/call";
}

/**
 * The body, read as `invoke` reads it (a body the app's JSON parser read is
 * used as it is), or `NO_BODY` once one that is too large, not JSON or
 * empty was answered 400 (-32700).
 */
async function readBody(
  settings: EndpointSettings,
  req: HttpRequest,
  res: ServerResponse,
): Promise<unknown> {
  let body: unknown;
  try {
    body = await readJsonInput(req, settings.maxBodyBytes);
  } catch (error) {
    const message =
      error instanceof QuickdrawError ? error.message : "The request body could not be read";
    reply(res, badRequest(PARSE_ERROR, message));
    return NO_BODY;
  }
  if (body === undefined) {
    reply(res, badRequest(PARSE_ERROR, "Send a JSON-RPC message, or a batch of them, as the body"));
    return NO_BODY;
  }
  return body;
}

/** The messages of `body`, or why the endpoint refuses it before any of them runs. */
function planOf(req: IncomingMessage, body: unknown): Plan | Refusal {
  if (!isBatch(body)) {
    const message = classify(body);
    // `initialize` negotiates the version in its body, so its header is not read.
    const initialize = message.kind === "request" && message.method === "initialize";
    if (!initialize && versionOf(req) === undefined) {
      return UNSUPPORTED_VERSION;
    }
    return message.kind === "invalid"
      ? { status: 400, response: invalidResponse(message.id) }
      : { batch: false, messages: [message] };
  }
  const version = versionOf(req);
  if (version === undefined) {
    return UNSUPPORTED_VERSION;
  }
  if (version !== BATCH_VERSION) {
    return badRequest(
      INVALID_REQUEST,
      `MCP protocol version ${version} takes one message per request, never a batch`,
    );
  }
  if (body.length === 0 || body.length > MAX_BATCH) {
    return badRequest(INVALID_REQUEST, `A batch holds from 1 to ${String(MAX_BATCH)} messages`);
  }
  const messages = body.map(classify);
  if (messages.filter(isToolCall).length > 1) {
    return badRequest(
      INVALID_REQUEST,
      "A batch holds at most one tools/call: send each other call in a request of its own",
    );
  }
  return { batch: true, messages };
}

/**
 * Answers the messages of one POST that get a response, in their order,
 * once each has one: a tool call's as soon as the registry hands over its
 * result, before the call's writes flush. Resolves once every message was
 * handled.
 */
async function answer(
  settings: EndpointSettings,
  req: HttpRequest,
  res: ServerResponse,
  signal: AbortSignal,
  { batch, messages }: Plan,
): Promise<void> {
  const answered = messages.filter(expectsResponse);
  const texts: (string | undefined)[] = answered.map(() => undefined);
  let waiting = answered.length;
  const request = requestOf(req);
  const peerOf = (index: number): JsonRpcPeer => {
    const peer: JsonRpcPeer = {
      registry: settings.registry,
      serverInfo: settings.serverInfo,
      logger: settings.logger,
      protocolVersion: negotiate,
      send: (response) => {
        if (texts[index] !== undefined) {
          return undefined;
        }
        const text = JSON.stringify(response);
        texts[index] = text;
        waiting -= 1;
        if (!batch) {
          return send(res, 200, text);
        }
        if (waiting === 0) {
          send(res, 200, `[${texts.join(",")}]`);
        }
        return Buffer.byteLength(text);
      },
      callTool: async (id, name, args) => {
        await settings.registry.call(name, args, {
          request,
          signal,
          respond: (result) => peer.send(toolResponse(settings.logger, id, result)),
        });
      },
    };
    return peer;
  };
  await Promise.all(answered.map((message, index) => handleMessage(peerOf(index), message)));
}

async function post(
  settings: EndpointSettings,
  req: HttpRequest,
  res: ServerResponse,
): Promise<void> {
  const signal = abortOnClose(res);
  if (!isJsonRequest(req)) {
    refuse(res, 415, "Send the messages as a JSON body with Content-Type: application/json");
    return;
  }
  if (!acceptsJson(req.headers.accept)) {
    refuse(res, 406, "Accept application/json: the endpoint answers with JSON, never a stream");
    return;
  }
  const body = await readBody(settings, req, res);
  if (body === NO_BODY) {
    return;
  }
  const plan = planOf(req, body);
  if ("status" in plan) {
    reply(res, plan);
    return;
  }
  if (!plan.messages.some(expectsResponse)) {
    // Notifications and responses only: a stateless server has nothing to do with them.
    accepted(res);
    return;
  }
  await answer(settings, req, res, signal, plan);
}

/**
 * Serves a request for the endpoint: the messages of a POST, and 405 for
 * GET and DELETE. A failure of the endpoint itself is logged and answered
 * 500 (-32603).
 */
export function serveEndpoint(
  settings: EndpointSettings,
  req: HttpRequest,
  res: ServerResponse,
): void {
  if (req.method !== "POST") {
    refuse(res, 405, "The MCP endpoint takes POST: it opens no event stream and keeps no session", {
      allow: "POST",
    });
    return;
  }
  post(settings, req, res).catch((error: unknown) => {
    settings.logger.error("The MCP HTTP routes failed to serve a call", {
      category: CATEGORY,
      error: describeError(error),
    });
    reply(res, { status: 500, response: errorResponse(null, INTERNAL_ERROR, "Internal error") });
  });
}
