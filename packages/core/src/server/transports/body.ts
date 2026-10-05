// Reading an HTTP call's credentials and JSON input from a Node request, so
// the HTTP transport works the same under Express 4, Express 5 or a bare
// Node HTTP server, with or without the app's own body and cookie parsers.

import type { IncomingMessage } from "node:http";
import { extractBearerOrCookieToken } from "../auth/restMiddleware";
import {
  cookieDomainFromEnv,
  sessionCookieNamesFor,
  type SessionCookieNaming,
} from "../auth/sessionCookie";
import { unreadable } from "./ack";

/**
 * A request as Express leaves it: maybe with `body` from `express.json()`,
 * `cookies` from `cookie-parser`, and Express's own `secure`.
 */
export type HttpRequest = IncomingMessage & {
  readonly body?: unknown;
  readonly cookies?: unknown;
  readonly secure?: unknown;
};

/**
 * True when the request declares a JSON body (`application/json` or a
 * `+json` type). The HTTP transport requires it of every call, with or
 * without a body: a cross-site page can send a form or a body-less POST
 * without a CORS preflight, but not one with this content type, so a session
 * cookie alone cannot make the browser call a method on a user's behalf.
 * Since rc.5 `socketAuth` also checks the `Origin` of a call that sends the
 * cookie (finding F7.1), so a permissive CORS policy does not open it.
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

/** Where cookies are read from: a request, or a socket handshake's `{ headers }`. */
export interface CookieSource {
  readonly cookies?: unknown;
  readonly headers: { readonly cookie?: string | undefined };
}

/**
 * The request's cookies, from its `Cookie` header, or else `req.cookies`
 * (`cookie-parser`) for a request without one. A name the header repeats
 * maps to `""`, no credential: a browser sends two cookies of one name when
 * another site under the same parent domain, or a path below this one, set
 * the second (cookie tossing), and the server cannot tell which is its own,
 * so it trusts neither. `cookie-parser` keeps the first, which may be the
 * planted one, so the header is read whenever there is one.
 */
export function cookiesOf(req: CookieSource): Record<string, string> {
  const header = req.headers.cookie;
  if (typeof header !== "string") {
    return isStringRecord(req.cookies) ? req.cookies : {};
  }
  const cookies: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const pair of header.split(";")) {
    const equals = pair.indexOf("=");
    const name = pair.slice(0, equals).trim();
    if (equals <= 0 || name === "") {
      continue;
    }
    cookies[name] = Object.hasOwn(cookies, name) ? "" : decode(pair.slice(equals + 1).trim());
  }
  return cookies;
}

/**
 * The session token among `cookies`, under the first of `names` the request
 * holds: its value, or `null` when it is empty or repeated. A later name is
 * read only when no earlier one is there, so a repeated name never lets
 * another stand in for it.
 */
export function cookieToken(
  cookies: Readonly<Record<string, string>>,
  names: readonly string[],
): string | null {
  const name = names.find((candidate) => Object.hasOwn(cookies, candidate));
  const value = name === undefined ? undefined : cookies[name];
  return value === undefined || value === "" ? null : value;
}

export type { SessionCookieNaming };

/**
 * How a transport names the session cookie: the `cookieName` it was given,
 * and the domain `COOKIE_DOMAIN` gives the cookie, read now, as the auth
 * routes read it (a cookie with a domain is `session`).
 */
export function transportCookieNaming(cookieName: string | undefined): SessionCookieNaming {
  return { cookieName, domain: cookieDomainFromEnv() };
}

/**
 * Where an HTTP call's token came from. `"cookie"`: the session cookie, which
 * a browser sends with a request any page makes, so whoever accepts it checks
 * the request's `Origin` (`socketAuth` does). `"bearer"`: an
 * `Authorization: Bearer` header, which a page sends only on purpose.
 */
export type HttpCredentialSource = "cookie" | "bearer";

/** An HTTP call's token and where it came from. */
export interface HttpCredential {
  readonly token: string;
  readonly from: HttpCredentialSource;
}

/**
 * The credential an HTTP call authenticates with: its session cookie, under
 * the names `sessionCookieNamesFor` gives the request (by how the app named
 * the cookie and whether the request came over HTTPS), or else its bearer
 * token; `null` with neither.
 */
export function httpCredentialOf(
  req: HttpRequest,
  naming: SessionCookieNaming,
): HttpCredential | null {
  const cookie = cookieToken(cookiesOf(req), sessionCookieNamesFor(req, naming));
  if (cookie !== null) {
    return { token: cookie, from: "cookie" };
  }
  const bearer = extractBearerOrCookieToken({
    headers: { authorization: req.headers.authorization },
  });
  return bearer === null || bearer === "" ? null : { token: bearer, from: "bearer" };
}

/** The token of {@link httpCredentialOf}, or `null`. */
export function tokenOf(req: HttpRequest, naming: SessionCookieNaming): string | null {
  return httpCredentialOf(req, naming)?.token ?? null;
}
