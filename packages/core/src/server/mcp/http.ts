// The MCP HTTP router (RFC 0003 section 10): MCP's Streamable HTTP
// transport at `{path}` itself (`streamable.ts`: stateless, JSON-only
// JSON-RPC, what MCP clients such as Claude Code connect to), and beside it
// 4.1's REST routes, `GET {path}/tools` and `POST {path}/invoke`
// (`rest.ts`). Like the HTTP transport, the router is a plain Node request
// handler rather than an `express.Router`, so it mounts with
// `app.use(router)` on Express 4 or 5 and also serves a bare Node server.
//
// Every route is behind one gate, checked here before any of them runs: a
// request from a web page is refused unless `allowedOrigins` lists its
// origin, and with `allowedHosts` a request for another `Host`
// (`httpRequest.ts`). Both calling routes then read the body within
// `maxBodyBytes`, make each request a session of its own (`requestOf`),
// whose queries share the lane of its caller: its bearer token, its user
// without a token, or its address when anonymous (`lanes.ts`), and call
// through `registry.call`, whose `principal` hook says who the token stands
// for (`session.ts`); a client that goes away cancels its call.

import type { IncomingMessage } from "node:http";
import { consoleLogger, type Logger } from "../../contract/logger";
import { INTERNAL_MESSAGE, QuickdrawError } from "../../protocol/errors";
import { QUICKDRAW_VERSION } from "../../version";
import { describeError } from "../pipeline/metrics";
import type { HttpRouter } from "../transports/http";
import { requestGate, type AllowedOrigin, type RequestGate } from "./httpRequest";
import type { McpRegistry } from "./registry";
import { failure, invoke, listTools, sendResult } from "./rest";
import { refuse, serveEndpoint } from "./streamable";

/** Options of {@link createMcpHttpRouter}. */
export interface McpHttpRouterOptions {
  /** The tools to serve. */
  readonly registry: McpRegistry;
  /**
   * Where the routes are: the Streamable HTTP endpoint at `{path}` itself,
   * and 4.1's `GET {path}/tools` and `POST {path}/invoke`. Default `"/mcp"`,
   * as in 4.1.
   */
  readonly path?: string;
  /** The server's name, sent in `initialize`'s `serverInfo`. Default `"quickdraw"`. */
  readonly name?: string;
  /** The server's version, sent in `initialize`'s `serverInfo`. Default: quickdraw-core's. */
  readonly version?: string;
  /**
   * The largest request body read, in bytes. Default 1 MiB. A body the app's
   * own JSON parser already read (`express.json()`) is used as it is.
   */
  readonly maxBodyBytes?: number;
  /** Default: the console. */
  readonly logger?: Logger;
  /**
   * The web pages that may call the routes, by origin: exact origins
   * (`"https://app.example.com"`) or patterns anchored with `^` and `$`, as
   * `socketAuth` takes them. A request whose `Origin` is not listed gets 403;
   * a request without one (an MCP client, a script) is not a page's and
   * passes. Default: none, so no page may call them.
   */
  readonly allowedOrigins?: readonly AllowedOrigin[];
  /**
   * The `Host` names the routes answer for (`"localhost"`, `"127.0.0.1"`,
   * `"mcp.example.com:8443"`; an entry without a port matches any port): a
   * request for another gets 403. Set it for a server on a developer's
   * machine or a LAN, where a page could reach it through DNS rebinding.
   * Default: any host.
   */
  readonly allowedHosts?: readonly string[];
}

interface Settings {
  readonly registry: McpRegistry;
  readonly prefix: string;
  readonly maxBodyBytes: number;
  readonly logger: Logger;
  readonly gate: RequestGate;
  readonly serverInfo: { readonly name: string; readonly version: string };
}

/** The endpoint at `{path}` itself, or one of 4.1's routes below it. */
type Route = "endpoint" | "tools" | "invoke";

const DEFAULT_MAX_BODY_BYTES = 1_048_576;
const CATEGORY = "quickdraw.mcp";
/** The methods of the endpoint: POST, and GET and DELETE, which it answers 405. */
const ENDPOINT_METHODS: ReadonlySet<string> = new Set(["POST", "GET", "DELETE"]);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function routeOf(req: IncomingMessage, prefix: string): Route | undefined {
  const path = (req.url ?? "").split("?", 1)[0] ?? "";
  // The path itself exactly, so that `{path}/tools` and `{path}/invoke` stay 4.1's.
  if (path === (prefix === "" ? "/" : prefix)) {
    return ENDPOINT_METHODS.has(req.method ?? "") ? "endpoint" : undefined;
  }
  if (req.method === "GET" && path === `${prefix}/tools`) {
    return "tools";
  }
  return req.method === "POST" && path === `${prefix}/invoke` ? "invoke" : undefined;
}

/** `"/mcp/"` and `"mcp"` become `"/mcp"`; `"/"` becomes `""`, serving `/`, `/tools` and `/invoke`. */
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
  const name: unknown = options.name ?? "quickdraw";
  const version: unknown = options.version ?? QUICKDRAW_VERSION;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new TypeError("createMcpHttpRouter: name and version must be strings, for serverInfo");
  }
  return {
    registry: options.registry,
    prefix: normalizePath(options.path ?? "/mcp"),
    maxBodyBytes,
    logger: options.logger ?? consoleLogger,
    gate: requestGate(options.allowedOrigins, options.allowedHosts),
    serverInfo: Object.freeze({ name, version }),
  };
}

/**
 * Serves `registry`'s tools over HTTP. `POST /mcp` is MCP's Streamable HTTP
 * transport, stateless and answering with JSON (protocol versions
 * 2025-11-25, 2025-06-18 and 2025-03-26; GET and DELETE are answered 405),
 * which MCP clients connect to; `GET /mcp/tools` lists the tools and
 * `POST /mcp/invoke` calls one with `{ name, arguments }`, or a method's
 * tool with 4.1's `{ service, method, payload }`. Every call runs as the
 * bearer token's principal, and the tool list is the same for every caller
 * (it is not filtered by the principal). Mount it with `app.use(router)` on
 * Express 4 or 5, or pass it to `http.createServer`. A request it does not
 * serve goes to `next`, or gets a 404 when there is no `next`.
 *
 * @example
 * // claude mcp add --transport http my-app https://host/mcp --header "Authorization: Bearer <token>"
 * app.use(createMcpHttpRouter({ registry, name: "my-app", version: "1.0.0" }));
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
    const refusal = settings.gate.refusal(req);
    if (refusal !== undefined) {
      settings.logger.debug("An MCP HTTP request was refused", {
        category: CATEGORY,
        origin: req.headers.origin,
        host: req.headers.host,
      });
      if (route === "endpoint") {
        refuse(res, 403, refusal);
      } else {
        sendResult(settings, res, failure(new QuickdrawError("FORBIDDEN", refusal)));
      }
      return;
    }
    if (route === "endpoint") {
      serveEndpoint(settings, req, res);
      return;
    }
    if (route === "tools") {
      listTools(settings, res);
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
