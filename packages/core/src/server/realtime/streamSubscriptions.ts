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
// acknowledgement). A stream whose service computes its seed (`streams: {
// <name>: { seed } }`) calls that function in the tick the socket joined,
// under the subscriber's principal, instead of reading the kept items: one
// that returns at once keeps the same guarantee; one that returns a promise
// may also see items pushed while it runs, which then arrive both ways. What
// it returns is checked against the item schema, and what it throws (or a
// mismatch) answers the subscribe and takes the socket out of the feed. An
// unsubscribe that arrives while a subscribe of the same feed is being
// authorized stops it from joining (and from computing a seed nobody would
// read). A socket holds at most `MAX_STREAMS_PER_SOCKET` feeds (`CONFLICT`
// past that), recorded on `socket.data.streams` with the rows their access
// is derived from (`streamIndex.ts`), so an access change revokes them
// (`streamRevocation.ts`); Socket.IO empties its rooms when it disconnects.

import { CLIENT_EVENTS } from "../../contract/names";
import { QuickdrawError } from "../../protocol/errors";
import { answerEvent, answerNow, onDisconnect } from "../emit/answer";
import type { Hub } from "../emit/hub";
import { PendingKeys } from "../emit/pending";
import type { QuickdrawServerSocket, SocketContext } from "../transports/types";
import { computeSeed, streamKey, type StreamSeeds } from "./seeds";
import { subscriptionOf, type StreamIndex } from "./streamIndex";
import { authorizeStream, checkUnsubscriber, streamAnchors, streamTarget } from "./streamTargets";
import type { StreamSubscription } from "./types";

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
  readonly index: StreamIndex;
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
  let joined: StreamSubscription | undefined;
  try {
    await authorizeStream(state.hub, socket, target);
    const anchors = await streamAnchors(state.hub, socket, target);
    const known = state.index.get(socket, room) !== undefined;
    if (!known && state.index.size(socket) >= MAX_STREAMS_PER_SOCKET) {
      throw new QuickdrawError(
        "CONFLICT",
        `A socket may subscribe to at most ${MAX_STREAMS_PER_SOCKET} stream feeds; unsubscribe from one first`,
      );
    }
    if (socket.connected && state.pending.count(socket, room) === unsubscribes) {
      joined = subscriptionOf(target, anchors);
      state.index.set(socket, joined);
    }
  } finally {
    state.pending.end(socket, [room]);
  }
  if (target.stream.computeSeed === undefined) {
    const key = streamKey(target.service.name, target.stream.name);
    return { ok: true, seed: state.seeds.seed(key, target.scope) };
  }
  if (joined === undefined) {
    // An unsubscribe or a disconnect overtook the subscribe: nobody reads this seed.
    return { ok: true, seed: [] };
  }
  try {
    const ctx = Object.freeze({
      principal: socket.data.principal ?? null,
      socketId: socket.id,
      log: state.hub.logger,
    });
    // Called in this tick, the one the socket joined the feed in.
    return {
      ok: true,
      seed: await computeSeed(
        target.service.name,
        target.stream,
        target.scope,
        ctx,
        state.hub.outputValidation,
      ),
    };
  } catch (error) {
    // The subscriber is answered the failure, so it hears none of the items that follow.
    if (state.index.get(socket, room) === joined) {
      state.index.delete(socket, room);
    }
    throw error;
  }
}

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
    answerEvent(socket, context, CLIENT_EVENTS.streamSub, (frame) =>
      subscribe(state, socket, frame),
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
