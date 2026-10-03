// The argument every handler receives, `{ input, ctx, db }` (RFC 0003
// section 3). `ctx` replaces 4.1's `ServiceMethodContext` (`userId`,
// `socketId`, `serviceAccess`; `legacy-src/shared/types.ts:111-115`) and the
// habit of overriding `defineMethod` to add fields: an app adds its own
// fields once, through `initQuickdraw({ context })`.

import type { AnyContract } from "../contract/defineContract";
import type { Logger } from "../contract/logger";
import { QuickdrawError } from "../protocol/errors";
import type { DispatcherAccess } from "./access/api";
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
 * `ctx.services`: typed in-process callers for the app's other services
 * (RFC 0003 section 10). A seam: it has no members until a later card
 * implements it, and reaching into it throws `INTERNAL`.
 */
export type ContextServices = Readonly<Record<never, never>>;

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
  /** Typed callers for the app's other services. Not implemented yet; see {@link ContextServices}. */
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
  BaseContext<P, McpContextOf<T>>;

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
  readonly access: DispatcherAccess;
  readonly storage: StorageAdapter | undefined;
  /** How many sockets sit in a room, for the admin kit's subscriber counts. */
  readonly occupancy?: RoomOccupancy;
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
 * (its tracked writes), `rooms` and `presence` its live data's; a context
 * built without them gets a `touch` that does nothing, `rooms` that join
 * nothing and send nothing, and a `presence` that sees nobody. `kit` is kept
 * beside the context, never on it.
 */
export type ContextFields = Pick<
  AnyContext,
  "principal" | "signal" | "log" | "requestId" | "transport" | "mcp"
> &
  Partial<Pick<AnyContext, "touch" | "rooms" | "presence">> & { readonly kit?: KitRuntime };

const KIT_RUNTIMES = new WeakMap<object, KitRuntime>();

/**
 * The kit runtime of the call `ctx` belongs to, or `undefined` for a
 * context no dispatcher built.
 */
export function kitRuntimeOf(ctx: object): KitRuntime | undefined {
  return KIT_RUNTIMES.get(ctx);
}

function withRuntime<Ctx extends object>(ctx: Ctx, runtime: KitRuntime | undefined): Ctx {
  if (runtime !== undefined) {
    KIT_RUNTIMES.set(ctx, runtime);
  }
  return ctx;
}

/** A signal that never aborts, for calls that cannot be cancelled. */
export const NEVER_ABORTED: AbortSignal = new AbortController().signal;

function notAvailable(member: string): QuickdrawError {
  return new QuickdrawError(
    "INTERNAL",
    `${member} is not available yet in quickdraw 5.0: it arrives with a later 5.0 card`,
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

function unavailable(member: string): Readonly<Record<never, never>> {
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
  leave: () => false,
  emit: untracked,
  emitToUser: untracked,
});

/** The `ctx.presence` of a context no dispatcher built: no server, so nobody is online. */
const NO_PRESENCE: Presence = Object.freeze({
  isOnline: () => Promise.resolve(false),
  lastSeen: () => Promise.resolve(null),
  count: () => Promise.resolve(0),
  users: () => Promise.resolve([]),
});

/**
 * Builds a call's `ctx`: the framework's fields, then the app's fields from
 * `extend`. The framework's fields win when the names collide.
 */
export function createContext(fields: ContextFields, extend?: ContextExtender): AnyContext {
  const { kit, ...own } = fields;
  const base: AnyContext = Object.freeze({
    ...own,
    touch: own.touch ?? untracked,
    services: SERVICES,
    rooms: own.rooms ?? NO_ROOMS,
    presence: own.presence ?? NO_PRESENCE,
  });
  if (extend === undefined) {
    return withRuntime(base, kit);
  }
  return withRuntime(Object.freeze({ ...extend(base), ...base }), kit);
}

/** The same `ctx` with another signal: the one a handler run aborts. */
export function withSignal(ctx: AnyContext, signal: AbortSignal): AnyContext {
  return withRuntime(Object.freeze({ ...ctx, signal }), KIT_RUNTIMES.get(ctx));
}
