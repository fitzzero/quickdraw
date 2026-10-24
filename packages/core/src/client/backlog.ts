// Whether a client's way to the server is backed up (RFC 0003 section
// 12.5), which a message that may be dropped asks before it goes out on the
// socket: a channel message (`live/useChannel.ts`) and a relay message on
// `fast` (`peer/hub.ts`). Backed up is `PEER_RELAY_FAST_BACKLOG` packets
// waiting for engine.io's transport, or more than `FAST_BACKLOG_BYTES`
// unsent in its WebSocket; then the message is dropped rather than queued.
// Not Socket.IO's volatile flag, which drops a packet whenever a write is in
// flight (engine.io marks its transport busy from each write until the next
// tick), so of the messages sent in one tick all but the first were lost.
//
// `useChannel` is on every app's startup path, so this imports nothing from
// `peer/`, which loads lazily (`host/links.ts`).
//
// React-free.

import { FAST_BACKLOG_BYTES, PEER_RELAY_FAST_BACKLOG } from "../protocol/version";
import type { QuickdrawSocket } from "./socket";

/** What `backedUp` reads of a socket's engine.io connection. */
export interface EngineView {
  readonly writeBuffer?: readonly unknown[];
  readonly transport?: { readonly ws?: { readonly bufferedAmount?: unknown } };
}

/**
 * True while the way to the server is backed up: `PEER_RELAY_FAST_BACKLOG`
 * packets wait for the transport, or the WebSocket holds more than
 * `FAST_BACKLOG_BYTES` unsent (engine.io keeps it as its transport's `ws`).
 */
export function backedUp(socket: QuickdrawSocket): boolean {
  const engine = (socket as { readonly io?: { readonly engine?: EngineView } }).io?.engine;
  if ((engine?.writeBuffer?.length ?? 0) >= PEER_RELAY_FAST_BACKLOG) {
    return true;
  }
  const buffered = engine?.transport?.ws?.bufferedAmount;
  return typeof buffered === "number" && buffered > FAST_BACKLOG_BYTES;
}
