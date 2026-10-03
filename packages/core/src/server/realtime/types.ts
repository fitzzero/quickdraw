// The server's types for presence, streams, channels and typed room events
// (RFC 0003 sections 3 and 12.5): `ctx.rooms`, `ctx.presence` (also
// `server.presence`), `qd.stream(contract, name)`, and a service's channel
// handlers in `defineService`.

import type { AccessLevel } from "../../contract/access";
import type { AnyContract } from "../../contract/defineContract";
import type {
  ChannelName,
  ChannelPayloadOf,
  EventName,
  EventPayloadOf,
  IsScopedStream,
  StreamItemOf,
  StreamName,
} from "../../contract/infer";
import type { Logger } from "../../contract/logger";
import type { StandardSchemaV1 } from "../../contract/standardSchema";
import type { AccessForm } from "../access/types";
import type { Principal, PrincipalOf, QuickdrawTypes } from "../types";

/**
 * Who is online and who is in a room (RFC 0003 section 12.5): `ctx.presence`,
 * `server.presence`, `qd.presence`. Every answer is a promise: on a server
 * with the in-memory adapter it comes from this process's sockets; behind a
 * cluster adapter (Redis) it asks every node (`io.in(room).fetchSockets()`).
 */
export interface Presence {
  /** True while the user has a socket connected (on any node). */
  isOnline(userId: string): Promise<boolean>;
  /**
   * When the user was last connected, in milliseconds since the epoch: now
   * while online, else when their last socket on this process disconnected.
   * `null` when this process has not seen them since it started (it keeps
   * the 100,000 users seen last).
   */
  lastSeen(userId: string): Promise<number | null>;
  /** How many users have a socket in `room`. Anonymous sockets do not count. */
  count(room: string): Promise<number>;
  /** The ids of the users with a socket in `room`, each once. */
  users(room: string): Promise<string[]>;
}

/**
 * `ctx.rooms` (RFC 0003 sections 3, 12.5 and 15): app-defined rooms the
 * calling socket joins and leaves, and typed room events. It replaces 4.1's
 * `emitToRoom` and `emitToUserRoom` (`legacy-src/server/BaseService.ts:378-441`).
 */
export interface ContextRooms {
  /**
   * Puts the calling socket in an app-defined room (a lobby), so it receives
   * the room's events and `qd:presence` frames. Returns `false`, doing
   * nothing, for a call that did not arrive over a socket (HTTP, MCP, in
   * process). Room names starting with `qd:` or `user:` are refused with
   * `VALIDATION` (those rooms are joined only through their authorized
   * paths), as are empty names and names over 256 characters; a socket in
   * 100 app rooms is refused another with `CONFLICT`.
   */
  join(room: string): boolean;
  /** Takes the calling socket out of an app room; `false` when it was not in it, or the call has no socket. */
  leave(room: string): boolean;
  /**
   * Sends the contract's event to every socket in `room` as `qd:event`. The
   * payload is checked against the event's schema first: a payload that
   * fails it throws `INTERNAL` and nothing is sent. Without a server it does
   * nothing more.
   */
  emit<C extends AnyContract, E extends EventName<C>>(
    room: string,
    contract: C,
    event: E,
    payload: EventPayloadOf<C, E>,
  ): void;
  /** `emit` to every socket of one user (their `user:{userId}` room). */
  emitToUser<C extends AnyContract, E extends EventName<C>>(
    userId: string,
    contract: C,
    event: E,
    payload: EventPayloadOf<C, E>,
  ): void;
}

/** The arguments of a stream's `push`: `(scope, item)` for a scoped stream, `(item)` for a global one. */
export type StreamPushArgs<C extends AnyContract, K extends StreamName<C>> =
  IsScopedStream<C, K> extends true
    ? [scope: string, item: StreamItemOf<C, K>]
    : [item: StreamItemOf<C, K>];

/** What `qd.stream(contract, name)` returns. */
export interface StreamHandle<C extends AnyContract, K extends StreamName<C>> {
  /**
   * Appends an item to the stream (one scope of it, for a scoped stream):
   * checked against the stream's item schema (a mismatch throws `INTERNAL`),
   * kept in the scope's seed when the stream declares one, and sent to every
   * subscriber as `qd:stream`, volatile when the stream says so.
   */
  push(...args: StreamPushArgs<C, K>): void;
}

/** Who may send on a channel besides its `requires`: any principal, or a service-wide grant. */
export type ChannelAccess = "authenticated" | { readonly service: AccessLevel };

/**
 * What a channel handler receives beside the payload. Channels need a
 * principal, so `principal` is never `null`.
 */
export interface ChannelContext<P = Principal> {
  readonly principal: P;
  /** The socket the message arrived on. */
  readonly socketId: string;
  /** The dispatcher's logger. Messages are not logged one by one. */
  readonly log: Logger;
  /** Joins and leaves apply to the sending socket. */
  readonly rooms: ContextRooms;
  readonly presence: Presence;
}

/** A channel's handler. It runs synchronously per message; a promise it returns is not awaited. */
export type ChannelHandler<T extends QuickdrawTypes, Payload> = (
  payload: Payload,
  ctx: ChannelContext<PrincipalOf<T>>,
) => void | PromiseLike<void>;

/** One channel's implementation in `defineService`: its handler, or `{ access, handler }`. */
export type ChannelImplementation<T extends QuickdrawTypes, Payload> =
  | ChannelHandler<T, Payload>
  | {
      /** Default `"authenticated"`. */
      readonly access?: ChannelAccess;
      readonly handler: ChannelHandler<T, Payload>;
    };

/** `defineService`'s `channels`: one implementation per channel of the contract. */
export type ChannelOptions<T extends QuickdrawTypes, C extends AnyContract> = {
  readonly [K in ChannelName<C>]: ChannelImplementation<T, ChannelPayloadOf<C, K>>;
};

/** `{ channels }` is required when the contract declares channels: every message needs a handler. */
export type ChannelsRequired<C extends AnyContract> = [ChannelName<C>] extends [never]
  ? unknown
  : { readonly channels: unknown };

/**
 * `socket.data.appRooms`: the app rooms the socket joined through
 * `ctx.rooms.join`, by name. Plain data, in an object without a prototype.
 */
export type AppRooms = Record<string, true>;

/**
 * `socket.data.streams`: the socket's stream subscriptions (`qd:stream:sub`),
 * by room. Plain data, in an object without a prototype.
 */
export type StreamSubscriptions = Record<string, true>;

/** A channel handler as the dispatcher calls it, whatever its declared types. */
export type AnyChannelHandler = (payload: unknown, ctx: ChannelContext) => unknown;

/** Where a channel requirement reads its row id or scope value from a parsed payload. */
export type CompiledSelector = (payload: unknown) => string | undefined;

/** One channel of a defined service, checked and ready to serve. */
export interface ServiceChannel {
  /** The service name. */
  readonly service: string;
  readonly name: string;
  readonly payload: StandardSchemaV1;
  readonly ratePerSecond: number;
  readonly burst: number;
  readonly requires:
    | { readonly kind: "entity"; readonly select: CompiledSelector }
    | {
        readonly kind: "collection";
        readonly collection: string;
        readonly select: CompiledSelector;
      }
    | undefined;
  readonly access: ChannelAccess;
  readonly handler: AnyChannelHandler;
}

/** One stream of a defined service, checked and ready to serve. */
export interface ServiceStream {
  readonly name: string;
  readonly item: StandardSchemaV1;
  /** True for a stream with one feed per scope value. */
  readonly scoped: boolean;
  readonly seed: number;
  readonly volatile: boolean;
  /**
   * The contract's access form as the access engine decides it, with the
   * scope as the `id` of an `entry` or `scope` form (the engine's input is
   * `{ scope }`); `undefined` for a closed stream.
   */
  readonly access: AccessForm | undefined;
}
