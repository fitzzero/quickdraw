// Peer link messages (RFC 0003 section 12.5): the JSON text one data channel
// message or one relayed `text` holds, alike on both paths, so a link can
// change paths without either side reading a message differently.
// `[0, data]` carries the app's data, `[1, t]` is a clock ping and
// `[2, t, u]` its pong (`clock.ts`). A message whose kind this client does
// not know, or that is not JSON, is ignored.
//
// React-free.

import type { PeerMessage } from "../../protocol/envelope";
import { utf8ByteLength } from "../../protocol/utf8";

/** The text a link message travels as. */
export function encodeMessage(message: PeerMessage): string {
  return JSON.stringify(message);
}

/** The UTF-8 size of a message's text, which `limits.peers.maxMessageBytes` caps. */
export const messageBytes = utf8ByteLength;

let decoder: TextDecoder | undefined;

/** A data channel message as text: a string, or the UTF-8 bytes a peer sent in binary mode. */
function textOf(data: unknown): string | undefined {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof ArrayBuffer || ArrayBuffer.isView(data)) {
    decoder ??= new TextDecoder();
    return decoder.decode(data);
  }
  return undefined;
}

function isTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** The link message `data` holds, or `undefined` for what this client does not read. */
export function decodeMessage(data: unknown): PeerMessage | undefined {
  const text = textOf(data);
  if (text === undefined) {
    return undefined;
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const [kind, first, second] = value as readonly unknown[];
  if (kind === 0 && value.length >= 2) {
    return [0, first];
  }
  if (kind === 1 && isTime(first)) {
    return [1, first];
  }
  return kind === 2 && isTime(first) && isTime(second) ? [2, first, second] : undefined;
}
