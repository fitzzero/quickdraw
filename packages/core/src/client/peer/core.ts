// What every peer link does whatever carries it (RFC 0003 section 12.5): its
// state and events, its stats, the clock pings and the watchdog. Once open,
// a link pings on `fast` (`QUICK_PINGS` pings `QUICK_PING_MS` apart, then
// one every `PING_MS`) and answers the peer's pings, so the two clocks sync
// and each side hears the other at least that often: a link that hears
// nothing for `WATCHDOG_MS` closes as `lost`. `createPeerLink` drives a core
// from signals and paths (`link.ts`); the loopback double of `./testing`
// drives two from an in-process pair, and host mode's in-process link
// (`../host/local.ts`) two more. Host mode's messages travel beside the
// app's, apart from them: `controlOf(link)` sends and hears them, and a
// link's `send` and `message` event never do. `setLag` holds every message
// on its way out and in (`lag.ts`), the pings and host mode's included.
//
// React-free.

import type { HostMessage, PeerLabel, PeerMessage } from "../../protocol/envelope";
import { createClock, type ClockState, type PeerClock } from "./clock";
import { decodeMessage, encodeMessage, messageBytes } from "./codec";
import { checkLag, createLagQueue, type LagQueue } from "./lag";
import type {
  PeerCloseReason,
  PeerLink,
  PeerLinkEvents,
  PeerLinkLag,
  PeerLinkLagOptions,
  PeerLinkState,
  PeerLinkStats,
  PeerPath,
} from "./types";

/** Clock pings a link sends `QUICK_PING_MS` apart as it opens, so its clock syncs at once. */
export const QUICK_PINGS = 6;

/** The time between the clock pings a link sends as it opens. */
export const QUICK_PING_MS = 80;

/** The time between the clock pings of an open link, after its first ones. */
export const PING_MS = 500;

/** A link that hears nothing from its peer for this long closes as `lost`. */
export const WATCHDOG_MS = 8000;

/** What carries a core's messages, and what the core tells its owner. */
export interface CoreHooks {
  /** Sends one message's text on `label`; false when it was dropped. */
  send(label: PeerLabel, text: string): boolean;
  /**
   * The link closed, once: take its paths down. `fromHere` when this side
   * closed it (`close()`, the watchdog, `fail`), so the peer must be told.
   */
  closed(reason: PeerCloseReason, fromHere: boolean): void;
}

/** What a core is made from. */
export interface CoreOptions {
  readonly room: string;
  readonly peer: string;
  readonly hooks: CoreHooks;
  /** The longest message's text, in UTF-8 bytes: the server's `limits.peers.maxMessageBytes`. */
  readonly maxMessageBytes: () => number;
  /** This side's clock, in milliseconds. Default `performance.now()`. */
  readonly now?: () => number;
}

/** A link, and how its owner drives it. */
export interface LinkCore {
  readonly link: PeerLink;
  /** A message from the peer, on `label`, from either path. */
  receive(data: unknown, label: PeerLabel): void;
  /** A path carries the link: it opens, or moves to that path. */
  carry(path: PeerPath): void;
  /** The link ended from outside (the peer's bye, the socket's disconnect): nothing is sent. */
  end(reason: PeerCloseReason): void;
  /** This side ends the link for `reason` (a timeout, a failed path): the owner tells the peer. */
  fail(reason: PeerCloseReason): void;
  /** The peer's user, as the server named it in the peer's first signal. */
  identify(userId: string): void;
}

/** Throws `error` on its own, after the caller went on: one failing listener stops no other. */
export function throwLater(error: unknown): void {
  queueMicrotask(() => {
    throw error;
  });
}

type Listeners = { readonly [E in keyof PeerLinkEvents]: Set<PeerLinkEvents[E]> };

/** The state one core keeps. */
interface Core {
  readonly options: CoreOptions;
  readonly now: () => number;
  readonly clock: ClockState;
  readonly listeners: Listeners;
  state: PeerLinkState;
  path: PeerPath | undefined;
  closeReason: PeerCloseReason | undefined;
  userId: string | undefined;
  lastHeard: number;
  pingsLeft: number;
  timer: ReturnType<typeof setTimeout> | undefined;
  readonly stats: { sent: number; received: number; dropped: number; simulatedLoss: number };
  /** Who hears host mode's messages (`controlOf`). */
  readonly control: Set<(message: HostMessage, label: PeerLabel) => void>;
  /** The lag `setLag` set; `null` for none. */
  lag: PeerLinkLag | null;
  /** This side's messages on their way out, held for the lag. */
  readonly outgoing: LagQueue;
  /** The peer's messages on their way in, held for the lag. */
  readonly incoming: LagQueue;
}

/** Calls each listener of `event`; one that throws is reported apart, and the others still run. */
function emit<E extends keyof PeerLinkEvents>(
  core: Core,
  event: E,
  ...args: Parameters<PeerLinkEvents[E]>
): void {
  for (const listener of [...core.listeners[event]]) {
    try {
      (listener as (...values: Parameters<PeerLinkEvents[E]>) => void)(...args);
    } catch (error) {
      throwLater(error);
    }
  }
}

function finish(core: Core, reason: PeerCloseReason, fromHere: boolean): void {
  if (core.state === "closed") {
    return;
  }
  core.state = "closed";
  core.path = undefined;
  core.closeReason = reason;
  clearTimeout(core.timer);
  core.outgoing.close();
  core.incoming.close();
  core.options.hooks.closed(reason, fromHere);
  emit(core, "state", "closed", undefined);
  emit(core, "close", reason);
  for (const set of Object.values(core.listeners) as Set<unknown>[]) {
    set.clear();
  }
  core.control.clear();
}

/** A ping, then the next one: the watchdog's beat too. */
function tick(core: Core): void {
  core.timer = undefined;
  if (core.state !== "open") {
    return;
  }
  if (core.now() - core.lastHeard > WATCHDOG_MS) {
    finish(core, "lost", true);
    return;
  }
  transmit(core, "fast", encodeMessage([1, core.now()]), false);
  core.pingsLeft = Math.max(0, core.pingsLeft - 1);
  core.timer = setTimeout(
    () => {
      tick(core);
    },
    core.pingsLeft > 0 ? QUICK_PING_MS : PING_MS,
  );
}

/** A message's text, checked against the size limit: a `RangeError` over it. */
function textOf(core: Core, message: Parameters<typeof encodeMessage>[0], what: string): string {
  const text = encodeMessage(message);
  const bytes = messageBytes(text);
  const max = core.options.maxMessageBytes();
  if (bytes > max) {
    throw new RangeError(
      `${what}: a message holds at most ${max} bytes as JSON; this one has ${bytes}: split it`,
    );
  }
  return text;
}

/**
 * Sends one message's text on `label`, on the path at once, or once the lag
 * held it (which may lose a `fast` one). False when it was dropped: the path
 * refused it, or a held `rel` message waits for the path. An app message
 * (`app`) counts in `stats`: `sent` once a path took it, `dropped` for one
 * dropped, `simulatedLoss` for one the lag lost.
 */
function transmit(core: Core, label: PeerLabel, text: string, app: boolean): boolean {
  const { stats, outgoing } = core;
  const put = (): boolean => {
    const sent = core.state === "open" && core.options.hooks.send(label, text);
    if (app && sent) {
      stats.sent += 1;
    }
    return sent;
  };
  if (outgoing.idle) {
    const sent = put();
    if (app && !sent) {
      stats.dropped += 1;
    }
    return sent;
  }
  if (label === "rel" && outgoing.blocked) {
    if (app) {
      stats.dropped += 1;
    }
    return false;
  }
  const held = outgoing.push(label, () => {
    const sent = put();
    // A `rel` message the path refused waits and goes again: not dropped.
    if (app && !sent && label === "fast") {
      stats.dropped += 1;
    }
    return sent;
  });
  if (app && !held) {
    stats.simulatedLoss += 1;
  }
  return true;
}

function send(core: Core, label: PeerLabel, data: unknown): boolean {
  if (label !== "rel" && label !== "fast") {
    throw new TypeError(`PeerLink.send: label must be "rel" or "fast", not ${String(label)}`);
  }
  const text = textOf(core, [0, data], "PeerLink.send");
  if (core.state !== "open") {
    core.stats.dropped += 1;
    return false;
  }
  return transmit(core, label, text, true);
}

/** A message from the peer, once the lag held it (at once without one). */
function hear(core: Core, message: PeerMessage, label: PeerLabel): void {
  if (core.state === "closed") {
    return;
  }
  core.lastHeard = core.now();
  if (message[0] === 0) {
    core.stats.received += 1;
    emit(core, "message", message[1], label);
  } else if (message[0] === 1) {
    if (core.state === "open") {
      transmit(core, "fast", encodeMessage([2, message[1], core.now()]), false);
    }
  } else if (message[0] === 2) {
    core.clock.pong(message[1], message[2], core.now());
  } else {
    for (const listener of [...core.control]) {
      try {
        listener(message, label);
      } catch (error) {
        throwLater(error);
      }
    }
  }
}

function receive(core: Core, data: unknown, label: PeerLabel): void {
  const message = core.state === "closed" ? undefined : decodeMessage(data);
  if (message === undefined) {
    return;
  }
  if (core.incoming.idle) {
    hear(core, message, label);
    return;
  }
  const held = core.incoming.push(label, () => {
    hear(core, message, label);
  });
  if (!held && message[0] === 0) {
    core.stats.simulatedLoss += 1;
  }
}

function setLag(core: Core, options: PeerLinkLagOptions | null): void {
  if (options !== null && typeof options !== "object") {
    throw new TypeError("PeerLink.setLag: pass { ms, jitter, loss }, or null for none");
  }
  const lag = options === null ? null : checkLag(options, "PeerLink.setLag");
  if (core.state === "closed") {
    return;
  }
  core.lag = lag === null || (lag.ms === 0 && lag.jitter === 0 && lag.loss === 0) ? null : lag;
  const random = options?.random ?? Math.random;
  core.outgoing.set(core.lag, random);
  core.incoming.set(core.lag, random);
}

function carry(core: Core, path: PeerPath): void {
  if (core.state === "closed" || (core.state === "open" && core.path === path)) {
    return;
  }
  const opening = core.state === "connecting";
  core.state = "open";
  core.path = path;
  if (opening) {
    core.lastHeard = core.now();
    core.pingsLeft = QUICK_PINGS;
    emit(core, "open", path);
  }
  emit(core, "state", "open", path);
  if (opening && core.state === "open") {
    tick(core);
  }
}

/** The clock as a link shows it: read-only. */
function clockView(clock: PeerClock): PeerClock {
  return Object.freeze({
    now: () => clock.now(),
    get offset() {
      return clock.offset;
    },
    get rtt() {
      return clock.rtt;
    },
    get jitter() {
      return clock.jitter;
    },
    get synced() {
      return clock.synced;
    },
  });
}

/** The link the app holds. */
function linkOf(core: Core): PeerLink {
  const { listeners } = core;
  return Object.freeze({
    room: core.options.room,
    peer: core.options.peer,
    get userId() {
      return core.userId;
    },
    get state() {
      return core.state;
    },
    get path() {
      return core.path;
    },
    get closeReason() {
      return core.closeReason;
    },
    send: (label: PeerLabel, data: unknown) => send(core, label, data),
    on<E extends keyof PeerLinkEvents>(event: E, listener: PeerLinkEvents[E]): () => void {
      if (!Object.hasOwn(listeners, event)) {
        throw new TypeError(`PeerLink.on: no event "${String(event)}"`);
      }
      listeners[event].add(listener);
      return () => {
        listeners[event].delete(listener);
      };
    },
    clock: clockView(core.clock),
    get stats(): PeerLinkStats {
      return Object.freeze({ ...core.stats });
    },
    setLag: (options: PeerLinkLagOptions | null) => {
      setLag(core, options);
    },
    get lag() {
      return core.lag;
    },
    close: () => {
      finish(core, "closed", true);
    },
  });
}

/** Creates a link's core, connecting. */
const CORES = new WeakMap<PeerLink, Core>();

/** What host mode reaches of a link: its own messages, kept apart from the app's. */
export interface LinkControl {
  /**
   * Sends a host mode message; false when the link is not open or its path
   * dropped it. A `RangeError` for one over the message limit.
   */
  send(label: PeerLabel, message: HostMessage): boolean;
  /** Calls `listener` for each host mode message from the peer; returns its removal. */
  on(listener: (message: HostMessage, label: PeerLabel) => void): () => void;
}

/** The host mode side of a link made by `createPeerLink` or the loopback double; `undefined` for any other object. */
export function controlOf(link: PeerLink): LinkControl | undefined {
  const core = CORES.get(link);
  if (core === undefined) {
    return undefined;
  }
  return {
    send: (label, message) =>
      core.state === "open" && transmit(core, label, textOf(core, message, "host mode"), false),
    on(listener) {
      if (core.state === "closed") {
        return () => undefined;
      }
      core.control.add(listener);
      return () => {
        core.control.delete(listener);
      };
    },
  };
}

export function createLinkCore(options: CoreOptions): LinkCore {
  const now = options.now ?? (() => performance.now());
  const core: Core = {
    options,
    now,
    clock: createClock(now),
    listeners: { message: new Set(), open: new Set(), state: new Set(), close: new Set() },
    state: "connecting",
    path: undefined,
    closeReason: undefined,
    userId: undefined,
    lastHeard: 0,
    pingsLeft: 0,
    timer: undefined,
    stats: { sent: 0, received: 0, dropped: 0, simulatedLoss: 0 },
    control: new Set(),
    lag: null,
    outgoing: createLagQueue(null, Math.random, now),
    incoming: createLagQueue(null, Math.random, now),
  };
  const link = linkOf(core);
  CORES.set(link, core);
  return {
    link,
    receive: (data, label) => {
      receive(core, data, label);
    },
    carry: (path) => {
      carry(core, path);
    },
    end: (reason) => {
      finish(core, reason, false);
    },
    fail: (reason) => {
      finish(core, reason, true);
    },
    identify: (userId) => {
      core.userId ??= userId;
    },
  };
}
