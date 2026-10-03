// Which stream feed a `qd:stream:sub` or `qd:stream:unsub` frame names, and
// whether the socket may subscribe to it (RFC 0003 sections 8.2 and 12.5).
//
// A frame is `{ s, stream, scope? }`: `VALIDATION` when it is malformed or
// its scope does not fit the stream (a scoped stream needs a scope of 1 to
// 256 characters, a global stream takes none), `NOT_FOUND` for an unknown
// service or stream. A subscriber is authorized with the stream's access
// form through the dispatcher's access engine, as a method call with input
// `{ scope }` would be: the scope is the row an `entry` or `scope` form
// checks. A stream whose contract declares no access is closed: `FORBIDDEN`
// for everyone.

import { streamRoom } from "../../contract/names";
import { QuickdrawError } from "../../protocol/errors";
import { MAX_SCOPE_LENGTH } from "../../protocol/version";
import { createContext, NEVER_ABORTED } from "../context";
import type { Hub } from "../emit/hub";
import type { AnyService } from "../service";
import { unreadable } from "../transports/ack";
import type { QuickdrawServerSocket } from "../transports/types";
import type { ServiceStream } from "./types";

/** One feed of a served stream: one scope of a scoped stream, or a global stream. */
export interface StreamTarget {
  readonly service: AnyService;
  readonly stream: ServiceStream;
  /** The scope of a scoped stream; `undefined` for a global stream. */
  readonly scope: string | undefined;
  /** The feed's room: `streamRoom(service, stream, scope)`. */
  readonly room: string;
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** Why `scope` cannot name a feed of `stream`, or `undefined` when it can. */
export function scopeProblem(stream: ServiceStream, scope: unknown): string | undefined {
  if (!stream.scoped) {
    return scope === undefined ? undefined : `${stream.name} is a global stream: it takes no scope`;
  }
  return isName(scope) && scope.length <= MAX_SCOPE_LENGTH
    ? undefined
    : `${stream.name} is scoped: its scope is a string of 1 to ${MAX_SCOPE_LENGTH} characters`;
}

/**
 * The feed a `qd:stream:sub` or `qd:stream:unsub` frame names. Throws
 * `VALIDATION` for a malformed frame or a scope that does not fit, and
 * `NOT_FOUND` for an unknown service or stream (also one named `__proto__`:
 * services and streams are `Map`s).
 */
export function streamTarget(hub: Hub, value: unknown, event: string): StreamTarget {
  const frame =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Readonly<Record<string, unknown>>)
      : {};
  if (!isName(frame.s) || !isName(frame.stream)) {
    throw unreadable(
      `A ${event} frame needs { s, stream, scope? } with s and stream non-empty strings`,
    );
  }
  const service = hub.registry.services.get(frame.s);
  if (service === undefined) {
    throw new QuickdrawError("NOT_FOUND", `Unknown service "${frame.s}"`);
  }
  const stream = service.streams.get(frame.stream);
  if (stream === undefined) {
    throw new QuickdrawError("NOT_FOUND", `${frame.s} has no stream "${frame.stream}"`);
  }
  const problem = scopeProblem(stream, frame.scope);
  if (problem !== undefined) {
    throw unreadable(problem, ["scope"]);
  }
  const scope = frame.scope as string | undefined;
  return { service, stream, scope, room: streamRoom(service.name, stream.name, scope) };
}

/**
 * Authorizes a subscriber of `target`: rejects with `FORBIDDEN` for a closed
 * stream, and otherwise as the access engine decides the stream's form
 * (`UNAUTHENTICATED` for an anonymous socket unless the form is `"public"`).
 */
export async function authorizeStream(
  hub: Hub,
  socket: QuickdrawServerSocket,
  target: StreamTarget,
): Promise<void> {
  const form = target.stream.access;
  if (form === undefined) {
    throw new QuickdrawError(
      "FORBIDDEN",
      `${target.service.name}.${target.stream.name} is closed: its contract declares no access`,
    );
  }
  const { principal } = socket.data;
  const ctx = createContext({
    principal,
    signal: NEVER_ABORTED,
    log: hub.logger,
    requestId: crypto.randomUUID(),
    transport: "socket",
  });
  const input = { scope: target.scope };
  await hub.access.authorize(form, {
    service: target.service,
    method: target.stream.name,
    principal,
    input,
    ctx,
  });
}

/** An unsubscribe needs a principal, unless the stream is public. */
export function checkUnsubscriber(socket: QuickdrawServerSocket, target: StreamTarget): void {
  if (socket.data.principal === null && target.stream.access !== "public") {
    throw new QuickdrawError("UNAUTHENTICATED", "Authentication required");
  }
}
