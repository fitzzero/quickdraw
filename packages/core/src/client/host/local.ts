// The link between a room's host and its own client, in process (host
// mode, RFC 0003 section 12.5): two link cores (`../peer/core.ts`) that hand
// each other the JSON text a peer's link carries, at once, so the host's
// own channels and feeds of its room reach it as a peer's do, and the host
// lists its own client among its peers with a link like theirs: `setLag` on
// it gives the host's own play the lag its peers have. Both ends open at
// once, on the `direct` path, each naming this socket and its user; closing
// one closes the other, with `bye`. Neither has a watchdog: both ends ping
// on this tab's timers, so a hidden tab's throttled timers would close the
// link as `lost`, which an in-process link never is.
//
// React-free.

import { createLinkCore, type LinkCore } from "../peer/core";
import type { PeerLink } from "../peer/types";

/**
 * The two ends of the in-process link of `room` on socket `socketId` of
 * `userId`, open: `[near, far]`, this client's end and the host's.
 */
export function createLocalLink(
  room: string,
  socketId: string,
  userId: string,
  maxMessageBytes: () => number,
): readonly [near: PeerLink, far: PeerLink] {
  const ends: LinkCore[] = [];
  const endOf = (other: () => LinkCore | undefined): LinkCore =>
    createLinkCore({
      room,
      peer: socketId,
      maxMessageBytes,
      watchdog: false,
      hooks: {
        send: (label, text) => {
          other()?.receive(text, label);
          return true;
        },
        closed: (_reason, fromHere) => {
          if (fromHere) {
            other()?.end("bye");
          }
        },
      },
    });
  const near = endOf(() => ends[1]);
  const far = endOf(() => ends[0]);
  ends.push(near, far);
  for (const end of ends) {
    end.identify(userId);
  }
  far.carry("direct");
  near.carry("direct");
  return [near.link, far.link];
}
