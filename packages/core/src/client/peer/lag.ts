// The lag a peer link simulates (RFC 0003 section 12.5): `PeerLink.setLag`
// holds each message of the link, both ways, `ms` plus up to `jitter`
// milliseconds, and loses a `fast` one with probability `loss`, so a test or
// a bench plays over a bad network on the real path, and a host can give
// itself its peers' lag. A `LagQueue` holds one direction's messages. A
// `rel` message is never lost and never goes before the one held ahead of
// it, whatever its jitter; one whose path refuses it as it comes due waits,
// with the ones after it, and is tried again after `LAG_RETRY_MS`, doubling
// up to `MAX_RETRY_MS`. A `fast` message goes on its own time. Without a lag
// the queue lets what it holds go on the next task, in the order it was
// pushed. The loopback double of `./testing` carries its messages on the
// same queues.
//
// React-free.

import type { PeerLabel } from "../../protocol/envelope";
import type { PeerLinkLag, PeerLinkLagOptions } from "./types";

/** A held `rel` message its path refused is tried again after this long, doubling up to a second. */
export const LAG_RETRY_MS = 50;

const MAX_RETRY_MS = 1000;

/**
 * `options` as a lag, checked: a `TypeError` that names `owner` for a part
 * that is not a number in range, or a `random` that is not a function.
 */
export function checkLag(options: PeerLinkLagOptions, owner: string): PeerLinkLag {
  const part = (name: "ms" | "jitter" | "loss", max = Number.POSITIVE_INFINITY): number => {
    const value = options[name] ?? 0;
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > max) {
      throw new TypeError(`${owner}: ${name} must be a number from 0${max === 1 ? " to 1" : ""}`);
    }
    return value;
  };
  const lag = Object.freeze({ ms: part("ms"), jitter: part("jitter"), loss: part("loss", 1) });
  if (options.random !== undefined && typeof options.random !== "function") {
    throw new TypeError(`${owner}: random must be a function returning numbers from 0 to 1`);
  }
  return lag;
}

/**
 * Hands a held message on as it comes due. False when its path could not
 * take it: a `rel` message then waits and is tried again, a `fast` one is
 * gone.
 */
export type LagDeliver = () => boolean | void;

/** One direction's messages, held for a lag. */
export interface LagQueue {
  /** No lag and nothing held: a message may go at once, past the queue. */
  readonly idle: boolean;
  /** A held `rel` message waits for its path to take it. */
  readonly blocked: boolean;
  /**
   * Holds a message on `label` and calls `deliver` once it is due. False
   * when the lag lost it (a `fast` message): `deliver` is never called.
   */
  push(label: PeerLabel, deliver: LagDeliver): boolean;
  /**
   * Takes `lag` for the messages pushed from now on; those held keep their
   * time. With `null`, what is held goes on the next task, in order.
   */
  set(lag: PeerLinkLag | null, random?: () => number): void;
  /** Delivers what is held now, in the order it was pushed. */
  flush(): void;
  /** Drops what is held, for good: nothing is delivered after. */
  close(): void;
}

interface Held {
  readonly label: PeerLabel;
  readonly seq: number;
  readonly deliver: LagDeliver;
  /** When it is due, by `performance.now()`, the clock the timers keep. */
  readonly at: number;
  /** Due: its time came, or the time of a `rel` message held after it did. */
  ready: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/** The state one queue keeps. */
interface Queue {
  lag: PeerLinkLag | null;
  random: () => number;
  /** The held `rel` messages, in order. */
  readonly rel: Held[];
  /** The held `fast` messages, in the order they were pushed. */
  readonly fast: Set<Held>;
  seq: number;
  /** The next try of the first `rel` message, which its path refused. */
  retry: ReturnType<typeof setTimeout> | undefined;
  retryMs: number;
  /** The flush on the next task, after `set(null)`. */
  flushing: ReturnType<typeof setTimeout> | undefined;
  /** Handing messages on: a call from a `deliver` hands nothing on. */
  delivering: boolean;
  closed: boolean;
}

/** Hands one message on; one whose `deliver` throws is gone, and its error is thrown on its own. */
function handOn(item: Held): boolean | void {
  try {
    return item.deliver();
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
    return true;
  }
}

/** Hands the first `rel` message on: false when its path refused it, so it waits. */
function deliverRel(queue: Queue, item: Held): boolean {
  if (handOn(item) === false && !queue.closed) {
    queue.retry = setTimeout(() => {
      queue.retry = undefined;
      drain(queue);
    }, queue.retryMs);
    queue.retryMs = Math.min(MAX_RETRY_MS, queue.retryMs * 2);
    return false;
  }
  queue.retryMs = LAG_RETRY_MS;
  if (queue.rel[0] === item) {
    queue.rel.shift();
    clearTimeout(item.timer);
  }
  return true;
}

function deliverFast(queue: Queue, item: Held): void {
  if (queue.fast.delete(item)) {
    clearTimeout(item.timer);
    handOn(item);
  }
}

/** Hands on the `rel` messages that are due, in order, up to one that waits for its path. */
function drain(queue: Queue): void {
  if (queue.delivering || queue.retry !== undefined) {
    return;
  }
  queue.delivering = true;
  try {
    for (let item = queue.rel[0]; item?.ready === true; item = queue.rel[0]) {
      if (queue.closed || !deliverRel(queue, item)) {
        return;
      }
    }
  } finally {
    queue.delivering = false;
  }
}

/** A `rel` message's time came: each one ahead of it is due too. */
function due(queue: Queue, item: Held): void {
  item.timer = undefined;
  const at = queue.rel.indexOf(item);
  for (const ahead of queue.rel.slice(0, at + 1)) {
    ahead.ready = true;
  }
  drain(queue);
}

/**
 * Hands the message on once its time came, by `performance.now()`: a timer
 * may fire a little early by the event loop's clock.
 */
function arm(queue: Queue, item: Held): void {
  item.timer = setTimeout(
    () => {
      if (item.at > performance.now()) {
        arm(queue, item);
      } else if (item.label === "rel") {
        due(queue, item);
      } else {
        deliverFast(queue, item);
      }
    },
    Math.max(0, Math.ceil(item.at - performance.now())),
  );
}

/** The next message to flush, in the order they were pushed: `rel` ones up to one that waits. */
function nextHeld(queue: Queue): Held | undefined {
  const [first] = queue.fast;
  const rel = queue.retry === undefined ? queue.rel[0] : undefined;
  return rel !== undefined && (first === undefined || rel.seq < first.seq) ? rel : first;
}

function flush(queue: Queue): void {
  clearTimeout(queue.flushing);
  queue.flushing = undefined;
  if (queue.delivering) {
    return;
  }
  // What is held now; what a `deliver` pushes waits for its time.
  const until = queue.seq;
  for (const item of queue.rel) {
    item.ready = true;
  }
  queue.delivering = true;
  try {
    for (let item = nextHeld(queue); item !== undefined; item = nextHeld(queue)) {
      if (queue.closed || item.seq >= until) {
        return;
      }
      if (item.label === "rel") {
        deliverRel(queue, item);
      } else {
        deliverFast(queue, item);
      }
    }
  } finally {
    queue.delivering = false;
  }
}

function push(queue: Queue, label: PeerLabel, deliver: LagDeliver): boolean {
  const { lag } = queue;
  if (queue.closed) {
    return true;
  }
  if (lag !== null && label === "fast" && queue.random() < lag.loss) {
    return false;
  }
  let at = performance.now();
  if (lag !== null) {
    at += lag.ms + queue.random() * lag.jitter;
  }
  if (label === "rel") {
    // Due no sooner than the `rel` message held ahead of it.
    at = Math.max(at, queue.rel.at(-1)?.at ?? at);
  }
  const item: Held = { label, seq: queue.seq, deliver, at, ready: false, timer: undefined };
  queue.seq += 1;
  if (label === "rel") {
    queue.rel.push(item);
  } else {
    queue.fast.add(item);
  }
  arm(queue, item);
  return true;
}

function close(queue: Queue): void {
  queue.closed = true;
  for (const item of [...queue.rel, ...queue.fast]) {
    clearTimeout(item.timer);
  }
  queue.rel.length = 0;
  queue.fast.clear();
  clearTimeout(queue.retry);
  clearTimeout(queue.flushing);
  queue.retry = undefined;
  queue.flushing = undefined;
}

/** A queue that holds messages for `lag` (`null`: none), drawing jitter and loss from `random`. */
export function createLagQueue(
  lag: PeerLinkLag | null,
  random: () => number = Math.random,
): LagQueue {
  const queue: Queue = {
    lag,
    random,
    rel: [],
    fast: new Set(),
    seq: 0,
    retry: undefined,
    retryMs: LAG_RETRY_MS,
    flushing: undefined,
    delivering: false,
    closed: false,
  };
  return Object.freeze({
    get idle() {
      return queue.lag === null && queue.rel.length === 0 && queue.fast.size === 0;
    },
    get blocked() {
      return queue.retry !== undefined;
    },
    push: (label: PeerLabel, deliver: LagDeliver) => push(queue, label, deliver),
    set(next: PeerLinkLag | null, nextRandom: () => number = Math.random): void {
      if (queue.closed) {
        return;
      }
      queue.lag = next;
      queue.random = nextRandom;
      if (next === null && (queue.rel.length > 0 || queue.fast.size > 0)) {
        queue.flushing ??= setTimeout(() => {
          flush(queue);
        }, 0);
      }
    },
    flush: () => {
      flush(queue);
    },
    close: () => {
      close(queue);
    },
  });
}
