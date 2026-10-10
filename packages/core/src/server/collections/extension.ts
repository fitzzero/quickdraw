// The socket listeners of collection subscriptions (RFC 0003 sections 7.3,
// 7.4 and 8.2): `qd:col:sub`, answered with a page (`{ ok: true, rev, items,
// total, cursor, limit, clamped?, index? | indexTruncated? }`), with the
// deltas since `since` (`{ ok: true, resumed: true, rev, deltas }`), or
// `{ ok: false, e }`; `qd:col:items`, answered `{ ok: true, rev, items }` or
// `{ ok: false, e }`; and `qd:col:unsub`, optionally acknowledged. One
// listener per event on every v5 socket, routed by the frame, never one per
// service or scope. None of them counts against the socket rate limiter
// (`transports/middleware.ts`), like `qd:sub`.
//
// A request fails with `VALIDATION` for a malformed frame, `NOT_FOUND` for an
// unknown service or collection, `UNAUTHENTICATED` for an anonymous socket,
// `FORBIDDEN` for a principal of a kind the service does not admit
// (`../access/kinds.ts`), for a scope the principal may not subscribe to (4.1
// answered an unknown collection and a denied scope alike) or, for
// `qd:col:items`, one the socket has not subscribed to, which a refused kind
// never has; and `INTERNAL`, logged, for a lookup or read that failed. No
// listener throws (`emit/answer.ts`).

import { CLIENT_EVENTS } from "../../contract/names";
import { checkKind } from "../access/kinds";
import { answerEvent, answerNow, onDisconnect } from "../emit/answer";
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

/**
 * The socket extension (`transports/socketio.ts`) that serves `qd:col:sub`,
 * `qd:col:items` and `qd:col:unsub` for one dispatcher's collections.
 */
export function collectionSubscriptions(
  hub: CollectionHub,
): (socket: QuickdrawServerSocket, context: SocketContext) => void {
  return (socket, context) => {
    answerEvent(socket, context, CLIENT_EVENTS.collectionSub, async (frame) => {
      const request = readSubscribe(frame);
      const { collection } = servedCollection(hub, socket, request);
      checkKind(collection.service.kinds, socket.data.principal, collection.service.name);
      return await subscribeScope(hub, socket, collection, request);
    });
    answerEvent(socket, context, CLIENT_EVENTS.collectionItems, async (frame) => {
      return await loadItems(hub, socket, readItemsRequest(frame));
    });
    socket.on(CLIENT_EVENTS.collectionUnsub, (frame: unknown, ack: unknown) => {
      answerNow(socket, context, CLIENT_EVENTS.collectionUnsub, ack, () =>
        unsubscribeScope(hub, socket, frame),
      );
    });
    onDisconnect(socket, context, () => {
      hub.collections.scopes.drop(socket);
    });
  };
}
