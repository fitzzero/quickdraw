// The peer link frames a server reads (RFC 0003 section 12.5): `qd:peer` and
// `qd:relay` from its sockets, and what another node of its deployment
// forwards for a socket of this one. A relayed `text` is never parsed: only
// its size is read, in UTF-8 bytes.

import type { PeerLabel, PeerSignal } from "../../protocol/envelope";
import { isRecord } from "../../protocol/guards";
import { isPeerLabel, isRoomName, isSocketId, readSignal } from "../../protocol/peer";
import { utf8ByteLength } from "../../protocol/utf8";
import { MAX_PEER_MESSAGE_BYTES } from "../../protocol/version";
import { unreadable } from "../transports/ack";

/** A `qd:peer` frame, read. */
export interface SignalRequest {
  readonly room: string;
  readonly to: string;
  readonly sig: PeerSignal;
}

/** A `qd:relay` frame, read, with its text's size. */
export interface RelayRequest {
  readonly room: string;
  readonly to: string;
  readonly label: PeerLabel;
  readonly text: string;
  readonly bytes: number;
}

/** A signal another node forwards to a socket of this one. */
export interface ForwardedSignal extends SignalRequest {
  readonly from: string;
  readonly userId: string;
}

/** A relay message another node forwards to a socket of this one. */
export interface ForwardedRelay {
  readonly room: string;
  readonly to: string;
  readonly from: string;
  readonly label: PeerLabel;
  readonly text: string;
}

const SIGNAL_SHAPE =
  "A qd:peer frame needs { room, to, sig }: an app room, another socket's id, and a signal holding one of sdp, ice, relay: true or bye: true";

/** Reads a `qd:peer` frame from socket `self`, or throws `VALIDATION`. */
export function readSignalFrame(frame: unknown, self: string): SignalRequest {
  if (!isRecord(frame) || !isRoomName(frame.room) || !isSocketId(frame.to)) {
    throw unreadable(SIGNAL_SHAPE);
  }
  if (frame.to === self) {
    throw unreadable("A socket cannot link to itself", ["to"]);
  }
  const sig = readSignal(frame.sig);
  if (sig === undefined) {
    throw unreadable(SIGNAL_SHAPE, ["sig"]);
  }
  return { room: frame.room, to: frame.to, sig };
}

/**
 * The text's size when it fits a link message, else `undefined`. UTF-8
 * takes at least a byte per UTF-16 unit, so a long string is refused before
 * it is counted.
 */
function messageBytes(text: string): number | undefined {
  if (text.length > MAX_PEER_MESSAGE_BYTES) {
    return undefined;
  }
  const bytes = utf8ByteLength(text);
  return bytes > MAX_PEER_MESSAGE_BYTES ? undefined : bytes;
}

/** Reads a `qd:relay` frame, or `undefined` when it is malformed or its text too long. */
export function readRelayFrame(frame: unknown): RelayRequest | undefined {
  if (!Array.isArray(frame)) {
    return undefined;
  }
  const [room, to, label, text] = frame as readonly unknown[];
  if (!isRoomName(room) || !isSocketId(to) || !isPeerLabel(label) || typeof text !== "string") {
    return undefined;
  }
  const bytes = messageBytes(text);
  return bytes === undefined ? undefined : { room, to, label, text, bytes };
}

/** Reads a signal another node forwarded, or `undefined` for anything malformed. */
export function readForwardedSignal(value: unknown): ForwardedSignal | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { room, to, from, userId } = value;
  const sig = readSignal(value.sig);
  if (!isRoomName(room) || !isSocketId(to) || !isSocketId(from) || sig === undefined) {
    return undefined;
  }
  return typeof userId === "string" && userId !== "" ? { room, to, from, userId, sig } : undefined;
}

/** Reads a relay message another node forwarded, or `undefined` for anything malformed. */
export function readForwardedRelay(value: unknown): ForwardedRelay | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const { room, to, from, label, text } = value;
  if (!isRoomName(room) || !isSocketId(to) || !isSocketId(from) || !isPeerLabel(label)) {
    return undefined;
  }
  return typeof text === "string" && messageBytes(text) !== undefined
    ? { room, to, from, label, text }
    : undefined;
}
