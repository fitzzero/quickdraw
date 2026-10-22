// The direct path of a peer link (RFC 0003 section 12.5): WebRTC data
// channels between the two clients. Both sides make the same two channels,
// negotiated with fixed ids, so neither waits for `ondatachannel`: `rel`
// (id 0, ordered, reliable) and `fast` (id 1, unordered,
// `maxRetransmits: 0`). The offerer sends its offer, the answerer its
// answer, and each its ICE candidates as they come; a candidate that arrives
// before the remote description is set waits for it. The path opens once
// both channels are open, and fails when ICE fails, when it stays
// disconnected for `DISCONNECTED_GRACE_MS`, when a channel closes, or when a
// step of the negotiation throws. A `fast` message is dropped, never
// queued, while its channel holds more than `FAST_BACKLOG_BYTES` unsent: an
// unreliable channel's buffer still grows under congestion.
//
// The WebRTC types here are structural, the part a link uses, so a React
// Native or Node implementation (react-native-webrtc, a polyfill) fits.
//
// React-free.

import type {
  PeerCandidate,
  PeerDescription,
  PeerLabel,
  PeerSignal,
} from "../../protocol/envelope";

/** How long ICE may stay `disconnected` before the direct path counts as failed. */
export const DISCONNECTED_GRACE_MS = 5000;

/** A `fast` message is dropped while its channel holds more than this many bytes unsent. */
export const FAST_BACKLOG_BYTES = 32_768;

/** Candidates kept for a remote description not set yet. */
const MAX_EARLY_CANDIDATES = 64;

/** A STUN or TURN server, as `RTCIceServer` takes it. */
export interface PeerIceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/** What a link makes its `RTCPeerConnection` with. */
export interface PeerConnectionConfig {
  iceServers: PeerIceServer[];
}

/** The part of an `RTCDataChannel` a link uses. */
export interface RtcChannel {
  readonly readyState: string;
  readonly bufferedAmount: number;
  binaryType: string;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: unknown) => void) | null;
  onmessage: ((event: { readonly data: unknown }) => void) | null;
  send(data: string): void;
  close(): void;
}

/** A candidate as an `RTCPeerConnectionIceEvent` carries it. */
interface RtcCandidate {
  readonly candidate: string;
  readonly sdpMid?: string | null;
  readonly sdpMLineIndex?: number | null;
  readonly usernameFragment?: string | null;
}

/** A session description as `createOffer` and `createAnswer` give it. */
interface RtcDescription {
  readonly type: string;
  readonly sdp?: string;
}

/** The part of an `RTCPeerConnection` a link uses. */
export interface RtcConnection {
  readonly iceConnectionState: string;
  onicecandidate: ((event: { readonly candidate: RtcCandidate | null }) => void) | null;
  oniceconnectionstatechange: ((event: unknown) => void) | null;
  createDataChannel(
    label: string,
    init: { negotiated: true; id: number; ordered: boolean; maxRetransmits?: number },
  ): RtcChannel;
  createOffer(): Promise<RtcDescription>;
  createAnswer(): Promise<RtcDescription>;
  setLocalDescription(description: RtcDescription): Promise<void>;
  setRemoteDescription(description: PeerDescription): Promise<void>;
  addIceCandidate(candidate: PeerCandidate): Promise<void>;
  close(): void;
}

/** What the direct path tells its link. */
export interface DirectEvents {
  /** A signal for the peer: the offer or the answer, or a candidate. */
  signal(sig: PeerSignal): void;
  /** Both channels opened. */
  opened(): void;
  /** The path failed, before or after it opened; it is closed already. */
  failed(): void;
  /** A message arrived on a channel. */
  message(data: unknown, label: PeerLabel): void;
}

/** One link's direct path. */
export interface DirectPath {
  /** True once both channels are open, until the path closes. */
  readonly open: boolean;
  /** Starts as the offerer: makes the offer and signals it. */
  offer(): void;
  /** Applies the peer's offer and signals the answer. */
  answer(offer: PeerDescription): void;
  /** Applies the peer's answer. */
  accept(answer: PeerDescription): void;
  /** Adds a candidate of the peer's. */
  candidate(ice: PeerCandidate): void;
  /** Sends a message's text; false when the path is not open or `fast` is backed up. */
  send(label: PeerLabel, text: string): boolean;
  /** Closes both channels and the connection. */
  close(): void;
}

function candidateOf(candidate: RtcCandidate): PeerCandidate {
  const { sdpMid, sdpMLineIndex, usernameFragment } = candidate;
  return {
    candidate: candidate.candidate,
    ...(sdpMid === undefined ? {} : { sdpMid }),
    ...(sdpMLineIndex === undefined ? {} : { sdpMLineIndex }),
    ...(usernameFragment === undefined ? {} : { usernameFragment }),
  };
}

/** The state one direct path keeps. */
interface DirectState {
  readonly rtc: RtcConnection;
  readonly channels: Readonly<Record<PeerLabel, RtcChannel>>;
  readonly events: DirectEvents;
  readonly early: PeerCandidate[];
  open: boolean;
  closed: boolean;
  remoteSet: boolean;
  grace: ReturnType<typeof setTimeout> | undefined;
}

function shut(state: DirectState): void {
  state.closed = true;
  state.open = false;
  clearTimeout(state.grace);
  state.rtc.onicecandidate = null;
  state.rtc.oniceconnectionstatechange = null;
  for (const channel of Object.values(state.channels)) {
    channel.onopen = null;
    channel.onclose = null;
    channel.onmessage = null;
    channel.close();
  }
  state.rtc.close();
}

function fail(state: DirectState): void {
  if (!state.closed) {
    shut(state);
    state.events.failed();
  }
}

/** Runs one step of the negotiation; a step that throws fails the path. */
function step(state: DirectState, work: () => Promise<void>): void {
  work().catch(() => {
    fail(state);
  });
}

function setRemote(state: DirectState, description: PeerDescription): Promise<void> {
  return state.rtc.setRemoteDescription(description).then(() => {
    state.remoteSet = true;
    for (const ice of state.early.splice(0)) {
      state.rtc.addIceCandidate(ice).catch(() => undefined);
    }
  });
}

/** Signals this side's description, once set, unless the path closed meanwhile. */
async function describe(state: DirectState, kind: "offer" | "answer"): Promise<void> {
  const description = await (kind === "offer" ? state.rtc.createOffer() : state.rtc.createAnswer());
  if (state.closed) {
    return;
  }
  await state.rtc.setLocalDescription(description);
  if (!state.closed) {
    state.events.signal({ sdp: { type: kind, sdp: description.sdp ?? "" } });
  }
}

function watch(state: DirectState): void {
  const { rtc, channels, events } = state;
  for (const label of ["rel", "fast"] as const) {
    const channel = channels[label];
    channel.binaryType = "arraybuffer";
    channel.onopen = () => {
      if (
        !state.open &&
        channels.rel.readyState === "open" &&
        channels.fast.readyState === "open"
      ) {
        state.open = true;
        events.opened();
      }
    };
    channel.onclose = () => {
      fail(state);
    };
    channel.onmessage = (event) => {
      events.message(event.data, label);
    };
  }
  rtc.onicecandidate = (event) => {
    if (event.candidate !== null) {
      events.signal({ ice: candidateOf(event.candidate) });
    }
  };
  rtc.oniceconnectionstatechange = () => {
    const ice = rtc.iceConnectionState;
    if (ice === "failed" || ice === "closed") {
      fail(state);
    } else if (ice === "disconnected") {
      state.grace ??= setTimeout(() => {
        fail(state);
      }, DISCONNECTED_GRACE_MS);
    } else if (ice === "connected" || ice === "completed") {
      clearTimeout(state.grace);
      state.grace = undefined;
    }
  };
}

/** Starts a direct path on `rtc`, its channels made and watched. */
export function createDirectPath(rtc: RtcConnection, events: DirectEvents): DirectPath {
  const state: DirectState = {
    rtc,
    channels: {
      rel: rtc.createDataChannel("rel", { negotiated: true, id: 0, ordered: true }),
      fast: rtc.createDataChannel("fast", {
        negotiated: true,
        id: 1,
        ordered: false,
        maxRetransmits: 0,
      }),
    },
    events,
    early: [],
    open: false,
    closed: false,
    remoteSet: false,
    grace: undefined,
  };
  watch(state);
  return {
    get open() {
      return state.open;
    },
    offer: () => {
      step(state, () => describe(state, "offer"));
    },
    answer: (offer) => {
      step(state, async () => {
        await setRemote(state, offer);
        await describe(state, "answer");
      });
    },
    accept: (answer) => {
      step(state, () => setRemote(state, answer));
    },
    candidate(ice: PeerCandidate): void {
      if (state.closed) {
        return;
      }
      if (!state.remoteSet) {
        if (state.early.length < MAX_EARLY_CANDIDATES) {
          state.early.push(ice);
        }
        return;
      }
      rtc.addIceCandidate(ice).catch(() => undefined);
    },
    send(label: PeerLabel, text: string): boolean {
      const channel = state.channels[label];
      if (!state.open || channel.readyState !== "open") {
        return false;
      }
      if (label === "fast" && channel.bufferedAmount > FAST_BACKLOG_BYTES) {
        return false;
      }
      try {
        channel.send(text);
        return true;
      } catch {
        return false;
      }
    },
    close: () => {
      if (!state.closed) {
        shut(state);
      }
    },
  };
}
