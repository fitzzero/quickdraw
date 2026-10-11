// One `qd:stream:sub` (RFC 0003 sections 8.2 and 12.5), in the order the
// other subscribes go (`../emit/subscribe.ts`): authorize the subscriber
// (`streamTargets.ts`), join the feed's room, settle the races, then read
// the seed.
//
// - A subscribe no access change overlapped joins the feed's room and reads
//   its seed in the same tick, so every item pushed after the seed reaches
//   the socket as a `qd:stream` frame (possibly before the acknowledgement).
// - One an access change overlapped (or whose socket's principal was
//   replaced meanwhile) is authorized again once it joined, with the
//   socket's principal as it is then (`../emit/race.ts`): one that lost
//   access leaves the room and is answered `FORBIDDEN` (the 5.1 audit's
//   RT-1: a member removed while subscribing kept the feed, seed and all).
//   Its seed is read after that, so an item pushed meanwhile may arrive both
//   as a frame and in the seed.
// - A stream whose service computes its seed (`streams: { <name>: { seed }
//   }`) calls that function instead of reading the kept items, at that same
//   point, under the subscriber's principal: one that returns at once keeps
//   the same guarantee; one that returns a promise may also see items pushed
//   while it runs, which then arrive both ways. What it returns is checked
//   against the item schema, and what it throws (or a mismatch) answers the
//   subscribe and takes the socket out of the feed.
// - An unsubscribe that arrives while a subscribe of the same feed is being
//   authorized stops it from joining. A subscribe that did not join, or
//   whose record the client ended while it settled, is answered `{ ok: true,
//   seed: [] }`: nobody reads that seed.
//
// A socket holds at most `MAX_STREAMS_PER_SOCKET` feeds (`CONFLICT` past
// that), recorded on `socket.data.streams` with the rows their access is
// derived from (`streamIndex.ts`), so an access change revokes them
// (`streamRevocation.ts`).

import { QuickdrawError } from "../../protocol/errors";
import type { Hub } from "../emit/hub";
import type { PendingKeys } from "../emit/pending";
import { raceMoved, raceStart, settleJoin, type RaceStart } from "../emit/race";
import type { QuickdrawServerSocket } from "../transports/types";
import { computeSeed, streamKey, type StreamSeeds } from "./seeds";
import { subscriptionOf, type StreamIndex } from "./streamIndex";
import { anchorsNow } from "./streamRevocation";
import { authorizeStream, streamAnchors, type StreamTarget } from "./streamTargets";
import type { StreamSubscription } from "./types";

/** The acknowledgement of `qd:stream:sub` (`StreamSubscribeReply` in `envelope.ts`). */
export interface SeedReply {
  readonly ok: true;
  readonly seed: readonly unknown[];
}

/** The most stream feeds one socket may subscribe to at once. */
export const MAX_STREAMS_PER_SOCKET = 500;

/** What the stream listeners of one dispatcher share. */
export interface StreamState {
  readonly hub: Hub;
  readonly seeds: StreamSeeds;
  readonly index: StreamIndex;
  /** The feeds each socket has a `qd:stream:sub` in flight for, by room. */
  readonly pending: PendingKeys;
}

/** A subscribe that joined: its record, what it settles against, and the unsubscribes when it began. */
interface Joined {
  readonly own: StreamSubscription;
  readonly start: RaceStart;
  readonly unsubscribes: number;
}

/**
 * Joins the feed's room with `anchors`, unless an unsubscribe or a
 * disconnect overtook the subscribe: the record it joined with. `CONFLICT`
 * past the socket's feeds.
 */
function joinFeed(
  state: StreamState,
  socket: QuickdrawServerSocket,
  target: StreamTarget,
  [anchors, unsubscribes]: readonly [readonly string[], number],
): StreamSubscription | undefined {
  const known = state.index.get(socket, target.room) !== undefined;
  if (!known && state.index.size(socket) >= MAX_STREAMS_PER_SOCKET) {
    throw new QuickdrawError(
      "CONFLICT",
      `A socket may subscribe to at most ${MAX_STREAMS_PER_SOCKET} stream feeds; unsubscribe from one first`,
    );
  }
  if (!socket.connected || state.pending.count(socket, target.room) !== unsubscribes) {
    return undefined;
  }
  const own = subscriptionOf(target, anchors);
  state.index.set(socket, own);
  return own;
}

/** Settles a joined subscribe against the access changes made since it began (`../emit/race.ts`). */
async function settleFeed(
  state: StreamState,
  socket: QuickdrawServerSocket,
  target: StreamTarget,
  joined: Joined,
): Promise<StreamSubscription | undefined> {
  const { hub, index, pending } = state;
  return await settleJoin(hub, socket, joined.start, joined.own, {
    current: () => index.get(socket, target.room),
    withdrawn: () =>
      !socket.connected || pending.count(socket, target.room) !== joined.unsubscribes,
    authorize: async (subscription) => await anchorsNow(hub, socket, subscription),
    reanchor: (_subscription, anchors) => {
      const next = subscriptionOf(target, anchors);
      index.set(socket, next);
      return next;
    },
    leave: () => {
      index.delete(socket, target.room);
    },
  });
}

/**
 * The seed of a feed the socket holds as `held`: the kept items, or what
 * the service computes, called in this tick. A computed seed that fails
 * takes the socket out of the feed.
 */
async function seedOf(
  state: StreamState,
  socket: QuickdrawServerSocket,
  target: StreamTarget,
  held: StreamSubscription,
): Promise<SeedReply> {
  if (target.stream.computeSeed === undefined) {
    const key = streamKey(target.service.name, target.stream.name);
    return { ok: true, seed: state.seeds.seed(key, target.scope) };
  }
  try {
    const ctx = Object.freeze({
      principal: socket.data.principal ?? null,
      socketId: socket.id,
      log: state.hub.logger,
    });
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
    if (state.index.get(socket, target.room) === held) {
      state.index.delete(socket, target.room);
    }
    throw error;
  }
}

/**
 * Answers one `qd:stream:sub` of `target` (the module header). Rejects with
 * the authorization's refusal, `FORBIDDEN` for one that lost access while
 * it was answered, `CONFLICT` past the socket's feeds, or what a computed
 * seed throws.
 */
export async function subscribeFeed(
  state: StreamState,
  socket: QuickdrawServerSocket,
  target: StreamTarget,
): Promise<SeedReply> {
  const { room } = target;
  const unsubscribes = state.pending.begin(socket, [room]).get(room) ?? 0;
  const start = raceStart(state.hub, socket);
  let held: StreamSubscription | undefined;
  try {
    await authorizeStream(state.hub, socket, target);
    const anchors = await streamAnchors(state.hub, socket, target);
    held = joinFeed(state, socket, target, [anchors, unsubscribes]);
    if (held !== undefined && raceMoved(state.hub, socket, start)) {
      held = await settleFeed(state, socket, target, { own: held, start, unsubscribes });
    }
  } finally {
    state.pending.end(socket, [room]);
  }
  // Unsettled, this runs in the tick the socket joined the feed.
  return held === undefined ? { ok: true, seed: [] } : await seedOf(state, socket, target, held);
}
