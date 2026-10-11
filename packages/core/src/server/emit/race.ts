// Settling a subscribe that joined its room against the access changes made
// while it was being authorized (RFC 0003 section 4.3; the 5.1 audit's
// LIVE-2 and RT-1). A subscribe authorizes, then joins; an access change
// flushed in between re-checks only what had joined, so it misses this one,
// and the socket would keep a room it lost. So a subscribe notes the
// process's access changes and the socket's principal before it authorizes
// (`raceStart`), and once it joined, while either moved, authorizes again
// with the socket's principal as it is then, at most `MAX_RECHECKS` more
// times (`settleJoin`):
//
// - another identity, or none, is denied without a lookup; the same user
//   with replaced grants is authorized with the grants the socket holds now;
// - denied, the socket leaves the room, and the subscribe is answered
//   `FORBIDDEN`;
// - a record someone else ended meanwhile (revocation) is `FORBIDDEN`,
//   unless the client unsubscribed or the socket went; one someone else
//   replaced (a newer subscribe, revocation authorizing it again) stands;
// - allowed with other anchors, the record is replaced, so revocation finds
//   it by them; while access still moved after the last check, a record
//   whose anchors that check moved is denied: it may have missed a change on
//   them.
//
// Change topic watches (`../topicRevocation.ts`) and stream feeds
// (`../realtime/streamSubscribe.ts`) settle here. Entity batches and
// collection scopes settle by the same rules in their own modules
// (`subscribe.ts`, `../collections/subscribe.ts`), which also read again.

import { QuickdrawError } from "../../protocol/errors";
import type { QuickdrawServerSocket } from "../transports/types";
import { MAX_RECHECKS } from "./subscribe";

/** What a subscribe noted before it authorized: the access changes the process had seen, and the socket's principal. */
export interface RaceStart {
  readonly checkedAt: number;
  readonly principal: QuickdrawServerSocket["data"]["principal"];
}

/** A hub's count of the access changes it handled (`subscriptions.ts`). */
interface AccessChanges {
  readonly subscriptions: { readonly accessChanges: number };
}

/** Notes what a subscribe settles against: call it before it authorizes. */
export function raceStart(hub: AccessChanges, socket: QuickdrawServerSocket): RaceStart {
  return { checkedAt: hub.subscriptions.accessChanges, principal: socket.data.principal };
}

/** True when access changed, or the socket's principal was replaced, since `start`. */
export function raceMoved(
  hub: AccessChanges,
  socket: QuickdrawServerSocket,
  start: RaceStart,
): boolean {
  return (
    hub.subscriptions.accessChanges !== start.checkedAt || socket.data.principal !== start.principal
  );
}

/** A subscribe's record in its index, as `settleJoin` reads and changes it. */
export interface JoinedRecord<R extends { readonly anchors?: readonly string[] }> {
  /** The socket's record of the subscribe's room now. */
  readonly current: () => R | undefined;
  /** True when the client unsubscribed since the subscribe began, or the socket went. */
  readonly withdrawn: () => boolean;
  /**
   * Authorizes `record` again with the socket's principal as it is now: its
   * anchors, or `undefined` when denied (a lookup that failed included).
   */
  readonly authorize: (record: R) => Promise<readonly string[] | undefined>;
  /** Records `record` again with `anchors`; returns what it recorded. */
  readonly reanchor: (record: R, anchors: readonly string[]) => R;
  /** Ends the subscribe's record: the socket leaves the room. */
  readonly leave: () => void;
}

function forbidden(): QuickdrawError {
  return new QuickdrawError("FORBIDDEN", "Insufficient permissions");
}

function sameAnchors(a: readonly string[] = [], b: readonly string[] = []): boolean {
  return a.length === b.length && a.every((anchor, index) => anchor === b[index]);
}

/**
 * Settles a subscribe that joined with `own` (the module header). Resolves
 * with the record the socket holds once access stood still, `own` or a
 * newer one, or `undefined` when the client unsubscribed, the socket went,
 * or a newer record took the room while this one was denied. Throws
 * `FORBIDDEN` when the subscribe lost access, or revocation ended its
 * record.
 */
export async function settleJoin<R extends { readonly anchors?: readonly string[] }>(
  hub: AccessChanges,
  socket: QuickdrawServerSocket,
  start: RaceStart,
  own: R,
  joined: JoinedRecord<R>,
): Promise<R | undefined> {
  const userId = start.principal?.userId ?? null;
  let checked = start;
  let record = own;
  let moving = false;
  for (let round = 0; round <= MAX_RECHECKS && raceMoved(hub, socket, checked); round += 1) {
    checked = raceStart(hub, socket);
    const same = (checked.principal?.userId ?? null) === userId;
    const anchors = same ? await joined.authorize(record) : undefined;
    const current = joined.current();
    if (current !== record) {
      // Revocation ended it (a denial), or the client or a newer subscribe did (that stands).
      if (current === undefined && !joined.withdrawn()) {
        throw forbidden();
      }
      return anchors === undefined ? undefined : current;
    }
    if (anchors === undefined) {
      joined.leave();
      throw forbidden();
    }
    moving = !sameAnchors(record.anchors, anchors);
    if (moving) {
      record = joined.reanchor(record, anchors);
    }
  }
  if (moving && raceMoved(hub, socket, checked)) {
    // Access changed during the last check too, and it moved the anchors: they may have missed it.
    joined.leave();
    throw forbidden();
  }
  return record;
}
