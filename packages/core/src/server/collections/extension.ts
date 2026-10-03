// The socket listeners of collection subscriptions (RFC 0003 sections 7.3
// and 8.2): `qd:col:sub`, answered with a page (`{ ok: true, rev, items,
// total, cursor, limit, clamped? }`), with the deltas since `since`
// (`{ ok: true, resumed: true, rev, deltas }`), or `{ ok: false, e }`; and
// `qd:col:unsub`, optionally acknowledged. One listener per event on every
// v5 socket, routed by the frame, never one per service or scope. Neither
// event counts against the socket rate limiter (`transports/middleware.ts`),
// like `qd:sub`.
//
// A subscribe fails with `VALIDATION` for a malformed frame, `NOT_FOUND` for
// an unknown service or collection, `UNAUTHENTICATED` for an anonymous
// socket, `FORBIDDEN` for a scope the principal may not subscribe to (4.1
// answered an unknown collection and a denied scope alike), and `INTERNAL`,
// logged, for a lookup or read that failed.

import { CLIENT_EVENTS } from "../../contract/names";
import type { CollectionSubscribeReply } from "../../protocol/envelope";
import { QuickdrawError, toWire } from "../../protocol/errors";
import { reply } from "../emit/extension";
import { toQuickdrawError } from "../pipeline/errors";
import { describeError } from "../pipeline/metrics";
import type { QuickdrawServerSocket, SocketContext } from "../transports/types";
import type { CollectionHub } from "./bind";
import { collectionOf, readSubscribe, unsubscribeScope } from "./requests";
import { subscribeScope } from "./subscribe";

async function onSubscribe(
  hub: CollectionHub,
  socket: QuickdrawServerSocket,
  frame: unknown,
): Promise<CollectionSubscribeReply> {
  try {
    const request = readSubscribe(frame);
    const collection = collectionOf(hub, request.s, request.c);
    if (socket.data.principal === null) {
      throw new QuickdrawError("UNAUTHENTICATED", "Authentication required");
    }
    if (hub.storage === undefined) {
      throw new QuickdrawError(
        "INTERNAL",
        "Collections read rows through the dispatcher's storage adapter: pass db as trackPrisma(prisma)",
      );
    }
    return await subscribeScope(hub, socket, collection, request);
  } catch (error) {
    const failure = toQuickdrawError(error);
    if (failure.code === "INTERNAL") {
      hub.logger.error("A qd:col:sub failed", {
        category: "quickdraw.socket",
        socketId: socket.id,
        error: describeError(failure.cause ?? failure),
      });
    }
    return { ok: false, e: toWire(failure) };
  }
}

/**
 * The socket extension (`transports/socketio.ts`) that serves `qd:col:sub`
 * and `qd:col:unsub` for one dispatcher's collections.
 */
export function collectionSubscriptions(
  hub: CollectionHub,
): (socket: QuickdrawServerSocket, context: SocketContext) => void {
  return (socket, context) => {
    socket.on(CLIENT_EVENTS.collectionSub, (frame: unknown, ack: unknown) => {
      if (typeof ack !== "function") {
        context.logger.debug("Ignored a qd:col:sub sent without an acknowledgement", {
          category: "quickdraw.socket",
          socketId: socket.id,
        });
        return;
      }
      void onSubscribe(hub, socket, frame).then((answer) => {
        reply(socket, context, ack, answer);
      });
    });
    socket.on(CLIENT_EVENTS.collectionUnsub, (frame: unknown, ack: unknown) => {
      reply(socket, context, ack, unsubscribeScope(hub, socket, frame));
    });
    socket.on("disconnect", () => {
      hub.collections.scopes.drop(socket);
    });
  };
}
