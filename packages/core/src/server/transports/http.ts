// The HTTP transport (RFC 0003 section 10): `POST {path}/{service}/{method}`
// with the input as the JSON body, through the same pipeline and the same
// `authenticate` as sockets, for server-side prefetch, load tests and
// webhooks. The principal comes from the session cookie or a bearer token
// (`extractBearerOrCookieToken`); the reply is the `qd:call` acknowledgement
// shape, `{ ok: true, d }` or `{ ok: false, e }`, with the error code's HTTP
// status (`httpStatus`). The call is cancelled when the client goes away.
//
// The router is a plain Node request handler rather than an `express.Router`,
// so it never imports Express: it mounts with `app.use(router)` on Express 4
// or 5 alike, whichever the app installed, and also serves a bare Node HTTP
// server.

import type { IncomingMessage, ServerResponse } from "node:http";
import { consoleLogger, type Logger } from "../../contract/logger";
import { httpStatus, INTERNAL_MESSAGE, QuickdrawError, toWire } from "../../protocol/errors";
import type { Dispatcher } from "../dispatcher";
import { describeError } from "../pipeline/metrics";
import { toCallReply, type DispatchResult } from "../pipeline/request";
import type { Principal } from "../types";
import { INTERNAL_FAILURE, unreadable } from "./ack";
import { createPrincipalResolver, isRefusal, type ResolvePrincipal, type ServerAuth } from "./auth";
import { isJsonRequest, readJsonInput, tokenOf, type HttpRequest } from "./body";

/**
 * A Node request handler that serves calls: mount it with `app.use(router)`
 * on an Express app, or pass it to `http.createServer`. A request it does not
 * serve goes to `next`, or gets a 404 when there is no `next`.
 */
export type HttpRouter = (
  req: IncomingMessage,
  res: ServerResponse,
  next?: (error?: unknown) => void,
) => void;

/**
 * An Express-style middleware, such as an `express-rate-limit` limiter: it
 * answers the request itself, or calls `next()` to let it through.
 */
export type HttpMiddleware = (req: never, res: never, next: (error?: unknown) => void) => unknown;

/** How the HTTP transport serves calls. */
export interface HttpTransportOptions {
  /** The path calls are served under: `POST {path}/{service}/{method}`. Default `"/qd"`. */
  readonly path?: string;
  /**
   * The largest request body read, in bytes. Default 1 MiB. A body the app's
   * own JSON parser already read (`express.json()`) is used as it is.
   */
  readonly maxBodyBytes?: number;
  /** The session cookie a token is read from. Default `"session"`. */
  readonly cookieName?: string;
  /**
   * A rate limiter run before each call the transport serves, and only
   * those: `createCallLimiter()` from `./server/express`, which refuses in
   * the transport's own `RATE_LIMITED` reply. It runs on the app's Express
   * request and response, so the transport must be mounted on Express.
   * Default: none (the socket rate limiter does not see HTTP calls).
   */
  readonly rateLimit?: HttpMiddleware;
}

/** Options of {@link createHttpRouter}. */
export interface HttpRouterOptions<P extends Principal = Principal> extends HttpTransportOptions {
  /** The dispatcher whose methods the router serves. */
  readonly dispatcher: Pick<Dispatcher, "call">;
  /** Authenticates each request, with the same hooks as `createServer`'s `auth`. */
  readonly auth?: ServerAuth<P>;
  /** Default: the console. */
  readonly logger?: Logger;
}

/** What the router runs on, resolved from its options. */
export interface HttpRouterSettings {
  readonly call: Dispatcher["call"];
  readonly resolvePrincipal: ResolvePrincipal;
  readonly logger: Logger;
  readonly prefix: string;
  readonly maxBodyBytes: number;
  readonly cookieName: string | undefined;
  readonly rateLimit: HttpMiddleware | undefined;
}

const DEFAULT_MAX_BODY_BYTES = 1_048_576;

interface Target {
  readonly service: string;
  readonly method: string;
}

function decodeSegment(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

/** The service and method a `POST {prefix}/{service}/{method}` request names, or `undefined`. */
function targetOf(req: IncomingMessage, prefix: string): Target | undefined {
  const path = (req.url ?? "").split("?", 1)[0] ?? "";
  if (req.method !== "POST" || !path.startsWith(`${prefix}/`)) {
    return undefined;
  }
  const segments = path.slice(prefix.length + 1).split("/");
  const [service, method] = segments.map(decodeSegment);
  if (segments.length !== 2 || !service || !method) {
    return undefined;
  }
  return { service, method };
}

function retryAfterSeconds(result: DispatchResult): number | undefined {
  if (result.ok || result.error.code !== "RATE_LIMITED") {
    return undefined;
  }
  const { retryAfterMs } = (result.error.data ?? {}) as { readonly retryAfterMs?: unknown };
  return typeof retryAfterMs === "number" && retryAfterMs > 0
    ? Math.ceil(retryAfterMs / 1000)
    : undefined;
}

function encode(settings: HttpRouterSettings, result: DispatchResult): [number, string] {
  // The status of the code the reply carries, which `toWire` keeps to the known codes.
  const status = result.ok ? 200 : httpStatus(toWire(result.error).code);
  try {
    return [status, JSON.stringify(toCallReply(result))];
  } catch (error) {
    settings.logger.error("A call's reply could not be encoded; it was answered with INTERNAL", {
      category: "quickdraw.http",
      error: describeError(error),
    });
    return [500, JSON.stringify(INTERNAL_FAILURE)];
  }
}

/** Writes a call's reply, unless the response already ended; returns its size in bytes. */
function sendResult(
  settings: HttpRouterSettings,
  res: ServerResponse,
  result: DispatchResult,
): number | undefined {
  if (res.headersSent || res.writableEnded || res.destroyed) {
    return undefined;
  }
  const [status, body] = encode(settings, result);
  const bytes = Buffer.byteLength(body);
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("content-length", bytes);
  const retryAfter = retryAfterSeconds(result);
  if (retryAfter !== undefined) {
    res.setHeader("retry-after", String(retryAfter));
  }
  res.end(body);
  return bytes;
}

function failure(error: QuickdrawError): DispatchResult {
  return { ok: false, error };
}

async function authenticate(
  settings: HttpRouterSettings,
  req: HttpRequest,
): Promise<Principal | null | QuickdrawError> {
  const token = tokenOf(req, settings.cookieName);
  try {
    return await settings.resolvePrincipal({
      transport: "http",
      auth: token === null ? {} : { token },
      headers: req.headers,
      req,
    });
  } catch (error) {
    settings.logger[isRefusal(error) ? "debug" : "error"]("HTTP authentication failed", {
      category: "quickdraw.http",
      error: describeError(error),
    });
    return new QuickdrawError("UNAUTHENTICATED", "Authentication failed");
  }
}

async function serve(
  settings: HttpRouterSettings,
  req: HttpRequest,
  res: ServerResponse,
  target: Target,
): Promise<void> {
  const controller = new AbortController();
  // `req` closes once its body was read; `res` closes when the client leaves.
  res.once("close", () => {
    if (!res.writableFinished) {
      controller.abort();
    }
  });
  if (!isJsonRequest(req)) {
    const message = "Send the input as a JSON body with Content-Type: application/json";
    sendResult(settings, res, failure(unreadable(message)));
    return;
  }
  const principal = await authenticate(settings, req);
  if (principal instanceof QuickdrawError) {
    sendResult(settings, res, failure(principal));
    return;
  }
  let input: unknown;
  try {
    input = await readJsonInput(req, settings.maxBodyBytes);
  } catch (error) {
    const reason =
      error instanceof QuickdrawError ? error : unreadable("The request body could not be read");
    sendResult(settings, res, failure(reason));
    return;
  }
  await settings.call({
    ...target,
    input,
    principal,
    transport: "http",
    signal: controller.signal,
    respond: (result) => sendResult(settings, res, result),
  });
}

function notFound(settings: HttpRouterSettings, res: ServerResponse): void {
  sendResult(settings, res, failure(new QuickdrawError("NOT_FOUND", "Not found")));
}

/** Serves a call, answering `INTERNAL` when serving it fails. */
function serveCall(
  settings: HttpRouterSettings,
  req: IncomingMessage,
  res: ServerResponse,
  target: Target,
): void {
  const fail = (error: unknown): void => {
    settings.logger.error("The HTTP transport failed to serve a call", {
      category: "quickdraw.http",
      error: describeError(error),
    });
    sendResult(settings, res, failure(new QuickdrawError("INTERNAL", INTERNAL_MESSAGE)));
  };
  const { rateLimit } = settings;
  if (rateLimit === undefined) {
    serve(settings, req, res, target).catch(fail);
    return;
  }
  // The limiter answers a refused call itself; it calls `next` to let one through.
  const next = (error?: unknown): void => {
    if (error === undefined) {
      serve(settings, req, res, target).catch(fail);
    } else {
      fail(error);
    }
  };
  try {
    Promise.resolve(rateLimit(req as never, res as never, next)).catch(fail);
  } catch (error) {
    fail(error);
  }
}

/** The router over resolved settings; `createServer` builds it with its own principal resolver. */
export function httpRouter(settings: HttpRouterSettings): HttpRouter {
  return (req, res, next) => {
    const target = targetOf(req, settings.prefix);
    if (target === undefined) {
      if (next === undefined) {
        notFound(settings, res);
      } else {
        next();
      }
      return;
    }
    serveCall(settings, req, res, target);
  };
}

/** `"/qd/"` and `"qd"` become `"/qd"`; `"/"` becomes `""`, serving `/{service}/{method}`. */
function normalizePath(path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "");
  return trimmed === "" ? "" : `/${trimmed}`;
}

/** Resolves the HTTP transport's options. */
export function httpRouterSettings(
  options: HttpTransportOptions,
  base: Pick<HttpRouterSettings, "call" | "resolvePrincipal" | "logger">,
): HttpRouterSettings {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new TypeError("http.maxBodyBytes must be a whole number of bytes, 1 or more");
  }
  const { rateLimit } = options;
  if (rateLimit !== undefined && typeof rateLimit !== "function") {
    throw new TypeError(
      "http.rateLimit must be an Express middleware, such as createCallLimiter()",
    );
  }
  return {
    ...base,
    prefix: normalizePath(options.path ?? "/qd"),
    maxBodyBytes,
    cookieName: options.cookieName,
    rateLimit,
  };
}

/**
 * Creates the HTTP transport for a dispatcher: `POST /qd/{service}/{method}`
 * with a JSON body. `createServer` mounts one on the app's Express app; use
 * this to serve calls from an app without sockets, or under another path.
 *
 * @example
 * app.use(createHttpRouter({ dispatcher, auth: { authenticate } }));
 */
export function createHttpRouter<P extends Principal = Principal>(
  options: HttpRouterOptions<P>,
): HttpRouter {
  return httpRouter(
    httpRouterSettings(options, {
      call: options.dispatcher.call,
      resolvePrincipal: createPrincipalResolver(options.auth),
      logger: options.logger ?? consoleLogger,
    }),
  );
}
