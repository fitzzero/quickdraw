// The socket listeners of collection subscriptions (RFC 0003 sections 7.3,
// 7.4 and 8.2): `qd:col:sub`, answered with a page (`{ ok: true, rev, items,
// total, cursor, limit, clamped?, index? | indexTruncated? }`), with the
// deltas since `since` (`{ ok: true, resumed: true, rev, deltas }`), or
// `{ ok: false, e }`; `qd:col:items`, answered `{ ok: true, items }` or
// `{ ok: false, e }`; and `qd:col:unsub`, optionally acknowledged. One
// listener per event on every v5 socket, routed by the frame, never one per
// service or scope. None of them counts against the socket rate limiter
// (`transports/middleware.ts`), like `qd:sub`.
//
// A request fails with `VALIDATION` for a malformed frame, `NOT_FOUND` for an
// unknown service or collection, `UNAUTHENTICATED` for an anonymous socket,
// `FORBIDDEN` for a scope the principal may not subscribe to (4.1 answered an
// unknown collection and a denied scope alike) or, for `qd:col:items`, one
// the socket has not subscribed to; and `INTERNAL`, logged, for a lookup or
// read that failed.

import { CLIENT_EVENTS } from "../../contract/names";
import type { Failure } from "../../protocol/envelope";
import { toWire } from "../../protocol/errors";
import { reply } from "../emit/extension";
import { toQuickdrawError } from "../pipeline/errors";
import { describeError } from "../pipeline/metrics";
import type { QuickdrawServerSocket, SocketContext } from "../transports/types";
import type { CollectionHub } from "./bind";
import {
  loadItems,
  readItemsRequest,
  readSubscribe,
  servedCollection,
  unsubscribeScope,
} from "./requests";
import { subscribeScope } from "./subscribe";

/** What `work` answers, or the failure what it threw maps to; `INTERNAL` is logged. */
async function settle(
  hub: Pick<CollectionHub, "logger">,
  socket: QuickdrawServerSocket,
  event: string,
  work: () => Promise<unknown>,
): Promise<unknown> {
  try {
    return await work();
  } catch (error) {
    const failure = toQuickdrawError(error);
    if (failure.code === "INTERNAL") {
      hub.logger.error(`A ${event} failed`, {
        category: "quickdraw.socket",
        socketId: socket.id,
        error: describeError(failure.cause ?? failure),
      });
    }
    const answer: Failure = { ok: false, e: toWire(failure) };
    return answer;
  }
}

/**
 * Registers a listener for an event a client sends with an acknowledgement:
 * `work` answers the frame, and whatever it throws is answered as the
 * failure it maps to (`INTERNAL` is logged). An event sent without an
 * acknowledgement is ignored.
 */
export function answerEvent(
  hub: Pick<CollectionHub, "logger">,
  socket: QuickdrawServerSocket,
  context: SocketContext,
  event: string,
  work: (frame: unknown) => Promise<unknown>,
): void {
  socket.on(event, (frame: unknown, ack: unknown) => {
    if (typeof ack !== "function") {
      context.logger.debug(`Ignored a ${event} sent without an acknowledgement`, {
        category: "quickdraw.socket",
        socketId: socket.id,
      });
      return;
    }
    void settle(hub, socket, event, () => work(frame)).then((answer) => {
      reply(socket, context, ack, answer);
    });
  });
}

/**
 * The socket extension (`transports/socketio.ts`) that serves `qd:col:sub`,
 * `qd:col:items` and `qd:col:unsub` for one dispatcher's collections.
 */
export function collectionSubscriptions(
  hub: CollectionHub,
): (socket: QuickdrawServerSocket, context: SocketContext) => void {
  return (socket, context) => {
    answerEvent(hub, socket, context, CLIENT_EVENTS.collectionSub, async (frame) => {
      const request = readSubscribe(frame);
      const { collection } = servedCollection(hub, socket, request);
      return await subscribeScope(hub, socket, collection, request);
    });
    answerEvent(hub, socket, context, CLIENT_EVENTS.collectionItems, async (frame) => {
      return await loadItems(hub, socket, readItemsRequest(frame));
    });
    socket.on(CLIENT_EVENTS.collectionUnsub, (frame: unknown, ack: unknown) => {
      reply(socket, context, ack, unsubscribeScope(hub, socket, frame));
    });
    socket.on("disconnect", () => {
      hub.collections.scopes.drop(socket);
    });
  };
}
