// Streams, channels and typed room events in a contract (RFC 0003 section
// 12.5). A stream is server-to-client append-only data a subscriber receives
// with a seed of recent items; a channel is fire-and-forget client-to-server
// input (cursors, typing) behind a per-socket token bucket; an event is a
// typed custom frame a handler sends to a room. 4.1 declared channels on the
// service class (4.1 `src/server/BaseService.ts:915-942`) and typed room
// events through the augmentable `QuickdrawEventMap`; here all three live in
// the contract, so the client is typed from it.
//
// Methods, collections, streams, channels and events share one namespace:
// the client exposes each as `qd.<service>.<name>`.

import type { AccessLevel } from "./access";
import type { AnyContract } from "./defineContract";
import type { StandardSchemaV1 } from "./standardSchema";

/** The `scope` of a stream with one feed for the whole service: the default. */
export const GLOBAL_STREAM = "global";

/** The most items a stream may keep per scope as the seed for new subscribers. */
export const STREAM_MAX_SEED = 1000;

/** A channel's sustained rate when it declares none: messages per second per socket. */
export const CHANNEL_DEFAULT_RATE = 30;

/**
 * The app room a stream's subscriber must be in (`access: { room }`): the
 * room's name, `{ prefix }` for any room whose name starts with it, or for a
 * scoped stream a function of the scope (`(worldId) => \`world:${worldId}\``).
 */
export type StreamRoom = string | RoomPrefix | ((scope: string) => string | null | undefined);

/**
 * Who may subscribe to a stream (RFC 0003 section 4.1's forms, as data). A
 * scoped stream's scope value is the row an `entry` or `scope` form is about:
 * `{ entry: L }` needs level `L` on the row of this service whose id is the
 * scope, `{ scope: L, of }` level `L` on that row of `of`'s service.
 * `{ room }` opens it to the sockets in an app room a method joined them to
 * (signed in or not), as a channel's `requires: { room }` does its messages:
 * a socket that leaves the room, or is taken out of it, leaves the feed too.
 * A stream that declares none is closed: no client may subscribe.
 */
export type StreamAccess =
  | "public"
  | "authenticated"
  | {
      readonly service: AccessLevel;
      readonly entry?: undefined;
      readonly scope?: undefined;
      readonly of?: undefined;
      readonly room?: undefined;
    }
  | {
      readonly entry: AccessLevel;
      readonly service?: AccessLevel;
      readonly scope?: undefined;
      readonly of?: undefined;
      readonly room?: undefined;
    }
  | {
      readonly scope: AccessLevel;
      readonly of: AnyContract;
      readonly service?: undefined;
      readonly entry?: undefined;
      readonly room?: undefined;
    }
  | {
      readonly room: StreamRoom;
      readonly service?: undefined;
      readonly entry?: undefined;
      readonly scope?: undefined;
      readonly of?: undefined;
    };

/** A server-to-client stream of append-only items (RFC 0003 section 12.5). */
export interface StreamDef<Item extends StandardSchemaV1 = StandardSchemaV1> {
  /** One item's schema. Pushed items are checked against it before they are sent. */
  readonly item: Item;
  /**
   * What a scope value is (`"taskId"`): the stream has one feed per scope.
   * `"global"`, the default, makes one feed for the whole service.
   */
  readonly scope?: string;
  /**
   * How many of the latest items the server keeps per scope, in memory on
   * each process, and sends a new subscriber first. Default 0; at most 1,000.
   */
  readonly seed?: number;
  /** Send items volatile: dropped for a client whose connection is backed up. Default `false`. */
  readonly volatile?: boolean;
  /** Who may subscribe. Without it the stream is closed. */
  readonly access?: StreamAccess;
}

/**
 * Where a channel requirement finds its row id or scope value in the parsed
 * payload: the name of a key holding a string, or a function of the payload.
 */
export type PayloadSelector = string | ((payload: never) => string | null | undefined);

/**
 * Any app room whose name starts with `prefix` (`{ prefix: "world:" }`, a
 * game of many worlds): the sending socket passes when it is in one, and
 * the channel's handler gets the one it matched as `ctx.room`, so the
 * payload need not repeat which room it is for.
 */
export interface RoomPrefix {
  readonly prefix: string;
}

/**
 * The app room a channel requirement names: the room itself (`"world"`, a
 * game's one world), a function of the parsed payload that returns it
 * (`(payload) => \`lobby:${payload.lobbyId}\``), or `{ prefix }`, any room
 * whose name starts with it (`{ prefix: "world:" }`). Unlike a
 * {@link PayloadSelector}, a string here is the room's name, not a payload
 * key. A name starting with `qd:` or `user:` is never an app room: a literal
 * one (or such a prefix) is refused when the contract is defined, and a
 * computed one drops the message.
 */
export type RoomSelector = string | ((payload: never) => string | null | undefined) | RoomPrefix;

/**
 * What a channel message requires of the socket that sends it: a live
 * subscription (`qd:sub`) to the row of this service `entity` names, or
 * (`qd:col:sub`) to the scope of `collection` that `scope` names; or that
 * the socket is in the app room `room` names (or, for `{ prefix }`, in any
 * app room whose name starts with it), which a method called over that
 * same socket joined with `ctx.rooms.join` (a room another socket of the
 * user joined does not count, and a reconnected socket is in none until it
 * joins again). The handler gets the room that matched as `ctx.room`. Each
 * is checked in memory against the sending socket's own records, on the
 * node it is connected to. A message whose payload names none is dropped.
 */
export type ChannelRequires =
  | {
      readonly entity: PayloadSelector;
      readonly collection?: undefined;
      readonly scope?: undefined;
      readonly room?: undefined;
    }
  | {
      readonly collection: string;
      readonly scope: PayloadSelector;
      readonly entity?: undefined;
      readonly room?: undefined;
    }
  | {
      readonly room: RoomSelector;
      readonly entity?: undefined;
      readonly collection?: undefined;
      readonly scope?: undefined;
    };

/** A client-to-server fire-and-forget channel (RFC 0003 section 12.5). */
export interface ChannelDef<Payload extends StandardSchemaV1 = StandardSchemaV1> {
  /** One message's schema. A message that fails it is dropped. */
  readonly payload: Payload;
  /** Messages one socket may send per second, sustained. Default 30. */
  readonly ratePerSecond?: number;
  /** How many messages one socket may send at once. Default twice `ratePerSecond`. */
  readonly burst?: number;
  /** What the sender must already be subscribed to, or the app room it must be in. */
  readonly requires?: ChannelRequires;
}

/** A typed custom room event, delivered as `qd:event` (RFC 0003 section 8.3). */
export interface EventDef<Payload extends StandardSchemaV1 = StandardSchemaV1> {
  readonly payload: Payload;
}

/** True when a stream has one feed per scope value; false for a global stream. */
export function isScopedStream(def: Pick<StreamDef, "scope">): boolean {
  return def.scope !== undefined && def.scope !== GLOBAL_STREAM;
}
