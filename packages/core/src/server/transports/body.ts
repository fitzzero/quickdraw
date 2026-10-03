// Reading an HTTP call's credentials and JSON input from a Node request, so
// the HTTP transport works the same under Express 4, Express 5 or a bare
// Node HTTP server, with or without the app's own body and cookie parsers.

import type { IncomingMessage } from "node:http";
import { extractBearerOrCookieToken } from "../auth/restMiddleware";
import { unreadable } from "./ack";

/** A request as Express leaves it: maybe with `body` from `express.json()` and `cookies` from `cookie-parser`. */
export type HttpRequest = IncomingMessage & {
  readonly body?: unknown;
  readonly cookies?: unknown;
};

/**
 * True when the request declares a JSON body (`application/json` or a
 * `+json` type). The HTTP transport requires it of every call, with or
 * without a body: a cross-site page can send a form or a body-less POST
 * without a CORS preflight, but not one with this content type, so a session
 * cookie alone cannot make the browser call a method on a user's behalf.
 */
export function isJsonRequest(req: IncomingMessage): boolean {
  const header = req.headers["content-type"];
  if (typeof header !== "string") {
    return false;
  }
  const type = (header.split(";", 1)[0] ?? "").trim().toLowerCase();
  return type === "application/json" || type.endsWith("+json");
}

function hasBody(req: IncomingMessage): boolean {
  if (req.headers["transfer-encoding"] !== undefined) {
    return true;
  }
  const length = Number(req.headers["content-length"] ?? 0);
  return Number.isFinite(length) && length > 0;
}

function readText(req: IncomingMessage, maxBytes: number): Promise<string> {
  if (req.readableEnded) {
    return Promise.resolve("");
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    function stop(): void {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
    }
    function onData(chunk: Buffer | string): void {
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buffer.length;
      if (size <= maxBytes) {
        chunks.push(buffer);
        return;
      }
      stop();
      // Discard the rest, so the response can still be sent on this connection.
      req.resume();
      reject(unreadable(`The request body is larger than ${maxBytes} bytes`));
    }
    function onEnd(): void {
      stop();
      resolve(Buffer.concat(chunks).toString("utf8"));
    }
    function onError(error: Error): void {
      stop();
      reject(error);
    }
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
  });
}

/**
 * The call's input: `undefined` when the request has no body; the body the
 * app's JSON parser already read (`express.json()` sets `req.body`); or else
 * the body read here, up to `maxBytes`, and parsed. A body that is too large
 * or not JSON rejects with `VALIDATION`.
 *
 * `req.body` counts only once the request stream was consumed. Express 4's
 * body parsers set `req.body = {}` before they decide whether a request is
 * theirs, so a request that `express.urlencoded()` passed over, or that
 * `express.json()` passed over because its type was `application/vnd.api+json`,
 * arrives with `req.body` set to `{}` and its body still unread.
 */
export async function readJsonInput(req: HttpRequest, maxBytes: number): Promise<unknown> {
  if (!hasBody(req)) {
    return undefined;
  }
  if (req.readableEnded) {
    return req.body;
  }
  const text = await readText(req, maxBytes);
  if (text.trim() === "") {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw unreadable("The request body is not valid JSON");
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.values(value).every((entry) => typeof entry === "string")
  );
}

function decode(raw: string): string {
  const quoted = raw.length > 1 && raw.startsWith('"') && raw.endsWith('"');
  const value = quoted ? raw.slice(1, -1) : raw;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The request's cookies: `req.cookies` from `cookie-parser`, or else the `Cookie` header parsed here. */
function cookiesOf(req: HttpRequest): Record<string, string> {
  if (isStringRecord(req.cookies)) {
    return req.cookies;
  }
  const cookies: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of (req.headers.cookie ?? "").split(";")) {
    const equals = pair.indexOf("=");
    const name = pair.slice(0, equals).trim();
    if (equals > 0 && name !== "" && !Object.hasOwn(cookies, name)) {
      cookies[name] = decode(pair.slice(equals + 1).trim());
    }
  }
  return cookies;
}

/**
 * The token an HTTP call authenticates with: its session cookie, or else its
 * bearer token, as `extractBearerOrCookieToken` picks them.
 */
export function tokenOf(req: HttpRequest, cookieName: string | undefined): string | null {
  const headers = { authorization: req.headers.authorization };
  return extractBearerOrCookieToken({ cookies: cookiesOf(req), headers }, cookieName);
}
