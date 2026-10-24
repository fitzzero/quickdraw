// Whether a socket's connection is backed up (RFC 0003 section 12.5), for
// the messages the server drops rather than queues: a relay message on
// `fast` (`peerDelivery.ts`) and a volatile stream's frame
// (`streamPushes.ts`). Each socket counts the relay messages and volatile
// frames sent to it since its connection last handed what waits to its
// transport (engine.io's `drain`, on every flush); from
// `PEER_RELAY_FAST_BACKLOG` on it is backed up, and the next message that
// may be dropped is. Not Socket.IO's volatile flag, which drops a message
// whenever a write is in flight (engine.io's transport stays busy from each
// write until it is done), so a burst of items in one tick lost all but its
// first, and an item pushed right after an answer to the socket was lost.
//
// Count a message before sending it: a socket whose transport is free
// flushes it at once, inside `emit`, and the `drain` comes then.

import { PEER_RELAY_FAST_BACKLOG } from "../../protocol/version";
import type { QuickdrawServerSocket } from "../transports/types";

/** The messages counted for each socket since its connection last drained. */
const waiting = new WeakMap<QuickdrawServerSocket, number>();

/** True while `socket`'s connection is backed up: a message that may be dropped is. */
export function backedUp(socket: QuickdrawServerSocket): boolean {
  return (waiting.get(socket) ?? 0) >= PEER_RELAY_FAST_BACKLOG;
}

/** Counts a message about to be sent to `socket`, until its connection next drains. */
export function countSend(socket: QuickdrawServerSocket): void {
  const count = waiting.get(socket) ?? 0;
  if (count === 0) {
    socket.conn.once("drain", () => {
      waiting.delete(socket);
    });
  }
  waiting.set(socket, count + 1);
}
