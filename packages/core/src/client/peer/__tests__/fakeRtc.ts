// An in-process stand-in for WebRTC, for the peer link tests: a network that
// pairs two fake `RTCPeerConnection`s once each holds the other's session
// description and a candidate of its, then (in its `connect` mode) reports
// ICE connected and opens each pair of channels, which carry what is sent to
// the other side a task later. `fail` reports ICE failed instead, `never`
// leaves the pair checking.

import type { PeerCandidate, PeerDescription } from "../../../protocol/envelope";
import type { PeerConnectionConfig, RtcConnection } from "../rtc";
import { FakeChannel, type ChannelInit } from "./fakeChannel";

export { FakeChannel, type ChannelInit } from "./fakeChannel";

/** What the network does with a pair that has exchanged descriptions and candidates. */
export type NetworkMode = "connect" | "fail" | "never";

let made = 0;

export class FakeRtc implements RtcConnection {
  readonly id: string;
  iceConnectionState = "new";
  onicecandidate:
    | ((event: { readonly candidate: { readonly candidate: string } | null }) => void)
    | null = null;
  oniceconnectionstatechange: ((event: unknown) => void) | null = null;
  readonly channels = new Map<string, FakeChannel>();
  local: { readonly type: string; readonly sdp?: string } | undefined;
  remote: PeerDescription | undefined;
  /** The peer's candidates this side was given. */
  readonly candidates: PeerCandidate[] = [];
  peer: FakeRtc | undefined;
  closed = false;

  constructor(
    readonly network: FakeNetwork,
    readonly configuration: PeerConnectionConfig,
  ) {
    made += 1;
    this.id = `rtc${String(made)}`;
  }

  createDataChannel(label: string, init: ChannelInit): FakeChannel {
    const channel = new FakeChannel(label, init);
    this.channels.set(label, channel);
    return channel;
  }

  createOffer() {
    return Promise.resolve({ type: "offer", sdp: `offer:${this.id}` });
  }

  createAnswer() {
    return Promise.resolve({ type: "answer", sdp: `answer:${this.id}` });
  }

  setLocalDescription(description: { readonly type: string; readonly sdp?: string }) {
    this.local = description;
    setTimeout(() => {
      this.onicecandidate?.({
        candidate: { candidate: `candidate:${this.id}`, sdpMid: "0", sdpMLineIndex: 0 } as {
          readonly candidate: string;
        },
      });
      this.onicecandidate?.({ candidate: null });
    }, 0);
    return Promise.resolve();
  }

  setRemoteDescription(description: PeerDescription) {
    this.remote = description;
    this.peer = this.network.byId(description.sdp.split(":")[1] ?? "");
    this.network.attempt(this);
    return Promise.resolve();
  }

  addIceCandidate(candidate: PeerCandidate) {
    this.candidates.push(candidate);
    this.network.attempt(this);
    return Promise.resolve();
  }

  close(): void {
    this.closed = true;
    this.iceConnectionState = "closed";
    for (const channel of this.channels.values()) {
      channel.close();
    }
  }

  /** Moves ICE to `state`, as the platform reports it. */
  setIce(state: string): void {
    this.iceConnectionState = state;
    this.oniceconnectionstatechange?.({});
  }
}

/** The stand-in network: what it does with a pair, the connections it made, and their factory. */
export interface FakeNetwork {
  mode: NetworkMode;
  readonly made: FakeRtc[];
  /** The factory a link takes as `peerConnection`. */
  readonly factory: (configuration: PeerConnectionConfig) => FakeRtc;
  byId(id: string): FakeRtc | undefined;
  /** Connects (or fails) a pair once both sides hold each other's description and a candidate. */
  attempt(rtc: FakeRtc): void;
}

/** Opens each pair of channels once ICE connected. */
function openChannels(rtc: FakeRtc, peer: FakeRtc): void {
  rtc.setIce("connected");
  peer.setIce("connected");
  for (const label of ["rel", "fast"]) {
    const ours = rtc.channels.get(label);
    const theirs = peer.channels.get(label);
    if (ours !== undefined && theirs !== undefined) {
      ours.other = theirs;
      theirs.other = ours;
      ours.open();
      theirs.open();
    }
  }
}

export function createFakeNetwork(): FakeNetwork {
  const network: FakeNetwork = {
    mode: "connect",
    made: [],
    factory: (configuration) => {
      const rtc = new FakeRtc(network, configuration);
      network.made.push(rtc);
      return rtc;
    },
    byId: (id) => network.made.find((rtc) => rtc.id === id),
    attempt(rtc: FakeRtc): void {
      const { peer } = rtc;
      const ready =
        peer?.peer === rtc &&
        rtc.remote !== undefined &&
        peer.remote !== undefined &&
        rtc.candidates.length > 0 &&
        peer.candidates.length > 0 &&
        rtc.iceConnectionState === "new";
      if (!ready || network.mode === "never") {
        return;
      }
      rtc.iceConnectionState = "checking";
      peer.iceConnectionState = "checking";
      setTimeout(() => {
        if (rtc.closed || peer.closed) {
          return;
        }
        if (network.mode === "fail") {
          rtc.setIce("failed");
          peer.setIce("failed");
          return;
        }
        openChannels(rtc, peer);
      }, 0);
    },
  };
  return network;
}
