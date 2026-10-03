// The client's lane of subscription events (RFC 0003 section 8.2). The server
// runs `qd:sub`, `qd:col:sub`, `qd:col:items` and `qd:watch` in a lane per
// socket: `limits.subscriptions.maxInFlight` (8) at once and `maxQueued` (64)
// waiting, then `RATE_LIMITED`. A page that mounts a board can ask for more
// than that in one tick, so the client keeps a lane of its own in front of it:
//
// - at most `maxInFlight` events (from the server's `qd:hello`, 8 before it
//   arrives) await their acknowledgement; the others wait here, in order, so
//   the server's queue never fills;
// - nothing is sent while the connection's `subscription` backoff lasts
//   (after a `RATE_LIMITED` answer): the lane waits it out, then goes on;
// - nothing is sent while the socket is down: an event whose turn comes then
//   is answered at once with an error, and its sender subscribes again when
//   the socket connects (the server forgets a socket's subscriptions anyway).
//
// Unsubscribe events (`qd:unsub`, `qd:col:unsub`, `qd:unwatch`) are not in
// the server's lane, and are sent directly.
//
// React-free: the connection owns one; the change topics (`watch.ts`) and the
// live data (`live/`) send through it.

import type { CLIENT_EVENTS } from "../contract/names";
import { isRecord } from "../protocol/guards";
import { MAX_SUBSCRIBE_IDS, type HelloFrame } from "../protocol/version";
import type { BackoffKind } from "./backoff";
import type { QuickdrawSocket } from "./connection";
import { notifyEach } from "./watch";

/** How many subscription events a lane sends at once before the server's `qd:hello` says. */
export const DEFAULT_SUBSCRIPTION_LANE = 8;

/** The events that run in the server's subscription lane. */
export type SubscriptionEvent =
  | typeof CLIENT_EVENTS.sub
  | typeof CLIENT_EVENTS.collectionSub
  | typeof CLIENT_EVENTS.collectionItems
  | typeof CLIENT_EVENTS.watch;

/**
 * Receives what came back for one subscription event: an error (no answer
 * in time, the socket dropped, or it was down when the event's turn came) or
 * the server's reply.
 */
export type LaneCallback = (error: Error | null, reply: unknown) => void;

/** What a lane needs of its connection. */
export interface LaneHost {
  readonly socket: QuickdrawSocket;
  /** How long to wait for an acknowledgement. */
  timeoutMs(): number;
  /** The server's `qd:hello` on the current credentials, or `null` before it arrives. */
  hello(): HelloFrame | null;
  backoffRemaining(kind: BackoffKind): number;
}

/** A connection's lane of subscription events. */
export interface SubscriptionLane {
  /**
   * Sends `event` with `frame` once a slot is free, and calls `done` with
   * what comes back. `done` is called exactly once, and never synchronously
   * from `send` unless the socket is down.
   */
  send(event: SubscriptionEvent, frame: object, done: LaneCallback): void;
  /** Events sent and not answered yet. */
  inFlight(): number;
  /** Events waiting for a slot. */
  waiting(): number;
}

/** The subscription limits a server announced, checked: they came over the network. */
export interface SubscriptionLimits {
  /** Subscription events one socket may have running at once. */
  readonly maxInFlight: number;
  /** Ids one `qd:sub` may name. */
  readonly maxSubscribeIds: number;
}

function positiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/** The limits `hello` announces, or the defaults where it says nothing usable. */
export function subscriptionLimits(hello: HelloFrame | null): SubscriptionLimits {
  const limits: unknown = hello?.limits;
  const record = isRecord(limits) ? limits : {};
  const lane = isRecord(record.subscriptions) ? record.subscriptions : {};
  return {
    maxInFlight: positiveInteger(lane.maxInFlight, DEFAULT_SUBSCRIPTION_LANE),
    maxSubscribeIds: positiveInteger(record.maxSubscribeIds, MAX_SUBSCRIBE_IDS),
  };
}

interface Pending {
  readonly event: SubscriptionEvent;
  readonly frame: object;
  readonly done: LaneCallback;
}

/** The untyped face of a socket's `timeout(ms)`: the lane sends four event types through one call. */
interface TimedEmitter {
  emit(event: string, frame: object, ack: LaneCallback): void;
}

/** The error a sender gets for an event the lane did not send because the socket was down. */
function notConnected(): Error {
  return new Error("The socket is not connected; the event was not sent");
}

/** Creates the subscription lane of one connection. */
export function createSubscriptionLane(host: LaneHost): SubscriptionLane {
  const queue: Pending[] = [];
  let inFlight = 0;
  let backoffTimer: ReturnType<typeof setTimeout> | undefined;

  const answer = (pending: Pending, error: Error | null, reply: unknown): void => {
    notifyEach([pending.done], (done) => {
      done(error, reply);
    });
  };

  function sendOne(pending: Pending): void {
    inFlight += 1;
    const emitter = host.socket.timeout(host.timeoutMs()) as unknown as TimedEmitter;
    emitter.emit(pending.event, pending.frame, (error, reply) => {
      inFlight -= 1;
      answer(pending, error, reply);
      pump();
    });
  }

  function waitForBackoff(wait: number): void {
    backoffTimer ??= setTimeout(() => {
      backoffTimer = undefined;
      pump();
    }, wait);
  }

  function dropAll(): void {
    for (const dropped of queue.splice(0)) {
      answer(dropped, notConnected(), undefined);
    }
  }

  function pump(): void {
    const { maxInFlight } = subscriptionLimits(host.hello());
    while (queue.length > 0 && inFlight < maxInFlight) {
      if (!host.socket.connected) {
        dropAll();
        return;
      }
      const wait = host.backoffRemaining("subscription");
      if (wait > 0) {
        waitForBackoff(wait);
        return;
      }
      sendOne(queue.shift() as Pending);
    }
  }

  return Object.freeze({
    send(event: SubscriptionEvent, frame: object, done: LaneCallback): void {
      queue.push({ event, frame, done });
      pump();
    },
    inFlight: () => inFlight,
    waiting: () => queue.length,
  });
}
