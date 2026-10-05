// The argument every handler receives, `{ input, ctx, db }` (RFC 0003
// section 3). `ctx` replaces 4.1's `ServiceMethodContext` (`userId`,
// `socketId`, `serviceAccess`; `legacy-src/shared/types.ts:111-115`) and the
// habit of overriding `defineMethod` to add fields: an app adds its own
// fields once, through `initQuickdraw({ context })`.

import type { AnyContract } from "../contract/defineContract";
import type { Logger } from "../contract/logger";
import { QuickdrawError } from "../protocol/errors";
import type { DispatcherAccess, PolicyEngine } from "./access/api";
import { createCaller, type CallerFor } from "./caller";
import type { Dispatch } from "./pipeline/pipeline";
import type { ContextRooms, Presence } from "./realtime/types";
import type { AnyService } from "./service";
import type { StorageAdapter } from "./storage";
import type {
  ContextExtensionOf,
  DbOf,
  McpContext,
  McpContextOf,
  Principal,
  PrincipalOf,
  QuickdrawTypes,
  Transport,
} from "./types";

/** Options of `ctx.touch`. */
export interface TouchOptions {
  /** The rows were deleted rather than changed. */
  readonly removed?: boolean;
}

/**
 * `ctx.services`: in-process callers for the app's services (RFC 0003
 * sections 3 and 10), by service name: `ctx.services.projectService.get(input)`.
 * A call runs the whole pipeline (input check, access, handler, output
 * check) as the calling principal with transport `"internal"`, its writes
 * join the calling method's unit of work (one flush for both), and it is
 * cancelled with `ctx.signal`. Typed by the `contracts` of the app's types,
 * like `qd.caller`; untyped without them.
 */
export type ContextServices<T extends QuickdrawTypes = QuickdrawTypes> = CallerFor<T>;

export type { ContextRooms, Presence };

/**
 * The fields of `ctx` the framework provides, whatever the app adds. `M` is
 * the type of `ctx.mcp`.
 */
export interface BaseContext<P = Principal, M = McpContext> {
  /**
   * Who is calling. `null` only in a `"public"` method called without
   * credentials; every other access form guarantees a principal.
   */
  readonly principal: P;
  /**
   * Aborts when the call is cancelled (a query whose callers all cancelled)
   * or runs past its time limit. Pass it to anything that can stop early.
   */
  readonly signal: AbortSignal;
  /** A logger bound to this call's service, method and request id. */
  readonly log: Logger;
  /** Identifies this call in logs and in its completion record. */
  readonly requestId: string;
  /** How the call arrived. */
  readonly transport: Transport;
  /**
   * The socket the call arrived on: its id, as the client socket's `id`,
   * `onRoomLeave`'s `socketId` and a channel handler's `ctx.socketId` name
   * it (a game keys a player's input by it). `undefined` for a call that
   * did not arrive over a socket: HTTP, MCP, in process, `ctx.services`. In
   * a method that shares its runs (`share`), the first caller's.
   */
  readonly socketId?: string;
  /**
   * The fields the MCP bridge's `context` option produced for this call, such
   * as the scopes of the agent's token; typed by `QuickdrawTypes["mcp"]`.
   * `undefined` unless the call arrived over MCP.
   */
  readonly mcp?: M;
  /**
   * Records writes the tracked database client cannot see, raw SQL and
   * database cascades (RFC 0003 section 5.2), as if the client had made
   * them here: inside an open `db.$transaction` they join it and are dropped
   * on rollback. `target` is the model name (`"task"`); `removed` marks the
   * rows deleted. Does nothing when the dispatcher's `db` is not tracked.
   */
  touch(
    target: string | AnyContract,
    ids: string | readonly string[],
    options?: TouchOptions,
  ): void;
  /**
   * In-process callers for the app's services, as this call's principal:
   * `await ctx.services.projectService.get({ id })`. See {@link ContextServices}.
   */
  readonly services: ContextServices;
  /**
   * App-defined rooms the calling socket joins and leaves (`join` answers
   * `false` for a call without a socket), and typed room events: `emit` and
   * `emitToUser` (RFC 0003 section 12.5).
   */
  readonly rooms: ContextRooms;
  /** Who is online, when they were last seen, and who is in a room (RFC 0003 section 12.5). */
  readonly presence: Presence;
}

/**
 * A handler's `ctx`: the framework's fields plus the app's own from
 * `initQuickdraw({ context })`. An app field cannot replace a framework field.
 */
export type HandlerContext<T extends QuickdrawTypes, P = PrincipalOf<T>> = Omit<
  ContextExtensionOf<T>,
  keyof BaseContext
> &
  Omit<BaseContext<P, McpContextOf<T>>, "services"> & {
    /** In-process callers for the app's services, typed by its `contracts`. */
    readonly services: ContextServices<T>;
  };

/** What a handler receives: the parsed input, the call's context and the app's database client. */
export interface HandlerArgs<T extends QuickdrawTypes, Input, P = PrincipalOf<T>> {
  /** The input after its schema ran: defaults applied, transforms done. */
  readonly input: Input;
  readonly ctx: HandlerContext<T, P>;
  /** The database client given to the dispatcher, passed through unchanged. */
  readonly db: DbOf<T>;
}

/** Any handler's `ctx`, as the pipeline handles it. */
export type AnyContext = BaseContext<Principal | null>;

/**
 * What `qd.run(fn)` and `dispatcher.run(fn)` give `fn`: the part of a
 * handler's `ctx` that means something outside a method call. A job has no
 * caller, so `principal` is `null`. A `fn` that takes no parameter still
 * works.
 *
 * @example
 * await qd.run(async (ctx) => {
 *   const ids = await renumberWithSql(projectId);
 *   ctx.touch("task", ids);
 * });
 */
export interface RunContext {
  /** `ctx.touch`: records rows the tracked client cannot see (raw SQL, cascades) in this run's unit of work. */
  readonly touch: BaseContext["touch"];
  /** The dispatcher's logger, bound to this run's request id. */
  readonly log: Logger;
  readonly principal: null;
}

/** Options of `qd.run(fn, options)` and `dispatcher.run(fn, options)`. */
export interface RunOptions {
  /**
   * Run `fn` in a unit of work of its own even inside a method call or a
   * transaction: for background work a handler starts and does not await
   * (a push sent after the reply, pruning what it reports dead). Its writes
   * flush once `fn` settles, on their own, instead of joining the handler's
   * unit, which may have flushed long before (they would then flush as
   * ambient writes, with a development warning). A failed flush is logged.
   * Default `false`: inside an open unit of work or transaction, `fn` joins
   * it.
   *
   * @example
   * // in a handler, not awaited: the reply does not wait for the push
   * void qd.run(() => sendPushes(db, message), { detached: true }).catch((error) => {
   *   ctx.log.error("Pushing the message failed", { error: String(error) });
   * });
   */
  readonly detached?: boolean;
}

/** Builds the app's fields of `ctx` from the framework's: the `context` option of `initQuickdraw`. */
export type ContextExtender = (base: AnyContext) => object;

/**
 * What the framework's kits (RFC 0003 section 12) know about the call a
 * `ctx` belongs to: the service whose method runs, and the dispatcher's
 * access policies and storage adapter. A kit's handlers are made before any
 * dispatcher exists, so they find these through `kitRuntimeOf(ctx)`. It is
 * never a member of `ctx`.
 */
export interface KitRuntime {
  readonly service: AnyService;
  /** `dispatcher.access`, and `resolve` for levels without service grants (a collection scope's). */
  readonly access: DispatcherAccess & Pick<PolicyEngine, "resolve">;
  readonly storage: StorageAdapter | undefined;
  /** How many sockets sit in a room, for the admin kit's subscriber counts. */
  readonly occupancy?: RoomOccupancy;
  /**
   * The revision a read made from now on is no older than (the search
   * kit's pages): the process's last one, or behind a cluster's counter the
   * counter's.
   */
  readonly claimRevision?: () => number | Promise<number>;
  /**
   * Runs `fn` in a detached unit of work of the dispatcher, as
   * `qd.run(fn, { detached: true })` does: a kit's work after its call (the
   * admin kit's `onCommitted`), whose writes flush on their own.
   */
  readonly runDetached?: (fn: () => unknown) => Promise<unknown>;
}

/** The sockets in a room (RFC 0003 section 6), as this process sees its rooms. */
export interface RoomOccupancy {
  /** This process's sockets in `room`: none without a server. */
  sockets(room: string): number;
  /**
   * `true` when this process sees every socket: its server has no cluster
   * adapter (Redis), or there is no server.
   */
  complete(): boolean;
}

/**
 * The per-call fields the dispatcher fills in. `touch` is the dispatcher's
 * (its tracked writes), `rooms` and `presence` its live data's, `dispatch`
 * its own dispatch function, which `ctx.services` calls through; a context
 * built without them gets a `touch` that does nothing, `rooms` that join
 * nothing and send nothing, a `presence` that sees nobody, and `services`
 * that throw `INTERNAL`. `kit` is kept beside the context, never on it.
 */
export type ContextFields = Pick<
  AnyContext,
  "principal" | "signal" | "log" | "requestId" | "transport" | "socketId" | "mcp"
> &
  Partial<Pick<AnyContext, "touch" | "rooms" | "presence">> & {
    readonly kit?: KitRuntime;
    readonly dispatch?: Dispatch;
  };

const KIT_RUNTIMES = new WeakMap<object, KitRuntime>();
const SERVICE_CALLERS = new WeakMap<object, (signal: AbortSignal) => ContextServices>();

/**
 * The kit runtime of the call `ctx` belongs to, or `undefined` for a
 * context no dispatcher built.
 */
export function kitRuntimeOf(ctx: object): KitRuntime | undefined {
  return KIT_RUNTIMES.get(ctx);
}

function withRuntime<Ctx extends object>(
  ctx: Ctx,
  runtime: KitRuntime | undefined,
  services: ((signal: AbortSignal) => ContextServices) | undefined,
): Ctx {
  if (runtime !== undefined) {
    KIT_RUNTIMES.set(ctx, runtime);
  }
  if (services !== undefined) {
    SERVICE_CALLERS.set(ctx, services);
  }
  return ctx;
}

/** A signal that never aborts, for calls that cannot be cancelled. */
export const NEVER_ABORTED: AbortSignal = new AbortController().signal;

function notAvailable(member: string): QuickdrawError {
  return new QuickdrawError(
    "INTERNAL",
    `${member} needs a dispatcher: it calls through the dispatcher that runs the method`,
  );
}

function untracked(): void {
  // Without tracked writes there is nothing to record.
}

// Names that inspection, serialization and test matchers read from any
// object. They answer `undefined` so logging a `ctx` never throws.
const INSPECTED = new Set([
  "then",
  "toJSON",
  "constructor",
  "toString",
  "valueOf",
  "asymmetricMatch",
  "$$typeof",
  "nodeType",
]);

function unavailable(member: string): ContextServices {
  return new Proxy(Object.freeze({}), {
    get(_target, key) {
      if (typeof key === "symbol" || INSPECTED.has(key)) {
        return undefined;
      }
      throw notAvailable(`${member}.${key}`);
    },
  });
}

const SERVICES: ContextServices = unavailable("ctx.services");

/** The `ctx.rooms` of a context no dispatcher built: no socket to join with, no server to send through. */
const NO_ROOMS: ContextRooms = Object.freeze({
  join: () => false,
  leave: ((_room: string, target?: unknown) =>
    target === undefined ? false : Promise.resolve()) as ContextRooms["leave"],
  emit: untracked,
  emitToUser: untracked,
  size: () => 0,
});

/** The `ctx.presence` of a context no dispatcher built: no server, so nobody is online. */
const NO_PRESENCE: Presence = Object.freeze({
  isOnline: () => Promise.resolve(false),
  lastSeen: () => Promise.resolve(null),
  count: () => Promise.resolve(0),
  users: () => Promise.resolve([]),
});

/**
 * `ctx.services` for a signal: callers acting as `principal` through
 * `dispatch`, every call cancelled with the signal.
 */
function servicesOf(
  dispatch: Dispatch | undefined,
  principal: Principal | null,
): ((signal: AbortSignal) => ContextServices) | undefined {
  if (dispatch === undefined) {
    return undefined;
  }
  return (signal) => createCaller(() => dispatch, principal, { signal }) as ContextServices;
}

/**
 * Builds a call's `ctx`: the framework's fields, then the app's fields from
 * `extend`. The framework's fields win when the names collide.
 */
export function createContext(fields: ContextFields, extend?: ContextExtender): AnyContext {
  const { kit, dispatch, ...own } = fields;
  const services = servicesOf(dispatch, own.principal);
  const base: AnyContext = Object.freeze({
    ...own,
    touch: own.touch ?? untracked,
    services: services?.(own.signal) ?? SERVICES,
    rooms: own.rooms ?? NO_ROOMS,
    presence: own.presence ?? NO_PRESENCE,
  });
  if (extend === undefined) {
    return withRuntime(base, kit, services);
  }
  return withRuntime(Object.freeze({ ...extend(base), ...base }), kit, services);
}

/**
 * The same `ctx` with another signal: the one a handler run aborts. Its
 * `ctx.services` calls are cancelled with that signal.
 */
export function withSignal(ctx: AnyContext, signal: AbortSignal): AnyContext {
  const services = SERVICE_CALLERS.get(ctx);
  const next =
    services === undefined ? { ...ctx, signal } : { ...ctx, signal, services: services(signal) };
  return withRuntime(Object.freeze(next), KIT_RUNTIMES.get(ctx), services);
}
