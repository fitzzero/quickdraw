// `createPeerLink(connection, options)` (RFC 0003 section 12.5): a link to
// another socket of an app room, `options.to`, whose id the app learned (a
// method's answer, `onPeerRequest`, the room's host). One side offers;
// when both do (each learned of the other at once), the side whose socket
// id sorts after the other's answers instead. The link starts once the
// connection has a hello naming the `"peer"` feature (`unsupported`
// otherwise), then:
//
// - the offerer tries the direct path (`rtc.ts`) when the platform has
//   WebRTC and `relay` is not `"always"`, and says `{ relay: true }`
//   instead when it may not; the answerer answers an offer the same way;
// - a direct path that fails (ICE failed, nothing open within
//   `DIRECT_TIMEOUT_MS`, a path that dropped) gives way to the relay,
//   unless `relay` is `"never"`: this side says `{ relay: true }`, the peer
//   moves too and says it back, and the relay carries the link once both
//   said it. A link open on the direct path moves at once: each side reads
//   both paths all along;
// - nothing open within `OPEN_TIMEOUT_MS`: `timeout`.
//
// Closing from this side signals `bye`, on which the peer's link closes; a
// link the peer, the server or the socket ended (`bye`, `left`,
// `disconnected`) sends nothing.
//
// React-free.

import type {
  PeerCandidate,
  PeerDescription,
  PeerLabel,
  PeerSignal,
} from "../../protocol/envelope";
import { isRoomName, isSocketId } from "../../protocol/peer";
import type { HelloPeerLimits } from "../../protocol/version";
import type { QuickdrawConnection } from "../connection";
import { createLinkCore, type LinkCore } from "./core";
import { hubOf, type Bucket, type IncomingPeer, type PeerHub } from "./hub";
import {
  createDirectPath,
  type DirectPath,
  type PeerConnectionConfig,
  type PeerIceServer,
  type RtcConnection,
} from "./rtc";
import type { PeerLink } from "./types";

/**
 * When a link uses the server's relay: `auto` when the direct path cannot
 * form or fails, `always` instead of it (no WebRTC at all), `never` (a link
 * whose direct path fails closes).
 */
export type RelayMode = "auto" | "always" | "never";

/** Options of {@link createPeerLink}. */
export interface PeerLinkOptions {
  /** The app room both sockets are in; the link belongs to it, and ends when this socket leaves it. */
  readonly room: string;
  /** The peer's socket id. */
  readonly to: string;
  /**
   * Whether this side makes the offer. One side of a link does; when both
   * do, the side whose socket id sorts after the other's answers instead.
   */
  readonly offerer: boolean;
  /**
   * STUN and TURN servers. Default Google's and Cloudflare's public STUN
   * servers, and no TURN: a pair that cannot reach each other uses the
   * relay, which is expected, not an error.
   */
  readonly iceServers?: readonly PeerIceServer[];
  /** When the link may use the server's relay. Default `"auto"`. */
  readonly relay?: RelayMode;
  /**
   * Makes the link's `RTCPeerConnection`. Default the platform's
   * `RTCPeerConnection` when it has one; React Native passes
   * react-native-webrtc's, Node a WebRTC package's. A link without one uses
   * the relay.
   */
  readonly peerConnection?: (configuration: PeerConnectionConfig) => unknown;
}

/** The STUN servers a link asks by default. */
export const DEFAULT_ICE_SERVERS: readonly PeerIceServer[] = Object.freeze([
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun.cloudflare.com:3478" },
]);

/** A link that opens on no path within this long closes as `timeout`. */
export const OPEN_TIMEOUT_MS = 15_000;

/** A direct path not open within this long gives way to the relay. */
export const DIRECT_TIMEOUT_MS = 5000;

type Factory = (configuration: PeerConnectionConfig) => unknown;

/** What one link keeps besides its core. */
interface Run {
  readonly hub: PeerHub;
  readonly room: string;
  readonly peer: string;
  /** This side offers; it stops when both offered and it yields. */
  offerer: boolean;
  readonly relay: RelayMode;
  readonly factory: Factory | undefined;
  readonly iceServers: PeerIceServer[];
  readonly core: LinkCore;
  pair: Bucket;
  started: boolean;
  /** Signals that arrived before the link started, in order. */
  readonly queued: [PeerSignal, string][];
  /** The peer's candidates that came before the direct path was made. */
  readonly early: PeerCandidate[];
  /** The peer offered: it does so once a link. */
  heardOffer: boolean;
  direct: DirectPath | undefined;
  relaySent: boolean;
  relayHeard: boolean;
  openTimer: ReturnType<typeof setTimeout> | undefined;
  directTimer: ReturnType<typeof setTimeout> | undefined;
  /** Signals waiting out a `RATE_LIMITED` answer, cleared when the link closes. */
  readonly retries: Set<ReturnType<typeof setTimeout>>;
  remove: () => void;
}

/** The platform's `RTCPeerConnection`, as a factory; `undefined` where there is none (Node). */
function platformFactory(): Factory | undefined {
  const Rtc = (
    globalThis as { RTCPeerConnection?: new (configuration: PeerConnectionConfig) => unknown }
  ).RTCPeerConnection;
  return Rtc === undefined ? undefined : (configuration) => new Rtc(configuration);
}

function canDirect(run: Run): boolean {
  return run.relay !== "always" && run.factory !== undefined;
}

/** How long a rate-limited signal waits before it is sent again: the server's wait, within the open timeout. */
function retryDelay(data: unknown): number {
  const wait = (data as { readonly retryAfterMs?: unknown } | undefined)?.retryAfterMs;
  return typeof wait === "number" && wait > 0 ? Math.min(wait, OPEN_TIMEOUT_MS) : 100;
}

/**
 * Sends a signal; a refusal closes the link, but for a candidate (one lost
 * candidate is no loss). A rate-limited signal is sent again, at most three
 * times, unless the link closed meanwhile.
 */
function signal(run: Run, sig: PeerSignal, attempt = 0): void {
  void run.hub.signal(run.room, run.peer, sig).then((answer) => {
    if (answer.ok || run.core.link.state === "closed" || sig.ice !== undefined) {
      return;
    }
    const { code, data } = answer.e;
    if (code === "RATE_LIMITED" && attempt < 3) {
      const retry = setTimeout(() => {
        run.retries.delete(retry);
        signal(run, sig, attempt + 1);
      }, retryDelay(data));
      run.retries.add(retry);
    } else if (code !== "TIMEOUT") {
      run.core.fail("refused");
    }
  });
}

function closeDirect(run: Run): void {
  clearTimeout(run.directTimer);
  run.direct?.close();
  run.direct = undefined;
}

/** Moves the link to the relay, saying so once; it carries the link once both sides said it. */
function moveToRelay(run: Run): void {
  if (run.relay === "never") {
    run.core.fail("failed");
    return;
  }
  closeDirect(run);
  if (!run.relaySent) {
    run.relaySent = true;
    signal(run, { relay: true });
  }
  if (run.relayHeard || run.core.link.state === "open") {
    run.core.carry("relay");
  }
}

function directFailed(run: Run): void {
  if (run.relay === "never") {
    run.core.fail(run.core.link.state === "open" ? "lost" : "failed");
  } else {
    moveToRelay(run);
  }
}

/** Starts the direct path, or `undefined` when the factory throws. */
function openDirect(run: Run, factory: Factory): DirectPath | undefined {
  let rtc: RtcConnection;
  try {
    rtc = factory({ iceServers: run.iceServers }) as RtcConnection;
  } catch {
    return undefined;
  }
  const direct = createDirectPath(rtc, {
    signal: (sig) => {
      signal(run, sig);
    },
    opened: () => {
      clearTimeout(run.directTimer);
      run.core.carry("direct");
    },
    failed: () => {
      if (run.direct === direct) {
        run.direct = undefined;
        directFailed(run);
      }
    },
    message: (data, label) => {
      run.core.receive(data, label);
    },
  });
  run.direct = direct;
  for (const ice of run.early.splice(0)) {
    direct.candidate(ice);
  }
  if (run.relay !== "never") {
    run.directTimer = setTimeout(() => {
      if (run.direct === direct && !direct.open) {
        directFailed(run);
      }
    }, DIRECT_TIMEOUT_MS);
  }
  return direct;
}

/**
 * Whether this side, an offerer the peer sent an offer, answers it instead:
 * both sides offered, each having learned of the other at once, and the
 * side whose socket id sorts after the other's yields. The other ignores
 * the offer and waits for the answer. A side that said `{ relay: true }`
 * yields to nothing: the peer moves to the relay when it hears it.
 */
function yields(run: Run): boolean {
  const self = run.hub.connection.socket.id;
  return !run.relaySent && self !== undefined && self > run.peer;
}

/** The peer's session description: an answer to the offer, or an offer to answer. */
function described(run: Run, sdp: PeerDescription): void {
  if (sdp.type === "answer") {
    if (run.offerer) {
      run.direct?.accept(sdp);
    }
    return;
  }
  if (run.offerer) {
    if (!yields(run)) {
      return;
    }
    closeDirect(run);
    run.offerer = false;
    run.heardOffer = true;
  }
  if (run.relaySent || run.direct !== undefined) {
    return;
  }
  const direct =
    canDirect(run) && run.factory !== undefined ? openDirect(run, run.factory) : undefined;
  if (direct === undefined) {
    moveToRelay(run);
  } else {
    direct.answer(sdp);
  }
}

/** Candidates kept for a direct path not made yet. */
const MAX_EARLY_CANDIDATES = 64;

/**
 * Whether `sig` opens a new link rather than continuing this one: the peer
 * offers once a link and says `{ relay: true }` once, and never offers
 * after it, so a second offer, a second `{ relay: true }` or an offer after
 * it means this side missed the bye of the peer's last link.
 */
function restarts(run: Run, sig: PeerSignal): boolean {
  if (run.offerer) {
    return false;
  }
  if (sig.relay === true) {
    return run.relayHeard;
  }
  if (sig.sdp?.type !== "offer") {
    return false;
  }
  const again = run.heardOffer || run.relayHeard;
  run.heardOffer = true;
  return again;
}

/** A signal from the peer; false when it opens a new link, so this one ended and the hub takes it. */
function onSignal(run: Run, sig: PeerSignal, userId: string): boolean {
  if (!run.started) {
    run.queued.push([sig, userId]);
    return true;
  }
  if (restarts(run, sig)) {
    run.core.end("bye");
    return false;
  }
  if (userId !== "") {
    run.core.identify(userId);
  }
  if (sig.bye === true) {
    run.core.end("bye");
  } else if (sig.relay === true) {
    run.relayHeard = true;
    moveToRelay(run);
  } else if (sig.sdp !== undefined) {
    described(run, sig.sdp);
  } else if (sig.ice !== undefined) {
    if (run.direct !== undefined) {
      run.direct.candidate(sig.ice);
    } else if (!run.relaySent && run.early.length < MAX_EARLY_CANDIDATES) {
      run.early.push(sig.ice);
    }
  }
  return true;
}

/** The connection said hello: start, with what waited for the link. */
function start(run: Run, limits: HelloPeerLimits | undefined): void {
  if (run.core.link.state === "closed") {
    return;
  }
  if (limits === undefined || (!canDirect(run) && run.relay === "never")) {
    run.core.fail("unsupported");
    return;
  }
  run.started = true;
  run.pair = run.hub.pairBucket();
  run.openTimer = setTimeout(() => {
    if (run.core.link.state === "connecting") {
      run.core.fail("timeout");
    }
  }, OPEN_TIMEOUT_MS);
  const waiting = run.hub.take(run.room, run.peer);
  if (run.offerer) {
    const direct =
      canDirect(run) && run.factory !== undefined ? openDirect(run, run.factory) : undefined;
    if (direct === undefined) {
      moveToRelay(run);
    } else {
      direct.offer();
    }
  }
  for (const [sig, userId] of [
    ...waiting.signals.map((waited) => [waited, waiting.userId] as const),
    ...run.queued.splice(0),
  ]) {
    if (!onSignal(run, sig, userId)) {
      return;
    }
  }
}

function sendOn(run: Run, label: PeerLabel, text: string): boolean {
  if (run.direct?.open === true) {
    return run.direct.send(label, text);
  }
  return run.relaySent && run.hub.relay(run.room, run.peer, label, text, run.pair);
}

function closed(run: Run, fromHere: boolean): void {
  clearTimeout(run.openTimer);
  for (const retry of run.retries) {
    clearTimeout(retry);
  }
  run.retries.clear();
  closeDirect(run);
  run.remove();
  // Signals the server took hold a place for the pair there, a refused link's
  // too: the bye frees it. A link that never started sent none.
  if (fromHere && run.started) {
    void run.hub.signal(run.room, run.peer, { bye: true });
  }
}

const RELAY_MODES: readonly string[] = ["auto", "always", "never"];

function checkOptions(options: PeerLinkOptions): void {
  if (!isRoomName(options.room)) {
    throw new TypeError("createPeerLink: room must name an app room, of 1 to 256 characters");
  }
  if (!isSocketId(options.to)) {
    throw new TypeError("createPeerLink: to must be the peer's socket id");
  }
  if (typeof options.offerer !== "boolean") {
    throw new TypeError(
      "createPeerLink: offerer must be true on the side that offers, false on the other",
    );
  }
  if (options.relay !== undefined && !RELAY_MODES.includes(options.relay)) {
    throw new TypeError('createPeerLink: relay must be "auto", "always" or "never"');
  }
  if (options.peerConnection !== undefined && typeof options.peerConnection !== "function") {
    throw new TypeError("createPeerLink: peerConnection must make an RTCPeerConnection");
  }
}

/**
 * Opens a link to socket `options.to` in app room `options.room`, over
 * WebRTC data channels when it can and the server's relay when it cannot.
 * The server must serve peer links (`createServer({ peers: true })`), and
 * both sockets must be in the room. Throws a `TypeError` for bad options,
 * or when the connection has a link to that peer in that room already.
 *
 * @example
 * const link = createPeerLink(connection, { room: "match:7", to: rivalSocketId, offerer: true });
 * link.on("message", (data, label) => applyRemote(data));
 * link.on("open", () => link.send("rel", { hello: "rival" }));
 */
export function createPeerLink(
  connection: QuickdrawConnection,
  options: PeerLinkOptions,
): PeerLink {
  checkOptions(options);
  const hub = hubOf(connection);
  const run: Run = {
    hub,
    room: options.room,
    peer: options.to,
    offerer: options.offerer,
    relay: options.relay ?? "auto",
    factory: options.peerConnection ?? platformFactory(),
    iceServers: (options.iceServers ?? DEFAULT_ICE_SERVERS).map((server) => ({ ...server })),
    core: createLinkCore({
      room: options.room,
      peer: options.to,
      maxMessageBytes: () => hub.limits().maxMessageBytes,
      hooks: {
        send: (label, text) => sendOn(run, label, text),
        closed: (_reason, fromHere) => {
          closed(run, fromHere);
        },
      },
    }),
    pair: hub.pairBucket(),
    started: false,
    queued: [],
    early: [],
    heardOffer: false,
    direct: undefined,
    relaySent: false,
    relayHeard: false,
    openTimer: undefined,
    directTimer: undefined,
    retries: new Set(),
    remove: () => undefined,
  };
  run.remove = hub.add(run.room, run.peer, {
    signal: (sig, userId) => onSignal(run, sig, userId),
    relay: (label, text) => {
      run.core.receive(text, label);
    },
    disconnected: () => {
      run.core.end("disconnected");
    },
    left: () => {
      run.core.end("left");
    },
  });
  hub.whenReady(
    (limits) => {
      start(run, limits);
    },
    () => {
      run.core.end("disconnected");
    },
  );
  return run.core.link;
}

/** A socket of the room signalled this one with no link to it: a link it asks for. */
export interface PeerRequest {
  readonly room: string;
  /** The peer's socket id. */
  readonly from: string;
  /** The peer's user, as the server named it. */
  readonly userId: string;
  /** Answers with a link: `createPeerLink(connection, { room, to: from, offerer: false, ...options })`. */
  accept(options?: Omit<PeerLinkOptions, "room" | "to" | "offerer">): PeerLink;
  /** Refuses: the peer's link closes, with `bye`. */
  reject(): void;
}

/**
 * Calls `listener` when a socket of an app room this connection's socket is
 * in signals it with no link to it yet: answer with `request.accept()` (or
 * `createPeerLink` with `offerer: false`) within 15 seconds, or
 * `request.reject()`. Returns its removal.
 */
export function onPeerRequest(
  connection: QuickdrawConnection,
  listener: (request: PeerRequest) => void,
): () => void {
  const hub = hubOf(connection);
  return hub.requests((incoming: IncomingPeer) => {
    listener(
      Object.freeze({
        ...incoming,
        accept: (options = {}) =>
          createPeerLink(connection, {
            ...options,
            room: incoming.room,
            to: incoming.from,
            offerer: false,
          }),
        reject: () => {
          hub.forget(incoming.room, incoming.from);
          void hub.signal(incoming.room, incoming.from, { bye: true });
        },
      }),
    );
  });
}
