// One `qd:stream:sub` (RFC 0003 sections 8.2 and 12.5): authorize the
// subscriber (`streamTargets.ts`), record the subscription, settle the races
// with access changes, then join the feed's room and read the seed in one
// tick, so every item pushed after the seed reaches the socket as a
// `qd:stream` frame (possibly before the acknowledgement), and none arrives
// both ways.
//
// - A subscribe no access change overlapped joins in the tick it is
//   recorded.
// - One an access change overlapped (or whose socket's principal was
//   replaced meanwhile) is authorized again first, with the socket's
//   principal as it is then (`../emit/race.ts`): recorded, so revocation
//   finds it, but out of the room, so nothing pushed meanwhile reaches it.
//   One that lost access is answered `FORBIDDEN` (the 5.1 audit's RT-1: a
//   member removed while subscribing kept the feed, seed and all).
// - A stream whose service computes its seed (`streams: { <name>: { seed }
//   }`) calls that function instead of reading the kept items, at that same
//   point, under the subscriber's principal: one that returns at once keeps
//   the same guarantee; one that returns a promise may also see items pushed
//   while it runs, which then arrive both ways. What it returns is checked
//   against the item schema, and what it throws (or a mismatch) answers the
//   subscribe and takes the socket out of the feed.
// - An unsubscribe that arrives while a subscribe of the same feed is being
//   authorized stops it from joining. A subscribe that did not join is
//   answered `{ ok: true, seed: [] }`: nobody reads that seed.
//
// A socket holds at most `MAX_STREAMS_PER_SOCKET` feeds (`CONFLICT` past
// that), recorded on `socket.data.streams` with the rows their access is
// derived from (`streamIndex.ts`), so an access change revokes them
// (`streamRevocation.ts`).

import { QuickdrawError } from "../../protocol/errors";
import type { Hub } from "../emit/hub";
import type { PendingKeys } from "../emit/pending";
import { enterSettled, raceMoved, raceStart, settleJoin, type RaceStart } from "../emit/race";
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

/** A subscribe recorded: its record, what it settles against, and the unsubscribes when it began. */
interface Held {
  readonly own: StreamSubscription;
  readonly start: RaceStart;
  readonly unsubscribes: number;
}

/**
 * Records the subscription with `anchors`, out of the feed's room, unless an
 * unsubscribe or a disconnect overtook the subscribe: the record. `CONFLICT`
 * past the socket's feeds.
 */
function holdFeed(
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
  if (withdrawn(state, socket, target, unsubscribes)) {
    return undefined;
  }
  const own = subscriptionOf(target, anchors);
  state.index.hold(socket, own);
  return own;
}

/** True when the client unsubscribed from the feed since the subscribe began, or the socket went. */
function withdrawn(
  state: StreamState,
  socket: QuickdrawServerSocket,
  target: StreamTarget,
  unsubscribes: number,
): boolean {
  return !socket.connected || state.pending.count(socket, target.room) !== unsubscribes;
}

/** Settles a recorded subscribe against the access changes made since it began (`../emit/race.ts`). */
async function settleFeed(
  state: StreamState,
  socket: QuickdrawServerSocket,
  target: StreamTarget,
  held: Held,
): Promise<StreamSubscription | undefined> {
  const { hub, index } = state;
  return await settleJoin(hub, socket, held.start, held.own, {
    current: () => index.get(socket, target.room),
    withdrawn: () => withdrawn(state, socket, target, held.unsubscribes),
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
    held = holdFeed(state, socket, target, [anchors, unsubscribes]);
    if (held !== undefined && raceMoved(state.hub, socket, start)) {
      held = await settleFeed(state, socket, target, { own: held, start, unsubscribes });
    }
    if (held !== undefined) {
      held = enterSettled(
        () => state.index.join(socket, room),
        () => withdrawn(state, socket, target, unsubscribes),
      );
    }
  } finally {
    state.pending.end(socket, [room]);
  }
  // The tick the socket joined the feed's room.
  return held === undefined ? { ok: true, seed: [] } : await seedOf(state, socket, target, held);
}
