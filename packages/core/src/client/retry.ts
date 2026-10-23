// Connecting again after the server could not authenticate the connection
// (RFC 0003 section 8.1): a handshake refused `INTERNAL` (its `authenticate`
// failed with anything but a refusal: its session store down, say). Socket.IO
// does not retry a handshake its middleware refused (the socket is left
// inactive), so the connection does, waiting what Socket.IO's manager waits
// between reconnection attempts: its `reconnectionDelay`, doubling with each
// attempt in a row, with `randomizationFactor`'s jitter (Socket.IO's
// `backo2` formula), at most `reconnectionDelayMax`, as often as
// `reconnectionAttempts` allows. An app tunes them with `socketOptions`.
//
// React-free: each connection owns one (`connection.ts`).

import type { QuickdrawSocket } from "./socket";

/** The most doublings a wait takes; `reconnectionDelayMax` caps it long before. */
const MAX_DOUBLINGS = 20;

/** The wait before attempt `attempt` (from 0) to connect again, in milliseconds. */
export function retryDelay(socket: QuickdrawSocket, attempt: number): number {
  const manager = socket.io;
  const wait = manager.reconnectionDelay() * 2 ** Math.min(attempt, MAX_DOUBLINGS);
  const deviation = Math.floor(Math.random() * manager.randomizationFactor() * wait);
  const jittered = Math.random() < 0.5 ? wait - deviation : wait + deviation;
  return Math.min(jittered, manager.reconnectionDelayMax());
}

/** The retries of one connection's socket after the server could not authenticate it. */
export interface Retry {
  /**
   * Connects the socket again after the next wait. False, and nothing
   * scheduled, when the connection is not trying to connect, Socket.IO's
   * reconnection is off, or its attempts are spent.
   */
  later(): boolean;
  /** Cancels a scheduled attempt, and the next refusal waits from the start again. */
  stop(): void;
  /** The socket connected: the next refusal waits from the start again. */
  connected(): void;
}

/** Creates the retries of `socket`, which run only while `wanted()`: the connection is trying to connect. */
export function createRetry(socket: QuickdrawSocket, wanted: () => boolean): Retry {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempts = 0;
  return Object.freeze({
    later(): boolean {
      const manager = socket.io;
      if (!wanted() || !manager.reconnection() || attempts >= manager.reconnectionAttempts()) {
        return false;
      }
      clearTimeout(timer);
      timer = setTimeout(
        () => {
          timer = undefined;
          if (wanted() && !socket.connected && !socket.active) {
            socket.connect();
          }
        },
        retryDelay(socket, attempts),
      );
      attempts += 1;
      return true;
    },
    stop(): void {
      clearTimeout(timer);
      timer = undefined;
      attempts = 0;
    },
    connected(): void {
      attempts = 0;
    },
  });
}
