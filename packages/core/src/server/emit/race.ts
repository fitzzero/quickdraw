// Settling a subscribe against the access changes made while it was being
// authorized (RFC 0003 section 4.3; the 5.1 audit's LIVE-2 and RT-1). A
// subscribe authorizes, then records itself; an access change flushed in
// between re-checks only what was recorded, so it misses this one, and the
// socket would keep a room it lost. So a subscribe notes the process's
// access changes and the socket's principal before it authorizes
// (`raceStart`), and once recorded, while either moved, authorizes again
// with the socket's principal as it is then, at most `MAX_RECHECKS` more
// times (`settleJoin`):
//
// - another identity, or none, is denied without a lookup; the same user
//   with replaced grants is authorized with the grants the socket holds now;
// - denied, the record ends, and the subscribe is answered `FORBIDDEN`;
// - a record revocation ended meanwhile is `FORBIDDEN` too, unless the
//   client unsubscribed or the socket went; one revocation authorized again
//   meanwhile (with other anchors) is adopted, and settled in turn;
// - allowed with other anchors, the record is replaced, so revocation finds
//   it by them; while access still moved after the last check, a record
//   whose anchors that check moved is denied: it may have missed a change on
//   them.
//
// Change topic watches (`../topicRevocation.ts`) and stream feeds
// (`../realtime/streamSubscribe.ts`) settle here, recorded so revocation
// finds them, but out of their room until they settled: nothing reaches a
// socket that is then refused. Entity batches and collection scopes settle
// by the same rules in their own modules (`subscribe.ts`,
// `../collections/subscribe.ts`), in their room already: they need it to
// catch every change after the snapshot they read.

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
  /** Ends the subscribe's record: the socket leaves the room, if it was in it. */
  readonly leave: () => void;
}

function forbidden(): QuickdrawError {
  return new QuickdrawError("FORBIDDEN", "Insufficient permissions");
}

function sameAnchors(a: readonly string[] = [], b: readonly string[] = []): boolean {
  return a.length === b.length && a.every((anchor, index) => anchor === b[index]);
}

/**
 * Settles a subscribe recorded as `own` (the module header). Resolves with
 * the record the socket holds once access stood still, `own` or a newer
 * one, or `undefined` when the client unsubscribed or the socket went.
 * Throws `FORBIDDEN`, the record ended, when the subscribe lost access or
 * revocation ended its record.
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
  for (let round = 0; round < MAX_RECHECKS && raceMoved(hub, socket, checked); round += 1) {
    checked = raceStart(hub, socket);
    const same = (checked.principal?.userId ?? null) === userId;
    const anchors = same ? await joined.authorize(record) : undefined;
    const current = joined.current();
    if (current === undefined) {
      // The client or the socket ended it, which stands; else revocation did: a denial.
      if (joined.withdrawn()) {
        return undefined;
      }
      throw forbidden();
    }
    if (anchors === undefined) {
      joined.leave();
      throw forbidden();
    }
    if (current === record) {
      moving = !sameAnchors(record.anchors, anchors);
      record = moving ? joined.reanchor(record, anchors) : record;
    } else {
      // Revocation authorized it again meanwhile: settle what it recorded.
      record = current;
      moving = true;
    }
  }
  if (moving && raceMoved(hub, socket, checked)) {
    // Access changed during the last check too, and it moved the anchors: they may have missed it.
    joined.leave();
    throw forbidden();
  }
  return record;
}

/**
 * Puts a settled subscribe in its room with `enter`, which returns the
 * record the socket holds there: that record, or `undefined` when the
 * client unsubscribed or the socket went meanwhile. Throws `FORBIDDEN` when
 * revocation ended the record after the subscribe settled.
 */
export function enterSettled<R>(
  enter: () => R | undefined,
  withdrawn: () => boolean,
): R | undefined {
  const entered = enter();
  if (entered === undefined && !withdrawn()) {
    throw forbidden();
  }
  return entered;
}
