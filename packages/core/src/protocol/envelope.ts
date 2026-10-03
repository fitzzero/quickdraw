// Protocol v5 frames (RFC 0003 sections 8.2 and 8.3): what each `qd:*` event
// carries and what its acknowledgement receives. `ClientToServerEvents` and
// `ServerToClientEvents` key every frame by its event name from
// `contract/names.ts`, in the event-map form Socket.IO's `Server` and the
// client's `Socket` take as type parameters.
//
// Section 8.2 spells out the `qd:call`, `qd:cancel`, `qd:watch` and `qd:ch`
// payloads, and sections 6, 7, 11.3 and 12.5 describe the rest. Fields the RFC
// does not name follow its style: `s` service, `m` method, `c` collection,
// `i` input, `d` data, `e` error, `v` version, `rev` revision.
//
// 4.1 used one event per service method and a `{ success, data }` reply
// (`legacy-src/shared/types.ts:88-90`). Here every call travels as one
// `qd:call` envelope and is answered `{ ok: true, d }` or `{ ok: false, e }`.
//
// Runtime guards cover the frames the dispatcher reads from an untrusted
// client (`qd:call`, `qd:cancel`). They are written by hand so the package
// root stays free of schema libraries.

import type { AccessLevel } from "../contract/access";
import type { CLIENT_EVENTS, SERVER_EVENTS } from "../contract/names";
import type { WireError } from "./errors";
import { isName, isRecord } from "./guards";
import type { HelloFrame } from "./version";

/** A per-process monotonic revision, `max(Date.now(), last + 1)` (RFC 0003 section 5.3). */
export type Revision = number;

/**
 * The version of a result the caller holds, sent back as a call's `v` so the
 * server can answer "not modified" (RFC 0003 section 9, step 5): a row's
 * revision, or what the method's `version(input, ctx)` returns. Opaque to the
 * client.
 */
export type Version = number | string;

/** A call's number among its socket's calls in flight: a non-negative safe integer. */
export type CallId = number;

/** An acknowledgement that succeeded with nothing to return. */
export interface Ok {
  readonly ok: true;
}

/** An acknowledgement that failed, and why. */
export interface Failure {
  readonly ok: false;
  readonly e: WireError;
}

// ---------------------------------------------------------------------------
// Calls (section 8.2)
// ---------------------------------------------------------------------------

/** `qd:call`: one method call, answered through the acknowledgement. */
export interface CallEnvelope {
  /** Names the call for `qd:cancel`; unique among the socket's calls in flight. */
  readonly id: CallId;
  /** The service name. */
  readonly s: string;
  /** The method name. */
  readonly m: string;
  /** The input, not yet validated. Absent when the input is `undefined`. */
  readonly i?: unknown;
  /** The version of this call's result the caller already holds. */
  readonly v?: Version;
}

/** A call that returned data, with the version of that data when the method has one. */
export interface CallSuccess<Output = unknown> {
  readonly ok: true;
  readonly d: Output;
  readonly v?: Version;
  readonly nm?: undefined;
}

/** A call whose result is still the version the caller sent: keep the cached copy. */
export interface CallNotModified {
  readonly ok: true;
  readonly nm: true;
  readonly v: Version;
}

/** The acknowledgement of `qd:call`. */
export type CallReply<Output = unknown> = CallSuccess<Output> | CallNotModified | Failure;

/** `qd:cancel`: abort a call in flight. The call's acknowledgement still arrives. */
export interface CancelFrame {
  readonly id: CallId;
}

// ---------------------------------------------------------------------------
// Entity subscriptions (section 6)
// ---------------------------------------------------------------------------

/** `qd:sub`: subscribe to rows of one service, sending the revision held for each. */
export interface EntitySubscribe {
  readonly s: string;
  readonly ids: readonly string[];
  /** The revision held for each id, by position in `ids`; `null` where none is cached. */
  readonly revs?: readonly (Revision | null)[];
}

/** One id's row, as `qd:sub` answers it. */
export interface EntityRow<Row = unknown> {
  readonly ok: true;
  readonly d: Row;
  readonly rev: Revision;
  readonly nm?: undefined;
}

/** The revision the client sent for this id is current. */
export interface EntityNotModified {
  readonly ok: true;
  readonly nm: true;
  readonly rev: Revision;
}

/** One id's answer to `qd:sub`: the row, "not modified", or why it was refused. */
export type EntityResult<Row = unknown> = EntityRow<Row> | EntityNotModified | Failure;

/** The acknowledgement of `qd:sub`: one result per requested id, in request order. */
export type EntitySubscribeReply<Row = unknown> =
  | { readonly ok: true; readonly r: readonly EntityResult<Row>[] }
  | Failure;

/** `qd:unsub`: stop receiving frames for these rows. */
export interface EntityUnsubscribe {
  readonly s: string;
  readonly ids: readonly string[];
}

/** `qd:e` `u`: the full row. Replace the cached row when `rev` is newer. */
export interface EntityUpdate<Row = unknown> {
  readonly t: "u";
  readonly s: string;
  readonly id: string;
  readonly rev: Revision;
  readonly d: Row;
}

/** `qd:e` `p`: changed fields only. Merge when `rev` is newer; fetch the row when it is not cached. */
export interface EntityPatch<Row = unknown> {
  readonly t: "p";
  readonly s: string;
  readonly id: string;
  readonly rev: Revision;
  readonly d: Partial<Row>;
}

/** `qd:e` `r`: the row is gone. Keep a tombstone until a newer `u`. */
export interface EntityRemove {
  readonly t: "r";
  readonly s: string;
  readonly id: string;
  readonly rev: Revision;
}

/** `qd:e`: a change to one row, sent to the room of each access tier that has subscribers. */
export type EntityFrame<Row = unknown> = EntityUpdate<Row> | EntityPatch<Row> | EntityRemove;

// ---------------------------------------------------------------------------
// Collections (section 7)
// ---------------------------------------------------------------------------

/** One scope of one collection of a service. */
export interface CollectionScopeRef {
  readonly s: string;
  readonly c: string;
  readonly scope: string;
}

/** `qd:col:sub`: the first page of a scope, a later page by `cursor`, or a resume from `since`. */
export interface CollectionSubscribe extends CollectionScopeRef {
  /** The revision the client holds the scope at; the server resumes from it when it can. */
  readonly since?: Revision;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * A scope member in the collection's index (RFC 0003 section 7.4): its id,
 * its revision, then its index field values in the order `index` declares.
 * The revision is the time in the service's `versionColumn` when it declares
 * one, else the revision the snapshot (or, in an `added` delta, the flush)
 * was read at.
 */
export type WireIndexRow = readonly [id: string, rev: Revision, ...fields: unknown[]];

/** A page of a scope: the answer to `qd:col:sub` without `since`, or when `since` is too old. */
export interface CollectionSnapshot<Item = unknown> {
  readonly ok: true;
  readonly resumed?: undefined;
  /** The revision the page was read at; resume from it with `since`. */
  readonly rev: Revision;
  readonly items: readonly Item[];
  /** How many members the scope has. */
  readonly total: number;
  /** The next page's cursor; `null` on the last page. */
  readonly cursor: string | null;
  /** The page size used: the request's, or `maxLimit` when the request asked for more. */
  readonly limit: number;
  /** Present when the requested limit was above `maxLimit` and was lowered to it. */
  readonly clamped?: true;
  /**
   * One row per member in `order`, on the first page of a collection that
   * declares `index` (not on a page read with `cursor`). Absent when the
   * scope has more members than the index holds: see `indexTruncated`.
   */
  readonly index?: readonly WireIndexRow[];
  /** Present instead of `index` when the scope has more members than the index holds (50,000). */
  readonly indexTruncated?: true;
}

/** The answer to `qd:col:sub` when the server still holds every change since `since`. */
export interface CollectionResumed<Item = unknown> {
  readonly ok: true;
  readonly resumed: true;
  /** The scope's revision after these deltas. */
  readonly rev: Revision;
  readonly deltas: readonly CollectionDelta<Item>[];
}

/** The acknowledgement of `qd:col:sub`. */
export type CollectionSubscribeReply<Item = unknown> =
  | CollectionSnapshot<Item>
  | CollectionResumed<Item>
  | Failure;

/** `qd:col:items`: load full items of a scope by id. */
export interface CollectionItemsRequest extends CollectionScopeRef {
  readonly ids: readonly string[];
}

/**
 * The acknowledgement of `qd:col:items`: the items found, in request order,
 * and the revision they were read at, taken before the read as a
 * snapshot's is: a client drops an item older than what a delta brought it.
 */
export type CollectionItemsReply<Item = unknown> =
  | { readonly ok: true; readonly rev: Revision; readonly items: readonly Item[] }
  | Failure;

/**
 * One change to a scope (RFC 0003 section 7.2). In a collection that declares
 * `index`, `added` carries the member's index row, built from the same row as
 * its item, and `patched` and `updated` carry every changed index field
 * (index fields are item fields): a client keeping the index updates the
 * row's fields from them, and its `rev` to the frame's `rev`.
 */
export type CollectionDelta<Item = unknown> =
  | { readonly t: "added"; readonly item: Item; readonly index?: WireIndexRow }
  | { readonly t: "updated"; readonly item: Item }
  | { readonly t: "patched"; readonly id: string; readonly d: Partial<Item> }
  | { readonly t: "removed"; readonly id: string }
  | { readonly t: "reset" };

/** `qd:c`: one flush's changes to one scope, in order. */
export interface CollectionFrame<Item = unknown> extends CollectionScopeRef {
  readonly rev: Revision;
  readonly deltas: readonly CollectionDelta<Item>[];
}

// ---------------------------------------------------------------------------
// Topics, streams, channels and events (sections 8.2, 11.3 and 12.5)
// ---------------------------------------------------------------------------

/**
 * `qd:watch` and `qd:unwatch`: join or leave a change topic of service `s`:
 * `{collection}:{scope}` for one scope of a collection, or `service` for the
 * service-wide topic (RFC 0003 section 11.3).
 */
export interface WatchFrame {
  readonly s: string;
  readonly topic: string;
}

/**
 * `qd:changed`: a watched topic changed in the flush at `rev`; invalidate the
 * queries that watch it. Sent once per flush per topic, and carries no data.
 */
export interface ChangedFrame {
  readonly s: string;
  readonly topic: string;
  readonly rev: Revision;
}

/**
 * `qd:stream:sub` and `qd:stream:unsub`: one stream of a service, and for a
 * scoped stream one scope of it (absent for a global stream).
 */
export interface StreamSubscribe {
  readonly s: string;
  readonly stream: string;
  readonly scope?: string;
}

/**
 * The acknowledgement of `qd:stream:sub`: the stream's seed, oldest first,
 * read as the socket joined the stream's room, so items pushed after it
 * arrive as `qd:stream` frames (possibly before this acknowledgement).
 */
export type StreamSubscribeReply<Item = unknown> =
  | { readonly ok: true; readonly seed: readonly Item[] }
  | Failure;

/** `qd:stream`: an item pushed to a stream. */
export interface StreamFrame<Item = unknown> {
  readonly s: string;
  readonly stream: string;
  readonly scope?: string;
  readonly item: Item;
}

/** `qd:ch`, sent volatile and never acknowledged: `[service, channel, payload]`. */
export type ChannelFrame<Payload = unknown> = readonly [
  s: string,
  channel: string,
  payload: Payload,
];

/** `qd:event`: a custom room event declared in a contract's `events`: `[service, event, payload]`. */
export type EventFrame<Payload = unknown> = readonly [s: string, event: string, payload: Payload];

/**
 * `qd:presence`: who is in an app room (one a method joined with
 * `ctx.rooms.join`) the socket is in, by user id (RFC 0003 section 12.5).
 * Sent to a socket as it joins with `users`, the whole list (its own user
 * included); to the room's other sockets with `joined` when a user's first
 * socket joins, and with `left` when a user's last socket leaves; and to a
 * socket that leaves with `users: []`, since it no longer sees the room.
 * Exactly one of `users`, `joined` and `left` is present. Anonymous sockets
 * are in no list.
 */
export interface PresenceFrame {
  readonly room: string;
  /** Every user in the room: replaces what the client holds for it. */
  readonly users?: readonly string[];
  /** A user who joined the room. */
  readonly joined?: string;
  /** A user who left the room: their last socket in it left or disconnected. */
  readonly left?: string;
}

// ---------------------------------------------------------------------------
// Connection-level frames (sections 4.4, 7.2 and 8.3)
// ---------------------------------------------------------------------------

/** Why the server ended a subscription. */
export type RevokeReason = "access" | "anchor-deleted";

/**
 * `qd:revoked`: the server removed this socket from a subscription's room,
 * because the principal's access was lowered or removed (`access`), or the
 * row a collection scope is anchored on was deleted (`anchor-deleted`).
 */
export type RevokedFrame =
  | {
      readonly kind: "entity";
      readonly reason: RevokeReason;
      readonly s: string;
      readonly id: string;
    }
  | {
      readonly kind: "collection";
      readonly reason: RevokeReason;
      readonly s: string;
      readonly c: string;
      readonly scope: string;
    };

/** `qd:rotate`: reconnect at a random moment within `withinMs`. */
export interface RotateFrame {
  readonly withinMs: number;
}

/** `qd:access`: the user's service grants changed. */
export interface AccessFrame {
  readonly serviceAccess: Readonly<Record<string, AccessLevel>>;
}

// ---------------------------------------------------------------------------
// Event maps
// ---------------------------------------------------------------------------

/** The function a listener calls to acknowledge an event. */
type Ack<Reply> = (reply: Reply) => void;

/** The listener of each client event, by its key in `CLIENT_EVENTS`. */
interface ClientListeners {
  call: (envelope: CallEnvelope, ack: Ack<CallReply>) => void;
  cancel: (frame: CancelFrame) => void;
  sub: (frame: EntitySubscribe, ack: Ack<EntitySubscribeReply>) => void;
  unsub: (frame: EntityUnsubscribe, ack?: Ack<Ok | Failure>) => void;
  collectionSub: (frame: CollectionSubscribe, ack: Ack<CollectionSubscribeReply>) => void;
  collectionUnsub: (frame: CollectionScopeRef, ack?: Ack<Ok | Failure>) => void;
  collectionItems: (frame: CollectionItemsRequest, ack: Ack<CollectionItemsReply>) => void;
  watch: (frame: WatchFrame, ack: Ack<Ok | Failure>) => void;
  unwatch: (frame: WatchFrame, ack?: Ack<Ok | Failure>) => void;
  streamSub: (frame: StreamSubscribe, ack: Ack<StreamSubscribeReply>) => void;
  streamUnsub: (frame: StreamSubscribe, ack?: Ack<Ok | Failure>) => void;
  channel: (frame: ChannelFrame) => void;
}

/** The listener of each server event, by its key in `SERVER_EVENTS`. */
interface ServerListeners {
  hello: (frame: HelloFrame) => void;
  entity: (frame: EntityFrame) => void;
  collection: (frame: CollectionFrame) => void;
  changed: (frame: ChangedFrame) => void;
  revoked: (frame: RevokedFrame) => void;
  stream: (frame: StreamFrame) => void;
  event: (frame: EventFrame) => void;
  presence: (frame: PresenceFrame) => void;
  rotate: (frame: RotateFrame) => void;
  access: (frame: AccessFrame) => void;
}

/**
 * The events a v5 client sends, keyed by name (`"qd:call"`, ...). The server
 * types its sockets with it: `new Server<ClientToServerEvents, ServerToClientEvents>()`.
 */
export type ClientToServerEvents = {
  [Key in keyof typeof CLIENT_EVENTS as (typeof CLIENT_EVENTS)[Key]]: ClientListeners[Key];
};

/**
 * The events a v5 server sends, keyed by name (`"qd:hello"`, ...). The client
 * types its socket with it: `Socket<ServerToClientEvents, ClientToServerEvents>`.
 */
export type ServerToClientEvents = {
  [Key in keyof typeof SERVER_EVENTS as (typeof SERVER_EVENTS)[Key]]: ServerListeners[Key];
};

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function isCallId(value: unknown): value is CallId {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isVersion(value: unknown): value is Version {
  return typeof value === "string" || (typeof value === "number" && Number.isFinite(value));
}

/**
 * True when `value` has the shape of a `qd:call` envelope: a call id, service
 * and method names, and a version when one is present. The input is not
 * looked at (the method's schema validates it), and unknown keys are ignored.
 */
export function isCallEnvelope(value: unknown): value is CallEnvelope {
  return (
    isRecord(value) &&
    isCallId(value.id) &&
    isName(value.s) &&
    isName(value.m) &&
    (value.v === undefined || isVersion(value.v))
  );
}

/** True when `value` has the shape of a `qd:cancel` frame. Unknown keys are ignored. */
export function isCancel(value: unknown): value is CancelFrame {
  return isRecord(value) && isCallId(value.id);
}
