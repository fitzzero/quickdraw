// Channels (RFC 0003 section 12.5): fire-and-forget client-to-server input
// such as cursors or typing, on one `qd:ch` listener per v5 socket. A message
// is one array argument, `[service, channel, payload]`, sent volatile and
// never acknowledged. Ported from 4.1's `registerChannelListener`
// (`legacy-src/server/ServiceRegistry.ts:209-266`) and `checkChannelAccess`
// (`legacy-src/server/BaseService.ts:956-983`).
//
// This is the hot path: no acknowledgement, no logging and no asynchronous
// work per message. In order: a malformed frame or an unknown service or
// channel is dropped; the socket's token bucket for that service and channel
// (refilled at `ratePerSecond`, holding at most `burst`) drops a message over
// the rate; an anonymous socket's message is dropped; the payload is checked
// against the channel's schema, synchronously, and dropped when it fails; the
// access check runs in memory (the service-wide grant a `{ service }` access
// names, then the contract's `requires`: the socket must already hold the
// entity or collection subscription the payload names, or be in the app room
// the requirement names, joined by a call over this very socket); then the
// handler runs with the parsed payload. 4.1's `requireRoom` skipped its check
// when it named no room; every form here drops the message instead. A socket
// whose dropped messages within 10 s exceed 100 times the channel's rate is
// disconnected: sustained flooding, not a burst. The rate limiter never
// counts `qd:ch` (`transports/middleware.ts`).
//
// A handler's throw or rejection is logged and does not stop the channel:
// at error, or at debug for a `QuickdrawError` the client caused (any code
// but `INTERNAL` and `TIMEOUT`), as the pipeline logs calls. A schema that
// validates asynchronously cannot be used here: its messages are dropped,
// with one warning per channel.

import { CLIENT_EVENTS, collectionRoom } from "../../contract/names";
import { meetsLevel, serviceGrant } from "../access/levels";
import type { Hub } from "../emit/hub";
import { ownRecord } from "../emit/subscriptions";
import { describeError, failureLevel } from "../pipeline/metrics";
import type { QuickdrawServerSocket } from "../transports/types";
import type { Principal } from "../types";
import type { Rooms } from "./rooms";
import type { ChannelContext, Presence, ServiceChannel } from "./types";
import { validateNow } from "./validate";

/** How long the abuse guard counts a socket's dropped messages before it starts over. */
export const CHANNEL_ABUSE_WINDOW_MS = 10_000;

/** A socket is disconnected once its drops within the window exceed this many times the channel's rate. */
export const CHANNEL_ABUSE_MULTIPLIER = 100;

/** One socket's token bucket for one channel, and its abuse window. */
interface Bucket {
  tokens: number;
  refilledAt: number;
  windowStart: number;
  dropped: number;
}

/** What one socket's channel messages share. */
interface SocketChannels {
  readonly socket: QuickdrawServerSocket;
  /** Bounded by the channels the services declare: unknown names never get one. */
  readonly buckets: Map<ServiceChannel, Bucket>;
  /** The handlers' context, made again when the socket's principal changes (new grants). */
  ctx: ChannelContext | undefined;
}

/** What every socket's channel messages share. */
export interface ChannelDeps {
  readonly hub: Hub;
  readonly rooms: Rooms;
  readonly presence: Presence;
  /** Channels already warned about for an asynchronous schema. */
  readonly warned: WeakSet<ServiceChannel>;
}

/** Takes one token, refilling first; false when the bucket is empty. */
function take(bucket: Bucket, channel: ServiceChannel, now: number): boolean {
  const refill = ((now - bucket.refilledAt) / 1000) * channel.ratePerSecond;
  bucket.tokens = Math.min(channel.burst, bucket.tokens + refill);
  bucket.refilledAt = now;
  if (bucket.tokens < 1) {
    return false;
  }
  bucket.tokens -= 1;
  return true;
}

/** Counts a drop; true once the window's drops pass the abuse threshold. */
function abusive(bucket: Bucket, channel: ServiceChannel, now: number): boolean {
  if (now - bucket.windowStart > CHANNEL_ABUSE_WINDOW_MS) {
    bucket.windowStart = now;
    bucket.dropped = 0;
  }
  bucket.dropped += 1;
  return bucket.dropped > channel.ratePerSecond * CHANNEL_ABUSE_MULTIPLIER;
}

function bucketOf(state: SocketChannels, channel: ServiceChannel, now: number): Bucket {
  let bucket = state.buckets.get(channel);
  if (bucket === undefined) {
    bucket = { tokens: channel.burst, refilledAt: now, windowStart: now, dropped: 0 };
    state.buckets.set(channel, bucket);
  }
  return bucket;
}

/** The parsed payload, or `undefined` when the message is dropped. */
function parse(
  deps: ChannelDeps,
  channel: ServiceChannel,
  payload: unknown,
): { readonly value: unknown } | undefined {
  const result = validateNow(channel.payload, payload);
  if (result === "async") {
    if (!deps.warned.has(channel)) {
      deps.warned.add(channel);
      deps.hub.logger.warn(
        `Channel ${channel.service}.${channel.name} has a payload schema that validates asynchronously; its messages are dropped, since channels validate synchronously`,
        { category: "quickdraw.channel" },
      );
    }
    return undefined;
  }
  return result.issues === undefined ? { value: result.value } : undefined;
}

/**
 * Whether the socket holds what `requires` names for `key`: the entity
 * subscription, the collection scope subscription, or the app room (one a
 * call over this socket joined with `ctx.rooms.join`). All three are the
 * socket's own records, kept on the node it is connected to, so the check
 * holds behind a cluster adapter without asking another node.
 */
function holds(
  requires: NonNullable<ServiceChannel["requires"]>,
  socket: QuickdrawServerSocket,
  service: string,
  key: string,
): boolean {
  switch (requires.kind) {
    case "entity":
      return ownRecord(ownRecord(socket.data.entities, service), key) !== undefined;
    case "collection":
      return (
        ownRecord(socket.data.collections, collectionRoom(service, requires.collection, key)) !==
        undefined
      );
    default:
      return ownRecord(socket.data.appRooms, key) !== undefined;
  }
}

/** The in-memory access check: the service grant `access` names, then the contract's `requires`. */
function allowed(
  channel: ServiceChannel,
  socket: QuickdrawServerSocket,
  principal: Principal,
  value: unknown,
): boolean {
  const { access, requires } = channel;
  if (
    access !== "authenticated" &&
    !meetsLevel(serviceGrant(principal, channel.service), access.service)
  ) {
    return false;
  }
  if (requires === undefined) {
    return true;
  }
  const key = requires.select(value);
  return key !== undefined && holds(requires, socket, channel.service, key);
}

function contextOf(deps: ChannelDeps, state: SocketChannels, principal: Principal): ChannelContext {
  if (state.ctx?.principal !== principal) {
    state.ctx = Object.freeze({
      principal,
      socketId: state.socket.id,
      log: deps.hub.logger,
      rooms: deps.rooms.of(state.socket),
      presence: deps.presence,
    });
  }
  return state.ctx;
}

/** Logs a handler's failure: at debug when the client caused it, as the pipeline logs calls (RFC 0003 section 9). */
function failed(
  deps: ChannelDeps,
  channel: ServiceChannel,
  ctx: ChannelContext,
  error: unknown,
): void {
  const level = failureLevel(error);
  deps.hub.logger[level](`The handler of channel ${channel.service}.${channel.name} failed`, {
    category: "quickdraw.channel",
    userId: ctx.principal.userId,
    socketId: ctx.socketId,
    error: describeError(error),
  });
}

function run(
  deps: ChannelDeps,
  channel: ServiceChannel,
  value: unknown,
  ctx: ChannelContext,
): void {
  try {
    const result: unknown = channel.handler(value, ctx);
    if (typeof result === "object" && result !== null && "then" in result) {
      Promise.resolve(result).catch((error: unknown) => {
        failed(deps, channel, ctx, error);
      });
    }
  } catch (error) {
    failed(deps, channel, ctx, error);
  }
}

function flooded(
  deps: ChannelDeps,
  state: SocketChannels,
  channel: ServiceChannel,
  bucket: Bucket,
): void {
  deps.hub.logger.warn(
    `Disconnecting socket ${state.socket.id} for sustained flooding of channel ${channel.service}.${channel.name}`,
    {
      category: "quickdraw.channel",
      userId: state.socket.data.principal?.userId,
      dropped: bucket.dropped,
    },
  );
  state.socket.disconnect(true);
}

/** One `qd:ch` message, through every check to the handler. */
function receive(deps: ChannelDeps, state: SocketChannels, frame: unknown): void {
  if (!Array.isArray(frame)) {
    return;
  }
  const [service, name, payload] = frame as readonly unknown[];
  const channel =
    typeof service === "string" && typeof name === "string"
      ? deps.hub.registry.services.get(service)?.channels.get(name)
      : undefined;
  if (channel === undefined) {
    return;
  }
  const now = Date.now();
  const bucket = bucketOf(state, channel, now);
  if (!take(bucket, channel, now)) {
    if (abusive(bucket, channel, now)) {
      flooded(deps, state, channel, bucket);
    }
    return;
  }
  const { principal } = state.socket.data;
  const parsed = principal === null ? undefined : parse(deps, channel, payload);
  if (
    principal !== null &&
    parsed !== undefined &&
    allowed(channel, state.socket, principal, parsed.value)
  ) {
    run(deps, channel, parsed.value, contextOf(deps, state, principal));
  }
}

/** The socket extension that serves `qd:ch` for one dispatcher's channels. */
export function channelMessages(deps: ChannelDeps): (socket: QuickdrawServerSocket) => void {
  return (socket) => {
    const state: SocketChannels = { socket, buckets: new Map(), ctx: undefined };
    socket.on(CLIENT_EVENTS.channel, (frame: unknown) => {
      try {
        receive(deps, state, frame);
      } catch (error) {
        // A schema or selector that throws must not end the process: Socket.IO runs listeners from nextTick.
        deps.hub.logger.error("A channel message failed", {
          category: "quickdraw.channel",
          socketId: socket.id,
          error: describeError(error),
        });
      }
    });
  };
}
