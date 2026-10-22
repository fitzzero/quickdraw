// A peer link in one process, for tests and benches (RFC 0003 section
// 12.5): `createLoopbackPeerLink(options)` returns its two ends, each a
// `PeerLink` that behaves as `createPeerLink`'s does (its events, stats,
// clock pings and watchdog, and `send`'s limits), joined by an in-process
// channel instead of WebRTC or the relay. Every message takes `ms` plus up
// to `jitter` milliseconds; a `fast` message is lost with probability
// `loss`; `rel` messages always arrive, in the order they were sent. Both
// ends open a microtask after they are made; closing one closes the other,
// with `bye`, once a message would have reached it.

import { createLinkCore, type LinkCore } from "../client/peer/core";
import type { PeerLink, PeerPath } from "../client/peer/types";
import type { PeerLabel } from "../protocol/envelope";
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

/** One direction of the channel: where it goes, and when its last `rel` message lands. */
interface Way {
  to: LinkCore | undefined;
  relAt: number;
}

function check(value: number, name: string, max = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(value) || value < 0 || value > max) {
    throw new TypeError(
      `createLoopbackPeerLink: ${name} must be a number from 0${max === 1 ? " to 1" : ""}`,
    );
  }
  return value;
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
  const ms = check(options.ms ?? 0, "ms");
  const jitter = check(options.jitter ?? 0, "jitter");
  const loss = check(options.loss ?? 0, "loss", 1);
  const random = options.random ?? Math.random;
  const room = options.room ?? "loopback";
  const [endA, endB] = options.ends ?? DEFAULT_ENDS;
  const toB: Way = { to: undefined, relAt: 0 };
  const toA: Way = { to: undefined, relAt: 0 };

  const deliver = (way: Way, label: PeerLabel, text: string): boolean => {
    if (label === "fast" && random() < loss) {
      return true;
    }
    const due = performance.now() + ms + random() * jitter;
    // `rel` keeps its order: never before the message sent ahead of it.
    const at = label === "rel" ? (way.relAt = Math.max(way.relAt, due)) : due;
    setTimeout(
      () => {
        way.to?.receive(text, label);
      },
      Math.max(0, at - performance.now()),
    );
    return true;
  };

  const coreOf = (other: LoopbackEnd, out: Way, back: Way): LinkCore =>
    createLinkCore({
      room,
      peer: other.socketId,
      maxMessageBytes: () => MAX_PEER_MESSAGE_BYTES,
      hooks: {
        send: (label, text) => deliver(out, label, text),
        closed: (_reason, fromHere) => {
          back.to = undefined;
          if (fromHere) {
            const peer = out.to;
            setTimeout(() => {
              peer?.end("bye");
            }, ms);
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
