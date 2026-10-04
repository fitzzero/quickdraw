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
import type { RunContext } from "../context";
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

/** Whose sockets `rooms.leave(room, target)` takes out of a room: every socket of one user. */
export interface RoomTarget {
  readonly userId: string;
}

/**
 * App rooms from code that is not a handler (a game loop, a job, a webhook):
 * `qd.rooms`, `server.rooms` and `dispatcher.rooms`, the half of `ctx.rooms`
 * that needs no calling socket. Behind a cluster adapter each reaches every
 * node.
 *
 * @example
 * // a game loop's tick, outside any handler
 * qd.rooms.emit(WORLD_ROOM, gameContract, "death", { id: playerId });
 * // a moderator removed a member: their sockets stop hearing the room
 * await qd.rooms.leave(chatRoom(chatId), { userId });
 */
export interface ServerRooms {
  /**
   * Sends the contract's event to every socket in `room` as `qd:event`, on
   * every node. The payload is checked against the event's schema first: a
   * payload that fails it throws `INTERNAL` and nothing is sent. Without a
   * server it does nothing more.
   */
  emit<C extends AnyContract, E extends EventName<C>>(
    room: string,
    contract: C,
    event: E,
    payload: EventPayloadOf<C, E>,
  ): void;
  /** `emit` to every socket of one user (their `user:{userId}` room), on every node. */
  emitToUser<C extends AnyContract, E extends EventName<C>>(
    userId: string,
    contract: C,
    event: E,
    payload: EventPayloadOf<C, E>,
  ): void;
  /**
   * Takes every socket of `target.userId` out of the app room `room`, on
   * every node: they stop receiving the room's events and `qd:presence`
   * frames, and a channel that `requires: { room }` drops their messages.
   * Each socket taken out gets `qd:presence { room, users: [] }`, as after
   * its own leave, and `onRoomLeave` hears of it with reason `"removed"`.
   * Behind a cluster adapter the request is broadcast and answered: it
   * resolves once every node took the user's sockets out (at most
   * `cluster.timeoutMs`), so await it before emitting what the user must not
   * receive. Room names are checked as `join` checks them (`VALIDATION`). A
   * user with no socket in the room is nothing to do; joining again is the
   * app's to refuse.
   */
  leave(room: string, target: RoomTarget): Promise<void>;
  /**
   * How many sockets are in the app room `room` on this node: every socket a
   * method joined to it, anonymous ones (a spectator) included, counted at
   * once, with no promise and no round trip, so a game loop can ask it at
   * its tick rate ("is anyone watching this world?"). Local: behind a
   * cluster adapter it never counts another node's sockets; ask
   * `presence.count(room)` for the users in the room on every node. Room
   * names are checked as `join` checks them (`VALIDATION`); without a server
   * it is 0.
   */
  size(room: string): number;
}

/**
 * `ctx.rooms` (RFC 0003 sections 3, 12.5 and 15): app-defined rooms the
 * calling socket joins and leaves, and typed room events. It replaces 4.1's
 * `emitToRoom` and `emitToUserRoom` (`legacy-src/server/BaseService.ts:378-441`).
 * Everything that needs no calling socket is also on `qd.rooms`
 * ({@link ServerRooms}).
 */
export interface ContextRooms extends ServerRooms {
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
  /** See {@link ServerRooms.leave}: every socket of the user, on every node, from any call. */
  leave(room: string, target: RoomTarget): Promise<void>;
}

/** Why a socket left app rooms, as `onRoomLeave` hears it. */
export type RoomLeaveReason =
  /** The socket's own `ctx.rooms.leave(room)`. */
  | "leave"
  /** `rooms.leave(room, { userId })` took its user out. */
  | "removed"
  /** The socket disconnected (a closed tab, a lost network, `qd:rotate`, the server closing): every app room it was in. */
  | "disconnect";

/** One app room a socket left. */
export interface RoomLeft {
  readonly room: string;
  /**
   * True when no socket of the user is in the room any more, on any node:
   * the user is gone from it, not just one of their sockets (another tab
   * keeps it false). Always true for an anonymous socket. Behind a cluster
   * adapter it is decided by asking every node once this socket left, as
   * the room's `left` presence frame is; when they cannot be asked it is
   * true. For a removal every node reports its own last socket of the user
   * as last, so it is never missed and may come from more than one node.
   */
  readonly last: boolean;
}

/** What `onRoomLeave` receives: one socket leaving one or more app rooms. */
export interface RoomLeave<P = Principal> {
  /** The socket's principal; `null` for an anonymous socket (a spectator). */
  readonly principal: P | null;
  /** The socket that left. */
  readonly socketId: string;
  readonly reason: RoomLeaveReason;
  /** The app rooms it left: one for a leave or a removal, every one it was in for a disconnect. */
  readonly rooms: readonly RoomLeft[];
}

/**
 * `createServer`'s `onRoomLeave`: called once per socket that leaves app
 * rooms, on the node that holds the socket, in a unit of work of its own
 * (detached: never the unit of the handler whose `ctx.rooms.leave` caused
 * it), after the room heard the socket go. `ctx` is a `qd.run` context. An
 * error it throws is logged; a server's `close()` waits for it.
 */
export type RoomLeaveHandler<P = Principal> = (
  leave: RoomLeave<P>,
  ctx: RunContext,
) => void | PromiseLike<void>;

/** The arguments of a stream's `push`: `(scope, item)` for a scoped stream, `(item)` for a global one. */
export type StreamPushArgs<C extends AnyContract, K extends StreamName<C>> =
  IsScopedStream<C, K> extends true
    ? [scope: string, item: StreamItemOf<C, K>]
    : [item: StreamItemOf<C, K>];

/** The arguments of a stream's `pushMany`: `(scope, items)` for a scoped stream, `(items)` for a global one. */
export type StreamPushManyArgs<C extends AnyContract, K extends StreamName<C>> =
  IsScopedStream<C, K> extends true
    ? [scope: string, items: readonly StreamItemOf<C, K>[]]
    : [items: readonly StreamItemOf<C, K>[]];

/** What `qd.stream(contract, name)` returns. */
export interface StreamHandle<C extends AnyContract, K extends StreamName<C>> {
  /**
   * Appends an item to the stream (one scope of it, for a scoped stream):
   * checked against the stream's item schema (a mismatch throws `INTERNAL`),
   * kept in the scope's seed when the stream declares one, and sent to every
   * subscriber as `qd:stream`, volatile when the stream says so.
   */
  push(...args: StreamPushArgs<C, K>): void;
  /**
   * Appends several items to one feed at once, in order, as `push` would one
   * by one (each is its own `qd:stream` frame, so `useStream` sees them as
   * pushed): every item is checked first, and one mismatch throws `INTERNAL`
   * with nothing kept or sent. The batch form of a `push` in a loop.
   */
  pushMany(...args: StreamPushManyArgs<C, K>): void;
}

/**
 * What a stream's `seed` function receives besides the scope: who is
 * subscribing, already authorized by the stream's `access`.
 */
export interface StreamSeedContext<P = Principal> {
  /** The subscriber's principal; `null` for an anonymous subscriber of a `"public"` stream. */
  readonly principal: P | null;
  /** The subscribing socket. */
  readonly socketId: string;
  /** The dispatcher's logger. */
  readonly log: Logger;
}

/**
 * A stream's seed computed when a socket subscribes (`defineService`'s
 * `streams: { <name>: { seed } }`), instead of the latest items pushed: the
 * current state the items that follow change (a game world whose items are
 * deltas). It gets the feed's scope (`undefined` for a global stream) and
 * the subscriber, and returns the items the subscriber starts from, oldest
 * first, or a promise of them.
 */
export type StreamSeed<T extends QuickdrawTypes, C extends AnyContract, K extends StreamName<C>> = (
  scope: IsScopedStream<C, K> extends true ? string : undefined,
  ctx: StreamSeedContext<PrincipalOf<T>>,
) => readonly StreamItemOf<C, K>[] | PromiseLike<readonly StreamItemOf<C, K>[]>;

/** One stream's options in `defineService`'s `streams`. */
export interface StreamImplementation<
  T extends QuickdrawTypes,
  C extends AnyContract,
  K extends StreamName<C>,
> {
  /**
   * Computes each subscriber's seed when it subscribes, on the node it is
   * connected to, under its principal once the stream's `access` admitted
   * it: the current state rather than the last items pushed. It runs for
   * every `qd:stream:sub`, so keep it cheap (read state the app holds, or
   * cache it). The socket joins the feed in the same tick as the function
   * is called, so a function that returns at once gives the exact
   * guarantee of a kept seed: every item pushed after it reaches the
   * subscriber, none pushed before it does. One that returns a promise may
   * also see items pushed while it runs, which then arrive both ways; never
   * neither. A throw answers the subscribe with that error (a
   * `QuickdrawError`'s code, else `INTERNAL`) and leaves the feed. Each item
   * is checked against the stream's schema, as `push` checks. A stream whose
   * contract keeps a seed (`seed: n`) cannot also compute one.
   *
   * @example
   * streams: { world: { seed: (worldId) => [worlds.get(worldId).snapshot()] } }
   */
  readonly seed?: StreamSeed<T, C, K>;
}

/**
 * `defineService`'s `streams`: options per stream of the contract (any
 * subset): a seed computed at subscribe time.
 */
export type StreamOptions<T extends QuickdrawTypes, C extends AnyContract> = {
  readonly [K in StreamName<C>]?: StreamImplementation<T, C, K>;
};

/** A stream's `seed` function as the subscribe path calls it, whatever its declared types. */
export type AnyStreamSeed = (scope: string | undefined, ctx: StreamSeedContext) => unknown;

/** Who may send on a channel besides its `requires`: any principal, or a service-wide grant. */
export type ChannelAccess = "authenticated" | { readonly service: AccessLevel };

/**
 * What a channel handler receives beside the payload. Channels need a
 * principal, so `principal` is never `null`. `Room` is `string` for a
 * channel that `requires: { room }`, `undefined` for any other.
 */
export interface ChannelContext<
  P = Principal,
  Room extends string | undefined = string | undefined,
> {
  readonly principal: P;
  /** The socket the message arrived on. */
  readonly socketId: string;
  /**
   * The app room the channel's `requires: { room }` matched: its name, the
   * one the payload computed, or for `{ prefix }` the sending socket's room
   * with that prefix (the one it joined first, if several), so a game of
   * many worlds knows the sender's world without the payload repeating it.
   * `undefined` for a channel that requires no room.
   */
  readonly room: Room;
  /** The dispatcher's logger. Messages are not logged one by one. */
  readonly log: Logger;
  /** Joins and leaves apply to the sending socket. */
  readonly rooms: ContextRooms;
  readonly presence: Presence;
}

/** A channel's handler. It runs synchronously per message; a promise it returns is not awaited. */
export type ChannelHandler<
  T extends QuickdrawTypes,
  Payload,
  Room extends string | undefined = string | undefined,
> = (payload: Payload, ctx: ChannelContext<PrincipalOf<T>, Room>) => void | PromiseLike<void>;

/** One channel's implementation in `defineService`: its handler, or `{ access, handler }`. */
export type ChannelImplementation<
  T extends QuickdrawTypes,
  Payload,
  Room extends string | undefined = string | undefined,
> =
  | ChannelHandler<T, Payload, Room>
  | {
      /** Default `"authenticated"`. */
      readonly access?: ChannelAccess;
      readonly handler: ChannelHandler<T, Payload, Room>;
    };

/** What a channel's handler gets as `ctx.room`: `string` when it requires a room, else `undefined`. */
export type ChannelRoomOf<
  C extends AnyContract,
  K extends ChannelName<C>,
> = C["channels"][K] extends {
  readonly requires: { readonly room: string | object };
}
  ? string
  : undefined;

/** `defineService`'s `channels`: one implementation per channel of the contract. */
export type ChannelOptions<T extends QuickdrawTypes, C extends AnyContract> = {
  readonly [K in ChannelName<C>]: ChannelImplementation<
    T,
    ChannelPayloadOf<C, K>,
    ChannelRoomOf<C, K>
  >;
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

/** One stream subscription (`qd:stream:sub`), as `socket.data.streams[room]` records it. */
export interface StreamSubscription {
  /** The service name. */
  readonly s: string;
  /** The stream name. */
  readonly stream: string;
  /** The feed's scope; absent for a global stream. */
  readonly scope?: string;
  /**
   * The rows the subscriber's access is derived from (`anchorKey`s): the row
   * an `entry` or `scope` form checks, then its `inherit` parents. None for
   * `"public"`, `"authenticated"` or `{ service }`, which no row decides.
   */
  readonly anchors: readonly string[];
}

/**
 * `socket.data.streams`: the socket's stream subscriptions, by room. Plain
 * data, in an object without a prototype, read by own keys only.
 */
export type StreamSubscriptions = Record<string, StreamSubscription>;

/** A channel handler as the dispatcher calls it, whatever its declared types. */
export type AnyChannelHandler = (payload: unknown, ctx: ChannelContext) => unknown;

/** Where a channel requirement reads its row id, scope value or app room from a parsed payload. */
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
    | { readonly kind: "room"; readonly select: CompiledSelector }
    | { readonly kind: "roomPrefix"; readonly prefix: string }
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
  /** How many of the latest items each scope keeps as its seed (the contract's `seed`). */
  readonly seed: number;
  /** The service's `seed` function, computing each subscriber's seed instead; `undefined` when it has none. */
  readonly computeSeed: AnyStreamSeed | undefined;
  readonly volatile: boolean;
  /**
   * The contract's access form as the access engine decides it, with the
   * scope as the `id` of an `entry` or `scope` form (the engine's input is
   * `{ scope }`); `undefined` for a closed stream.
   */
  readonly access: AccessForm | undefined;
}
