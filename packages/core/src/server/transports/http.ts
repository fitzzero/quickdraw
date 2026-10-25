// The HTTP transport (RFC 0003 section 10): `POST {path}/{service}/{method}`
// with the input as the JSON body, through the same pipeline and the same
// `authenticate` as sockets, for server-side prefetch, load tests and
// webhooks. The principal comes from the session cookie or a bearer token
// (`httpCredentialsOf`), and `authenticate` is told which one the transport
// chose, so the ambient cookie's `Origin` can be checked (`socketAuth` does;
// finding F7.1 of the quickdraw-chat review). The cookie is `auth.token`
// only for `socketAuth`'s `authenticate`, which checks that Origin and the
// session store; every other finds it in `request.sessionCookie` alone, so
// code written for bearer tokens never takes the ambient cookie for one
// (the 5.1 audit's AUTH-1/CLIENT-2). The reply is the `qd:call`
// acknowledgement shape, `{ ok: true, d }` or `{ ok: false, e }`, with the
// error code's HTTP status (`httpStatus`). The call is cancelled when the
// client goes away. A refusal `authenticate` makes on purpose is answered
// `UNAUTHENTICATED` (401), or its `FORBIDDEN` as it is (403), and any other
// failure `INTERNAL` (500), the server's own, as a socket's handshake is
// refused `INTERNAL` for it.
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
import {
  createPrincipalResolver,
  isForbiddenCredential,
  isRefusal,
  socketAuthOf,
  type ResolvePrincipal,
  type ServerAuth,
} from "./auth";
import {
  httpCredentialsOf,
  isJsonRequest,
  readJsonInput,
  transportCookieNaming,
  type HttpCredentials,
  type HttpCredentialSource,
  type HttpRequest,
  type SessionCookieNaming,
} from "./body";

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
  /**
   * The session cookie a token is read from. Default: the name the auth
   * routes set on the same request: `"session"` when `COOKIE_DOMAIN` gives
   * the cookie a domain; else `"__Host-session"` on a request over HTTPS
   * (`req.secure`, `X-Forwarded-Proto: https` or an `https:` `Origin`),
   * which never reads the plain name a sibling site could plant, and
   * `"session"` on a plain HTTP one, where `"__Host-session"` is read first
   * all the same. A name given
   * here is the only one read, on any request. A name the request repeats
   * counts as no cookie.
   */
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
  readonly dispatcher: Pick<Dispatcher, "call"> & Partial<Pick<Dispatcher, "serviceAccessSource">>;
  /**
   * Authenticates each request, with the same hooks as `createServer`'s
   * `auth`. Its `serviceAccessSource` must be the dispatcher's own (made
   * with `createDispatcher({ serviceAccessSource })`), or the router throws:
   * the admin kit protects the grants column only where the dispatcher
   * names it.
   */
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
  /** `cookieName`, and `COOKIE_DOMAIN` read when the router is made: a cookie with a domain is `session`. */
  readonly cookieNaming: SessionCookieNaming;
  /**
   * True when `authenticate` is `socketAuth`'s, which takes the session
   * cookie as `auth.token` (checking its Origin and the store); every other
   * `authenticate` gets it as `request.sessionCookie` alone.
   */
  readonly cookieAsToken: boolean;
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
  // A reply is one caller's data: no cache keeps it, and no browser reads it as anything but JSON.
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
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

/** The credential the transport chose: the session cookie, else the bearer token. */
function chosenCredential(credentials: HttpCredentials): HttpCredentialSource | undefined {
  if (credentials.cookie !== null) {
    return "cookie";
  }
  return credentials.bearer === null ? undefined : "bearer";
}

async function authenticate(
  settings: HttpRouterSettings,
  req: HttpRequest,
): Promise<Principal | null | QuickdrawError> {
  const credentials = httpCredentialsOf(req, settings.cookieNaming);
  const { cookie, bearer } = credentials;
  const token = settings.cookieAsToken ? (cookie ?? bearer) : bearer;
  const credential = chosenCredential(credentials);
  try {
    return await settings.resolvePrincipal({
      transport: "http",
      auth: token === null ? {} : { token },
      // The session cookie is ambient: `socketAuth` checks such a call's Origin (F7.1).
      ...(credential === undefined ? {} : { credential }),
      ...(cookie === null ? {} : { sessionCookie: cookie }),
      headers: req.headers,
      req,
    });
  } catch (error) {
    const forbidden = isForbiddenCredential(error);
    const refused = isRefusal(error) || forbidden;
    settings.logger[refused ? "debug" : "error"]("HTTP authentication failed", {
      category: "quickdraw.http",
      error: describeError(error),
    });
    if (forbidden) {
      return new QuickdrawError("FORBIDDEN", error.message);
    }
    // Anything but a refusal is the server's failure (its session store down, say), as a
    // socket's handshake takes it: the credentials may well be good, so the caller is not told
    // they are not.
    return refused
      ? new QuickdrawError("UNAUTHENTICATED", "Authentication failed")
      : new QuickdrawError("INTERNAL", INTERNAL_MESSAGE);
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

/**
 * Checks the HTTP transport's options: `TypeError` for a `maxBodyBytes` that
 * is no whole number of bytes, 1 or more, and a `rateLimit` that is no
 * middleware. `createServer` checks them before it makes anything, the
 * dispatcher included, so options it refuses leave nothing attached.
 */
export function checkHttpTransportOptions(options: HttpTransportOptions): void {
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes < 1) {
    throw new TypeError("http.maxBodyBytes must be a whole number of bytes, 1 or more");
  }
  if (options.rateLimit !== undefined && typeof options.rateLimit !== "function") {
    throw new TypeError(
      "http.rateLimit must be an Express middleware, such as createCallLimiter()",
    );
  }
}

/** Checks the HTTP transport's options (`checkHttpTransportOptions`) and resolves them. */
export function httpRouterSettings(
  options: HttpTransportOptions,
  base: Pick<HttpRouterSettings, "call" | "resolvePrincipal" | "logger" | "cookieAsToken">,
): HttpRouterSettings {
  checkHttpTransportOptions(options);
  return {
    ...base,
    prefix: normalizePath(options.path ?? "/qd"),
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    cookieNaming: transportCookieNaming(options.cookieName),
    rateLimit: options.rateLimit,
  };
}

/**
 * `TypeError` when the router's `auth.serviceAccessSource` is not its
 * dispatcher's (the 5.1 audit's ADMIN-2): the admin kit hides and guards the
 * grants column only where the dispatcher names it, so a router that names
 * it alone would leave it an ordinary, writable field.
 */
function checkGrantsSource(
  own: Dispatcher["serviceAccessSource"],
  named: Dispatcher["serviceAccessSource"],
): void {
  if (named === undefined || (own?.model === named.model && own.column === named.column)) {
    return;
  }
  const made = own === undefined ? "without one" : `with ${own.model}.${own.column}`;
  throw new TypeError(
    `createHttpRouter: auth.serviceAccessSource names ${named.model}.${named.column}, but its dispatcher was made ${made}: pass serviceAccessSource: { model: "${named.model}", column: "${named.column}" } to createDispatcher, so the admin kit there protects that column`,
  );
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
  checkGrantsSource(options.dispatcher.serviceAccessSource, options.auth?.serviceAccessSource);
  const logger = options.logger ?? consoleLogger;
  return httpRouter(
    httpRouterSettings(options, {
      call: options.dispatcher.call,
      resolvePrincipal: createPrincipalResolver(options.auth, logger),
      logger,
      cookieAsToken: socketAuthOf(options.auth?.authenticate) !== undefined,
    }),
  );
}
