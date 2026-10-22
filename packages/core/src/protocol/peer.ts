// Reading peer link signals (RFC 0003 section 12.5), for the server that
// forwards them and the client that applies them. A signal is copied member
// by member, so what goes on is only what was read: a session description
// of at most `MAX_PEER_SIGNAL_LENGTH` characters, an ICE candidate whose
// strings hold at most `MAX_PEER_CANDIDATE_LENGTH`, `relay` or `bye`.
// Internal: neither the package root nor `./client` exports these.

import type { PeerCandidate, PeerDescription, PeerLabel, PeerSignal } from "./envelope";
import { isRecord } from "./guards";
import { MAX_PEER_CANDIDATE_LENGTH, MAX_PEER_SIGNAL_LENGTH, MAX_SCOPE_LENGTH } from "./version";

/** The longest socket id a peer frame may name. Socket.IO's are 20 characters. */
export const MAX_SOCKET_ID_LENGTH = 64;

/** True for a string of at most `MAX_PEER_SIGNAL_LENGTH` characters, empty included. */
function isText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PEER_SIGNAL_LENGTH;
}

/** True for a string of at most `MAX_PEER_CANDIDATE_LENGTH` characters, empty included. */
function isCandidateText(value: unknown): value is string {
  return typeof value === "string" && value.length <= MAX_PEER_CANDIDATE_LENGTH;
}

/** True for what may name an app room: 1 to `MAX_SCOPE_LENGTH` characters. */
export function isRoomName(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_SCOPE_LENGTH;
}

/** True for what may name a socket: 1 to `MAX_SOCKET_ID_LENGTH` characters. */
export function isSocketId(value: unknown): value is string {
  return typeof value === "string" && value !== "" && value.length <= MAX_SOCKET_ID_LENGTH;
}

/** True for `rel` and `fast`. */
export function isPeerLabel(value: unknown): value is PeerLabel {
  return value === "rel" || value === "fast";
}

/** True when `value` is absent, `null`, or passes `check`. */
function nullable(value: unknown, check: (inner: unknown) => boolean): boolean {
  return value === undefined || value === null || check(value);
}

function isLineIndex(value: unknown): boolean {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function readDescription(value: unknown): PeerDescription | undefined {
  if (!isRecord(value) || (value.type !== "offer" && value.type !== "answer")) {
    return undefined;
  }
  return isText(value.sdp) ? { type: value.type, sdp: value.sdp } : undefined;
}

function readCandidate(value: unknown): PeerCandidate | undefined {
  if (!isRecord(value) || !isCandidateText(value.candidate)) {
    return undefined;
  }
  const { sdpMid, sdpMLineIndex, usernameFragment } = value;
  if (
    !nullable(sdpMid, isCandidateText) ||
    !nullable(sdpMLineIndex, isLineIndex) ||
    !nullable(usernameFragment, isCandidateText)
  ) {
    return undefined;
  }
  return {
    candidate: value.candidate,
    ...(sdpMid === undefined ? {} : { sdpMid: sdpMid as string | null }),
    ...(sdpMLineIndex === undefined ? {} : { sdpMLineIndex: sdpMLineIndex as number | null }),
    ...(usernameFragment === undefined
      ? {}
      : { usernameFragment: usernameFragment as string | null }),
  };
}

/**
 * The signal `value` holds, copied, or `undefined` unless it holds exactly
 * one of `sdp`, `ice`, `relay: true` and `bye: true`, well formed. Fields
 * it does not know are left behind.
 */
export function readSignal(value: unknown): PeerSignal | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { sdp, ice, relay, bye } = value;
  if ([sdp, ice, relay, bye].filter((member) => member !== undefined).length !== 1) {
    return undefined;
  }
  if (sdp !== undefined) {
    const description = readDescription(sdp);
    return description === undefined ? undefined : { sdp: description };
  }
  if (ice !== undefined) {
    const candidate = readCandidate(ice);
    return candidate === undefined ? undefined : { ice: candidate };
  }
  if (relay === true) {
    return { relay: true };
  }
  return bye === true ? { bye: true } : undefined;
}
