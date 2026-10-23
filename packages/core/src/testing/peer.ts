// A peer link in one process, for tests and benches (RFC 0003 section
// 12.5): `createLoopbackPeerLink(options)` returns its two ends, each a
// `PeerLink` that behaves as `createPeerLink`'s does (its events, stats,
// clock pings and watchdog, and `send`'s limits), joined by an in-process
// channel instead of WebRTC or the relay. Every message takes `ms` plus up
// to `jitter` milliseconds; a `fast` message is lost with probability
// `loss`; `rel` messages always arrive, in the order they were sent. The
// channel is two lag queues, one each way (`../client/peer/lag.ts`, which
// `PeerLink.setLag` holds a link's messages on too). Both ends open a
// microtask after they are made; closing one closes the other, with `bye`,
// once a message would have reached it and never before the `rel` messages
// sent ahead of the close, as a link's bye on its own path.

import { createLinkCore, type LinkCore } from "../client/peer/core";
import { checkLag, createLagQueue, type LagQueue } from "../client/peer/lag";
import type { PeerLink, PeerPath } from "../client/peer/types";
import { MAX_PEER_MESSAGE_BYTES } from "../protocol/version";

/** One end of a loopback link: who the other end sees. */
export interface LoopbackEnd {
  /** Its socket id: the other end's `peer`. */
  readonly socketId: string;
  /** Its user: the other end's `userId`. */
  readonly userId: string;
}

/** Options of {@link createLoopbackPeerLink}. */
export interface LoopbackOptions {
  /** How long every message takes, in milliseconds. Default 0: the next task. */
  readonly ms?: number;
  /** Up to this many milliseconds more, at random, per message. Default 0. */
  readonly jitter?: number;
  /** The share of `fast` messages lost on the way, from 0 to 1. Default 0. */
  readonly loss?: number;
  /** The app room the ends say they belong to. Default `"loopback"`. */
  readonly room?: string;
  /** The two ends. Default sockets `"loopback-a"` and `"loopback-b"` of users `"a"` and `"b"`. */
  readonly ends?: readonly [LoopbackEnd, LoopbackEnd];
  /** The path the ends say carries them. Default `"direct"`. */
  readonly path?: PeerPath;
  /** Random numbers from 0 to 1, for jitter and loss. Default `Math.random`; pass a seeded one to repeat a run. */
  readonly random?: () => number;
}

const DEFAULT_ENDS: readonly [LoopbackEnd, LoopbackEnd] = [
  { socketId: "loopback-a", userId: "a" },
  { socketId: "loopback-b", userId: "b" },
];

/** One direction of the channel: where it goes, and what it holds on the way. */
interface Way {
  to: LinkCore | undefined;
  readonly queue: LagQueue;
}

/**
 * Two ends of one peer link in this process, `[a, b]`: what `a` sends `b`
 * receives, and back, after `ms` plus up to `jitter` milliseconds, `fast`
 * messages lost with probability `loss`.
 *
 * @example
 * const [host, guest] = createLoopbackPeerLink({ ms: 40, jitter: 10, loss: 0.05 });
 * guest.on("message", (data) => frames.push(data));
 * host.on("open", () => host.send("fast", { tick: 1 }));
 */
export function createLoopbackPeerLink(
  options: LoopbackOptions = {},
): readonly [PeerLink, PeerLink] {
  // Every message waits a task at least: a lag of zeros still holds it.
  const lag = checkLag(options, "createLoopbackPeerLink");
  const random = options.random ?? Math.random;
  const room = options.room ?? "loopback";
  const [endA, endB] = options.ends ?? DEFAULT_ENDS;
  const toB: Way = { to: undefined, queue: createLagQueue(lag, random) };
  const toA: Way = { to: undefined, queue: createLagQueue(lag, random) };

  const coreOf = (other: LoopbackEnd, out: Way, back: Way): LinkCore =>
    createLinkCore({
      room,
      peer: other.socketId,
      maxMessageBytes: () => MAX_PEER_MESSAGE_BYTES,
      hooks: {
        // A `fast` message the channel loses was sent all the same.
        send: (label, text) => {
          out.queue.push(label, () => {
            out.to?.receive(text, label);
          });
          return true;
        },
        closed: (_reason, fromHere) => {
          back.to = undefined;
          if (fromHere) {
            const peer = out.to;
            // As long as a message takes, after the `rel` messages sent ahead of it.
            out.queue.push("rel", () => {
              peer?.end("bye");
            });
          }
        },
      },
    });

  const a = coreOf(endB, toB, toA);
  const b = coreOf(endA, toA, toB);
  toB.to = b;
  toA.to = a;
  a.identify(endB.userId);
  b.identify(endA.userId);
  const path = options.path ?? "direct";
  queueMicrotask(() => {
    a.carry(path);
    b.carry(path);
  });
  return Object.freeze([a.link, b.link] as const);
}
