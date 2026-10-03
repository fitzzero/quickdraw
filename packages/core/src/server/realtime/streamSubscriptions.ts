// The socket listeners of stream subscriptions (RFC 0003 sections 8.2 and
// 12.5): `qd:stream:sub { s, stream, scope? }`, answered `{ ok: true, seed }`
// or `{ ok: false, e }`, and `qd:stream:unsub`, optionally acknowledged
// `{ ok: true }`. One listener per event on every v5 socket, routed by the
// frame. Neither counts against the socket rate limiter
// (`transports/middleware.ts`); `qd:stream:sub` runs in the socket's lane of
// subscription work (`emit/lane.ts`), and no listener throws
// (`emit/answer.ts`).
//
// A subscribe is authorized (`streamTargets.ts`), then joins the feed's room
// and reads its seed in the same tick, so every item pushed after the seed
// reaches the socket as a `qd:stream` frame (possibly before the
// acknowledgement). An unsubscribe that arrives while a subscribe of the same
// feed is being authorized stops it from joining. A socket holds at most
// `MAX_STREAMS_PER_SOCKET` feeds (`CONFLICT` past that), recorded on
// `socket.data.streams` in an object without a prototype; Socket.IO empties
// its rooms when it disconnects.

import { CLIENT_EVENTS } from "../../contract/names";
import { QuickdrawError } from "../../protocol/errors";
import { answerEvent, answerNow } from "../emit/answer";
import type { Hub } from "../emit/hub";
import { PendingKeys } from "../emit/pending";
import { emptyRecords, ownRecord } from "../emit/subscriptions";
import type { QuickdrawServerSocket, SocketContext } from "../transports/types";
import { streamKey, type StreamSeeds } from "./seeds";
import { authorizeStream, checkUnsubscriber, streamTarget } from "./streamTargets";

/** The acknowledgement of `qd:stream:sub` (`StreamSubscribeReply` in `envelope.ts`). */
interface SeedReply {
  readonly ok: true;
  readonly seed: readonly unknown[];
}

/** The most stream feeds one socket may subscribe to at once. */
export const MAX_STREAMS_PER_SOCKET = 500;

interface StreamState {
  readonly hub: Hub;
  readonly seeds: StreamSeeds;
  readonly pending: PendingKeys;
}

async function subscribe(
  state: StreamState,
  socket: QuickdrawServerSocket,
  value: unknown,
): Promise<SeedReply> {
  const target = streamTarget(state.hub, value, CLIENT_EVENTS.streamSub);
  const { room } = target;
  const unsubscribes = state.pending.begin(socket, [room]).get(room) ?? 0;
  try {
    await authorizeStream(state.hub, socket, target);
    const held = (socket.data.streams ??= emptyRecords<true>());
    const known = ownRecord(held, room) !== undefined;
    if (!known && Object.keys(held).length >= MAX_STREAMS_PER_SOCKET) {
      throw new QuickdrawError(
        "CONFLICT",
        `A socket may subscribe to at most ${MAX_STREAMS_PER_SOCKET} stream feeds; unsubscribe from one first`,
      );
    }
    if (socket.connected && state.pending.count(socket, room) === unsubscribes) {
      held[room] = true;
      void socket.join(room);
    }
  } finally {
    state.pending.end(socket, [room]);
  }
  const key = streamKey(target.service.name, target.stream.name);
  return { ok: true, seed: state.seeds.seed(key, target.scope) };
}

function unsubscribe(
  state: StreamState,
  socket: QuickdrawServerSocket,
  value: unknown,
): { readonly ok: true } {
  const target = streamTarget(state.hub, value, CLIENT_EVENTS.streamUnsub);
  checkUnsubscriber(socket, target);
  state.pending.unsubscribed(socket, target.room);
  const held = socket.data.streams;
  if (held !== undefined && ownRecord(held, target.room) !== undefined) {
    delete held[target.room];
  }
  void socket.leave(target.room);
  return { ok: true };
}

/**
 * The socket extension (`transports/socketio.ts`) that serves
 * `qd:stream:sub` and `qd:stream:unsub` for one dispatcher's streams.
 */
export function streamSubscriptions(
  hub: Hub,
  seeds: StreamSeeds,
): (socket: QuickdrawServerSocket, context: SocketContext) => void {
  const state: StreamState = { hub, seeds, pending: new PendingKeys() };
  return (socket, context) => {
    answerEvent(socket, context, CLIENT_EVENTS.streamSub, (frame) =>
      subscribe(state, socket, frame),
    );
    socket.on(CLIENT_EVENTS.streamUnsub, (frame: unknown, ack: unknown) => {
      answerNow(socket, context, CLIENT_EVENTS.streamUnsub, ack, () =>
        unsubscribe(state, socket, frame),
      );
    });
  };
}
