// A host's way out to one peer (host mode, RFC 0003 section 12.5). `fast`
// goes as the link takes it, never resent, as on any link. `rel` keeps its
// order: a message the link drops (over the relay, once the relay's budget
// is spent) waits, with the ones after it, and is sent again a little
// later, so a seed's last chunk never goes missing. A peer whose waiting
// messages pass `MAX_QUEUED_BYTES` cannot keep up: its link closes, and it
// links again and subscribes anew.
//
// React-free.

import type { HostMessage, PeerLabel } from "../../protocol/envelope";
import { encodeMessage, messageBytes } from "../peer/codec";
import { throwLater } from "../peer/core";

/** Sends a host mode message to one peer; false when it was dropped. */
export type HostSend = (label: PeerLabel, message: HostMessage) => boolean;

/** One peer's way out. */
export interface Outbox {
  send(label: PeerLabel, message: HostMessage): void;
  /** Drops what waits: the peer is gone. */
  clear(): void;
}

/** The first wait before a dropped `rel` message is sent again; it doubles up to `MAX_RETRY_MS`. */
const RETRY_MS = 50;
const MAX_RETRY_MS = 1000;

/** The `rel` bytes that may wait for one peer before its link closes. */
export const MAX_QUEUED_BYTES = 8 * 1024 * 1024;

/** Creates a peer's way out over `send`; `close` ends the peer's link. */
export function createOutbox(send: HostSend, close: () => void): Outbox {
  const queue: { readonly message: HostMessage; readonly bytes: number }[] = [];
  let queued = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wait = RETRY_MS;
  const clear = (): void => {
    clearTimeout(timer);
    timer = undefined;
    queue.length = 0;
    queued = 0;
  };
  /**
   * Sends one waiting message: false when the link dropped it again. One
   * that throws (the message limit fell since it waited) is dropped and
   * reported, never left to stop the rest.
   */
  const sent = (message: HostMessage): boolean => {
    try {
      return send("rel", message);
    } catch (error) {
      throwLater(error);
      return true;
    }
  };
  const flush = (): void => {
    timer = undefined;
    for (let next = queue[0]; next !== undefined; next = queue[0]) {
      if (!sent(next.message)) {
        timer = setTimeout(flush, wait);
        wait = Math.min(MAX_RETRY_MS, wait * 2);
        return;
      }
      queue.shift();
      queued -= next.bytes;
    }
    wait = RETRY_MS;
  };
  return {
    send(label: PeerLabel, message: HostMessage): void {
      if (label === "fast") {
        send("fast", message);
        return;
      }
      if (queue.length === 0 && send("rel", message)) {
        return;
      }
      const bytes = messageBytes(encodeMessage(message));
      queue.push({ message, bytes });
      queued += bytes;
      if (queued > MAX_QUEUED_BYTES) {
        clear();
        close();
        return;
      }
      timer ??= setTimeout(flush, wait);
    },
    clear,
  };
}
