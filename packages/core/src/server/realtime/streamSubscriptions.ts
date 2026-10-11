// The socket listeners of stream subscriptions (RFC 0003 sections 8.2 and
// 12.5): `qd:stream:sub { s, stream, scope? }`, answered `{ ok: true, seed }`
// or `{ ok: false, e }` (`streamSubscribe.ts`), and `qd:stream:unsub`,
// optionally acknowledged `{ ok: true }`. One listener per event on every v5
// socket, routed by the frame (`streamTargets.ts`). Neither counts against
// the socket rate limiter (`transports/middleware.ts`); `qd:stream:sub` runs
// in the socket's lane of subscription work (`emit/lane.ts`), and no
// listener throws (`emit/answer.ts`). An unsubscribe leaves the feed's room
// at once, and stops a subscribe of the same feed still being authorized
// from joining it; Socket.IO empties a socket's rooms when it disconnects.

import { CLIENT_EVENTS } from "../../contract/names";
import { answerEvent, answerNow, onDisconnect } from "../emit/answer";
import type { Hub } from "../emit/hub";
import { PendingKeys } from "../emit/pending";
import type { QuickdrawServerSocket, SocketContext } from "../transports/types";
import type { StreamSeeds } from "./seeds";
import type { StreamIndex } from "./streamIndex";
import { subscribeFeed, type StreamState } from "./streamSubscribe";
import { checkUnsubscriber, streamTarget } from "./streamTargets";

function unsubscribe(
  state: StreamState,
  socket: QuickdrawServerSocket,
  value: unknown,
): { readonly ok: true } {
  const target = streamTarget(state.hub, value, CLIENT_EVENTS.streamUnsub);
  checkUnsubscriber(socket, target);
  state.pending.unsubscribed(socket, target.room);
  state.index.delete(socket, target.room);
  return { ok: true };
}

/**
 * The socket extension (`transports/socketio.ts`) that serves
 * `qd:stream:sub` and `qd:stream:unsub` for one dispatcher's streams, and
 * drops a disconnected socket's feeds from `index`.
 */
export function streamSubscriptions(
  hub: Hub,
  seeds: StreamSeeds,
  index: StreamIndex,
): (socket: QuickdrawServerSocket, context: SocketContext) => void {
  const state: StreamState = { hub, seeds, index, pending: new PendingKeys() };
  return (socket, context) => {
    answerEvent(
      socket,
      context,
      CLIENT_EVENTS.streamSub,
      async (frame) =>
        await subscribeFeed(state, socket, streamTarget(hub, frame, CLIENT_EVENTS.streamSub)),
    );
    socket.on(CLIENT_EVENTS.streamUnsub, (frame: unknown, ack: unknown) => {
      answerNow(socket, context, CLIENT_EVENTS.streamUnsub, ack, () =>
        unsubscribe(state, socket, frame),
      );
    });
    onDisconnect(socket, context, () => {
      index.drop(socket);
    });
  };
}
