// The Valkey (or Redis) clients of a node's Socket.IO Redis adapter, when
// their connection drops and comes back (the pack H finale review):
//
// - while the subscribing client is disconnected, nothing other nodes
//   publish reaches this node: their frames to its sockets are gone, and
//   Valkey does not keep them. So when that client is ready again, this
//   node's sockets get `qd:rotate` with a window of `RESYNC_WITHIN_MS`: each
//   client reconnects at a random moment within it and subscribes again,
//   holding its revisions, and behind a cluster a subscription always reads
//   (a collection resume reads a page), so it catches up;
// - the adapter publishes without waiting for the result, and node-redis 5
//   and later reject a command that waited in the queue of a disconnected
//   client past their command timeout (5 seconds): an outage longer than
//   that would turn every frame published meanwhile into an unhandled
//   rejection, which ends a Node process by default. A failed publish is
//   logged once per outage instead (the other nodes miss that message; their
//   own subscriptions coming back re-sync their clients the same way).
//
// Both wirings are watched: an adapter given as `socket.adapter`, from
// `createServer`, and `setupRedisAdapter`'s, once it is set. An adapter an
// app sets later with `io.adapter(...)` itself is not.

import type { Logger } from "../../contract/logger";
import { SERVER_EVENTS } from "../../contract/names";
import { describeError } from "../pipeline/metrics";
import type { QuickdrawIo } from "../transports/types";

/** The window this node's clients reconnect within once its Valkey subscription is back. */
export const RESYNC_WITHIN_MS = 2000;

interface Emitter {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

function isEmitter(value: unknown): value is Emitter {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly on?: unknown }).on === "function"
  );
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

/** Clients already watched: a server and `setupRedisAdapter` may both find one. */
const watched = new WeakSet<object>();

/** Sends this node's sockets `qd:rotate` each time the subscribing client is ready again. */
function resyncOnReady(io: QuickdrawIo, subClient: Emitter, logger: Logger): void {
  subClient.on("ready", () => {
    logger.info(
      "This node's Valkey subscription is back; its clients reconnect to catch up on what it missed",
      { category: "quickdraw.cluster", withinMs: RESYNC_WITHIN_MS },
    );
    io.local.emit(SERVER_EVENTS.rotate, { withinMs: RESYNC_WITHIN_MS });
  });
}

/** Logs a publish the client failed, once per outage, instead of leaving its rejection unhandled. */
function guardPublishes(pubClient: object, logger: Logger): void {
  const target = pubClient as { publish?: unknown };
  const publish = target.publish;
  if (typeof publish !== "function") {
    return;
  }
  let reported = false;
  target.publish = function guardedPublish(this: unknown, ...args: unknown[]): unknown {
    const sent: unknown = Reflect.apply(publish, this, args);
    if (isThenable(sent)) {
      sent.then(undefined, (error: unknown) => {
        if (!reported) {
          reported = true;
          logger.warn(
            "Valkey did not take a message for the other nodes in time; it was dropped, and they catch up once their own subscriptions are back",
            { category: "quickdraw.cluster", error: describeError(error) },
          );
        }
      });
    }
    return sent;
  };
  if (isEmitter(pubClient)) {
    pubClient.on("ready", () => {
      reported = false;
    });
  }
}

/**
 * Watches the clients of `io`'s Socket.IO Redis adapter, when it has one
 * (`pubClient` and `subClient`): a subscription that comes back re-syncs
 * this node's sockets, and a failed publish is logged, not left unhandled.
 * Does nothing for another adapter, and watches a client once.
 */
export function watchAdapterClients(io: QuickdrawIo, logger: Logger): void {
  const adapter = io.sockets.adapter as {
    readonly pubClient?: unknown;
    readonly subClient?: unknown;
  };
  const { pubClient, subClient } = adapter;
  if (isEmitter(subClient) && !watched.has(subClient)) {
    watched.add(subClient);
    resyncOnReady(io, subClient, logger);
  }
  if (typeof pubClient === "object" && pubClient !== null && !watched.has(pubClient)) {
    watched.add(pubClient);
    guardPublishes(pubClient, logger);
  }
}
