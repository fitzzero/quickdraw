// Revoking stream subscriptions (RFC 0003 sections 4.4 and 12.5), beside the
// entity, collection and topic revocations (`emit/revocation.ts`, which calls
// this on every access change it handles). Each feed's subscription records
// the rows its access is derived from (its anchors, `streamIndex.ts`); when a
// flush may have changed someone's level on one, the feeds anchored there are
// authorized again through the access engine, as a subscribe is
// (`streamTargets.ts`), for the user the change names or for everyone. A
// changed `serviceAccess` (`server.access.refresh`, or another node's
// `quickdraw:grants`) authorizes every feed of the user's sockets again, so
// a `{ service }` stream is checked against the new grants.
//
// - no longer allowed: the socket leaves the feed's room and gets
//   `qd:revoked { kind: "stream", reason: "access", s, stream, scope? }`, and
//   no item pushed after that reaches it;
// - still allowed: the subscription keeps its room, with its anchors read
//   again;
// - a lookup that fails denies, as everywhere else.

import { SERVER_EVENTS } from "../../contract/names";
import type { RevokedFrame } from "../../protocol/envelope";
import { QuickdrawError } from "../../protocol/errors";
import type { Hub } from "../emit/hub";
import type { RevocationHook } from "../emit/revocation";
import { describeError } from "../pipeline/metrics";
import type { QuickdrawServerSocket } from "../transports/types";
import { streamRoomOf, subscriptionOf, type StreamIndex } from "./streamIndex";
import { authorizeStream, streamAnchors, streamTarget } from "./streamTargets";
import type { StreamSubscription } from "./types";

type Found = Iterable<readonly [QuickdrawServerSocket, readonly StreamSubscription[]]>;

/** The anchors the subscription may keep, or `undefined` when it may no longer read the feed. */
async function anchorsNow(
  hub: Hub,
  socket: QuickdrawServerSocket,
  subscription: StreamSubscription,
): Promise<readonly string[] | undefined> {
  try {
    const target = streamTarget(hub, subscription, SERVER_EVENTS.revoked);
    await authorizeStream(hub, socket, target);
    return await streamAnchors(hub, socket, target);
  } catch (error) {
    if (!(error instanceof QuickdrawError) || error.code === "INTERNAL") {
      hub.logger.error(
        "Authorizing a stream subscriber again failed; the subscription is revoked",
        {
          category: "quickdraw.access",
          service: subscription.s,
          stream: subscription.stream,
          error: describeError(error),
        },
      );
    }
    return undefined;
  }
}

/** Authorizes one subscription again, and applies the answer. */
async function reauthorize(
  hub: Hub,
  index: StreamIndex,
  socket: QuickdrawServerSocket,
  subscription: StreamSubscription,
): Promise<void> {
  const anchors = await anchorsNow(hub, socket, subscription);
  const room = streamRoomOf(subscription);
  // Unsubscribed, subscribed again or authorized again meanwhile: that is newer than this.
  if (!socket.connected || index.get(socket, room) !== subscription) {
    return;
  }
  if (anchors !== undefined) {
    const target = streamTarget(hub, subscription, SERVER_EVENTS.revoked);
    index.set(socket, subscriptionOf(target, anchors));
    return;
  }
  index.delete(socket, room);
  const { s, stream, scope } = subscription;
  const frame: RevokedFrame =
    scope === undefined
      ? { kind: "stream", reason: "access", s, stream }
      : { kind: "stream", reason: "access", s, stream, scope };
  socket.emit(SERVER_EVENTS.revoked, frame);
}

/** Authorizes the given subscriptions again, all at once. */
async function reauthorizeAll(hub: Hub, index: StreamIndex, found: Found): Promise<void> {
  const work: Promise<void>[] = [];
  for (const [socket, subscriptions] of found) {
    for (const subscription of subscriptions) {
      work.push(reauthorize(hub, index, socket, subscription));
    }
  }
  await Promise.all(work);
}

/** The stream half of a dispatcher's revocation. */
export function createStreamRevocation(hub: Hub, index: StreamIndex): RevocationHook {
  return Object.freeze({
    changed: async (change) => await reauthorizeAll(hub, index, index.matching(change)),
    regranted: async (sockets) =>
      await reauthorizeAll(
        hub,
        index,
        sockets.map((socket) => [socket, index.entries(socket)] as const),
      ),
  } satisfies RevocationHook);
}
