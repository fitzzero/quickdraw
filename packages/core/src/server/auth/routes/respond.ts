// Reading and answering the auth routes' requests. The routes are mounted on
// the app's Express app (4 or 5), so `req` and `res` are Express's. The kit
// reads and writes them through Node's own API, and uses Express only for
// cookies (`res.cookie` and `res.clearCookie`, as `setSessionCookie` does).
// Failures answer `{ error: <code>, message }` with the code's HTTP status
// (RFC 0003 section 3), and nothing the routes answer is cached.

import type { IncomingMessage, ServerResponse } from "node:http";
import { httpStatus, type ErrorCode } from "../../../protocol/errors";
import type { CookieResponse } from "../sessionCookie";

/** The request the routes read: Express's, of which they use these. */
export interface AuthRouteRequest extends IncomingMessage {
  /** The path the request was made to, before any `app.use(path, ...)` mount took a prefix off. */
  readonly originalUrl?: string;
  /** The client's address, as Express reports it (`trust proxy` decides). */
  readonly ip?: string;
  /** True when the request came over HTTPS, as Express reports it. */
  readonly secure?: boolean;
  /** The body the app's own JSON parser read, if any. */
  readonly body?: unknown;
  /** The cookies `cookie-parser` read, if the app uses it. */
  readonly cookies?: unknown;
}

/** The response the routes answer: Express's, which also sets cookies. */
export type AuthRouteResponse = ServerResponse & CookieResponse;

function urlOf(req: AuthRouteRequest): string {
  return req.originalUrl ?? req.url ?? "";
}

/** The request's path, without its query. */
export function pathOf(req: AuthRouteRequest): string {
  return urlOf(req).split("?", 1)[0] ?? "";
}

/** A query parameter's first value, or `null`. */
export function queryOf(req: AuthRouteRequest, name: string): string | null {
  const url = urlOf(req);
  const start = url.indexOf("?");
  return start === -1 ? null : new URLSearchParams(url.slice(start + 1)).get(name);
}

function noStore(res: ServerResponse, status: number): void {
  res.statusCode = status;
  res.setHeader("cache-control", "no-store");
}

/** Answers with a JSON body, unless the response was already sent. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    return;
  }
  noStore(res, status);
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

/** Answers a failure: `{ error: code, message }` with the code's HTTP status. */
export function refuse(res: ServerResponse, code: ErrorCode, message: string): void {
  sendJson(res, httpStatus(code), { error: code, message });
}

/** Redirects the browser (302). */
export function redirect(res: ServerResponse, location: string): void {
  noStore(res, 302);
  res.setHeader("location", location);
  res.end();
}

/** Answers 204 with no body. */
export function noContent(res: ServerResponse): void {
  noStore(res, 204);
  res.end();
}
