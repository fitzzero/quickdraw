// The 4.x legacy shim (RFC 0003 section 8.5). A 4.x client connects without
// `auth.qd` and calls a method by emitting `"{service}:{method}"` with its
// payload and an acknowledgement (`legacy-src/server/ServiceRegistry.ts:277-406`).
// With `legacyWire: true` such a socket gets one `onAny` listener instead of
// the v5 listeners: it maps each call onto the dispatcher with transport
// `"legacy"` and answers in the 4.x `ServiceResponse` shape
// (`legacy-src/shared/types.ts:88-90`), with the error code's HTTP status as
// the numeric `code`.
//
// The shim serves request/response calls only. 4.x subscriptions,
// collections and channels are not served: their events match no method, so
// the shim leaves them to whatever else listens. The stock decoder reads both
// protocols, so the shim needs no parser of its own.

import { httpStatus, toWire, type ErrorCode } from "../../protocol/errors";
import { describeError } from "../pipeline/metrics";
import type { DispatchResult } from "../pipeline/request";
import type { Registry } from "../registry";
import type { Principal } from "../types";
import { acknowledge, type Acknowledge } from "./ack";
import type { QuickdrawServerSocket, SocketContext } from "./types";

/** 4.x's `ServiceResponse`, the shape every reply of the shim takes. */
export type LegacyReply =
  | { readonly success: true; readonly data: unknown }
  | { readonly success: false; readonly error: string; readonly code: number };

/** A 4.x failure with the HTTP status of `code`. */
export function legacyFailure(code: ErrorCode, error: string): LegacyReply {
  return { success: false, error, code: httpStatus(code) };
}

/** A dispatch result in the 4.x reply shape. An `INTERNAL` failure keeps the generic message. */
export function toLegacyReply(result: DispatchResult): LegacyReply {
  if (!result.ok) {
    const wire = toWire(result.error);
    return legacyFailure(wire.code, wire.message);
  }
  return { success: true, data: result.notModified === true ? undefined : result.data };
}

const LEGACY_INTERNAL: LegacyReply = Object.freeze(legacyFailure("INTERNAL", "Internal error"));

/**
 * The 4.x callers seen so far, one key per service, method and principal
 * kind. Each is logged once, so the clients still on 4.x can be found.
 */
export type LegacyCallers = Set<string>;

interface LegacyTarget {
  readonly service: string;
  readonly method: string;
}

/** The registered method a 4.x event names, or `undefined`. */
function targetOf(event: unknown, registry: Registry): LegacyTarget | undefined {
  if (typeof event !== "string") {
    return undefined;
  }
  const colon = event.indexOf(":");
  const service = event.slice(0, colon);
  const method = event.slice(colon + 1);
  if (colon <= 0 || registry.find(service, method) === undefined) {
    return undefined;
  }
  return { service, method };
}

function principalKind(principal: Principal | null): string {
  if (principal === null) {
    return "anonymous";
  }
  return principal.kind ?? "unspecified";
}

function noteCaller(
  context: SocketContext,
  seen: LegacyCallers,
  target: LegacyTarget,
  principal: Principal | null,
): void {
  const kind = principalKind(principal);
  const key = `${target.service}\u0000${target.method}\u0000${kind}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  context.logger.warn(
    `A 4.x client called ${target.service}.${target.method} through the legacy shim`,
    { category: "quickdraw.legacy", ...target, principalKind: kind },
  );
}

function serve(
  socket: QuickdrawServerSocket,
  context: SocketContext,
  calls: Set<AbortController>,
  call: LegacyTarget & { readonly input: unknown; readonly ack: Acknowledge },
): void {
  const controller = new AbortController();
  calls.add(controller);
  const report = (error: unknown): void => {
    context.logger.error("A 4.x call's reply could not be encoded; it was answered with 500", {
      category: "quickdraw.legacy",
      socketId: socket.id,
      error: describeError(error),
    });
  };
  const release = (): void => {
    calls.delete(controller);
  };
  void context.dispatcher
    .call({
      service: call.service,
      method: call.method,
      input: call.input,
      principal: socket.data.principal,
      transport: "legacy",
      connectionId: socket.id,
      signal: controller.signal,
      respond: (result) =>
        acknowledge(context.meter, call.ack, toLegacyReply(result), LEGACY_INTERNAL, report),
    })
    .then(release, release);
}

/**
 * Serves a 4.x socket: one `onAny` listener for its calls, the `auth:info`
 * event 4.x clients read their identity from
 * (`legacy-src/server/createServer.ts:134-140`), and cancellation of its
 * calls on disconnect.
 */
export function attachLegacyShim(
  socket: QuickdrawServerSocket,
  context: SocketContext,
  seen: LegacyCallers,
): void {
  const calls = new Set<AbortController>();
  socket.onAny((event: unknown, ...args: unknown[]) => {
    const ack = args.at(-1);
    const target = targetOf(event, context.dispatcher.registry);
    if (target === undefined || typeof ack !== "function") {
      return;
    }
    noteCaller(context, seen, target, socket.data.principal);
    const input = args.length > 1 ? args[0] : undefined;
    serve(socket, context, calls, { ...target, input, ack: ack as Acknowledge });
  });
  socket.on("disconnect", () => {
    for (const controller of calls) {
      controller.abort();
    }
    calls.clear();
  });
  const { principal } = socket.data;
  socket.emit("auth:info", {
    userId: principal?.userId ?? null,
    serviceAccess: principal?.serviceAccess ?? {},
    principalType: principal?.kind,
  });
}
