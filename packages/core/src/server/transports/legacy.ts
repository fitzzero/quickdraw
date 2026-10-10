// The 4.x legacy shim (RFC 0003 section 8.5). A 4.x client connects without
// `auth.qd` and calls a method by emitting `"{service}:{method}"` with its
// payload and an acknowledgement (4.1 `src/server/ServiceRegistry.ts:277-406`).
// With `legacyWire: true` such a socket gets one `socket.use` middleware
// instead of the v5 listeners: it maps each call onto the dispatcher with
// transport `"legacy"` and answers in the 4.x `ServiceResponse` shape
// (4.1 `src/shared/types.ts:88-90`), with the error code's HTTP status as
// the numeric `code`.
//
// The shim is a middleware, not an `onAny` listener, because Socket.IO runs
// `onAny` listeners before any middleware: the rate limiter, whose middleware
// is registered first, would count a call only after the shim had started it,
// and its 429 would then take the call's acknowledgement.
//
// A call runs with the `ctx.socketId` and `ctx.rooms` of the socket it
// arrived on, and the socket gets the live data's legacy extension, which
// leaves its app rooms on disconnect (`socketio.ts`).
//
// A service renamed during the migration keeps its old name for the 4.x
// clients still calling it: `legacyWire: { aliases: { old: "new" } }` maps
// an event's service prefix onto the service it now names. The call runs as
// that service's method (its validation, access and `onCall`), and its log
// names the alias. Protocol 5, HTTP and MCP calls are never aliased.
//
// The shim serves request/response calls only. 4.x subscriptions,
// collections and channels are not served: their events match no method, so
// the shim passes them on to whatever else listens. The stock decoder reads
// both protocols, so the shim needs no parser of its own.

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

/** `createServer`'s `legacyWire` as an object: what the shim serves beyond the services' own names. */
export interface LegacyWireOptions {
  /**
   * Old service names 4.x clients still call, each mapped to the registered
   * service it now names, e.g. `{ taskService: "cardService" }`. A key may
   * not be a registered service's name or contain `:`.
   */
  readonly aliases?: Readonly<Record<string, string>>;
}

/** The legacy shim's settings, resolved from `createServer`'s `legacyWire`. */
export interface LegacyWire {
  /** Old service name to the registered service's name. */
  readonly aliases: ReadonlyMap<string, string>;
}

/**
 * Resolves `createServer`'s `legacyWire`: `undefined` when the shim is off.
 * Throws a `TypeError` naming the entry for an unknown key or an alias that
 * is empty, contains `:`, shadows a service or names no service.
 */
export function resolveLegacyWire(
  option: boolean | LegacyWireOptions | undefined,
  registered: readonly { readonly name: string }[],
): LegacyWire | undefined {
  if (option === undefined || option === false) {
    return undefined;
  }
  if (option === true) {
    return { aliases: new Map() };
  }
  if (typeof option !== "object" || option === null || Array.isArray(option)) {
    throw new TypeError("createServer: legacyWire must be a boolean or { aliases }");
  }
  for (const key of Object.keys(option)) {
    if (key !== "aliases") {
      throw new TypeError(`createServer: legacyWire has an unknown option "${key}"`);
    }
  }
  const { aliases = {} } = option;
  if (typeof aliases !== "object" || aliases === null || Array.isArray(aliases)) {
    throw new TypeError("createServer: legacyWire.aliases must map old service names to new ones");
  }
  const services = new Set(registered.map((service) => service.name));
  const resolved = new Map<string, string>();
  for (const [alias, target] of Object.entries(aliases)) {
    const entry = `legacyWire.aliases[${JSON.stringify(alias)}]`;
    if (alias === "" || alias.includes(":")) {
      throw new TypeError(`createServer: ${entry} must be a service name without ":"`);
    }
    if (services.has(alias)) {
      throw new TypeError(
        `createServer: ${entry} is a registered service's own name, so it cannot be an alias`,
      );
    }
    if (typeof target !== "string" || !services.has(target)) {
      throw new TypeError(
        `createServer: ${entry} names ${JSON.stringify(target)}, which is not a registered service`,
      );
    }
    resolved.set(alias, target);
  }
  return { aliases: resolved };
}

/**
 * The 4.x callers seen so far, one key per service name called, method and
 * principal kind. Each is logged once, so the clients still on 4.x (and
 * still on an old name) can be found.
 */
export type LegacyCallers = Set<string>;

interface LegacyTarget {
  /** The registered service, after aliases. */
  readonly service: string;
  readonly method: string;
  /** The old name the client called the service by, when it was an alias. */
  readonly alias?: string;
}

/** The registered method a 4.x event names, through `aliases`, or `undefined`. */
function targetOf(
  event: unknown,
  registry: Registry,
  aliases: ReadonlyMap<string, string>,
): LegacyTarget | undefined {
  if (typeof event !== "string") {
    return undefined;
  }
  const colon = event.indexOf(":");
  const called = event.slice(0, colon);
  const method = event.slice(colon + 1);
  const service = aliases.get(called);
  if (colon <= 0 || registry.find(service ?? called, method) === undefined) {
    return undefined;
  }
  return service === undefined ? { service: called, method } : { service, method, alias: called };
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
  const { service, method, alias } = target;
  const key = `${alias ?? service}\u0000${method}\u0000${kind}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  const as = alias === undefined ? "" : ` as ${alias}.${method}`;
  context.logger.warn(`A 4.x client called ${service}.${method}${as} through the legacy shim`, {
    category: "quickdraw.legacy",
    ...target,
    principalKind: kind,
  });
}

function serve(
  socket: QuickdrawServerSocket,
  context: SocketContext,
  calls: Set<AbortController>,
  call: {
    readonly service: string;
    readonly method: string;
    readonly input: unknown;
    readonly ack: Acknowledge;
  },
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
 * Serves a 4.x socket: one `socket.use` middleware for its calls, the
 * `auth:info` event 4.x clients read their identity from
 * (4.1 `src/server/createServer.ts:134-140`), and cancellation of its
 * calls on disconnect. Call it from the `connection` handler, after the rate
 * limiter's middleware is in place, so the limiter sees each call first. A
 * call the shim serves goes no further; any other event passes on. An event
 * whose service prefix is one of `wire.aliases` runs as the service it maps
 * to; `auth:info` lists grants by the services' own names only.
 */
export function attachLegacyShim(
  socket: QuickdrawServerSocket,
  context: SocketContext,
  seen: LegacyCallers,
  wire: LegacyWire,
): void {
  const calls = new Set<AbortController>();
  socket.use((packet: unknown[], next) => {
    const [event, ...args] = packet;
    const ack = args.at(-1);
    const target = targetOf(event, context.dispatcher.registry, wire.aliases);
    if (target === undefined || typeof ack !== "function") {
      next();
      return;
    }
    noteCaller(context, seen, target, socket.data.principal);
    const input = args.length > 1 ? args[0] : undefined;
    const { service, method } = target;
    serve(socket, context, calls, { service, method, input, ack: ack as Acknowledge });
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
