// Peer link messages (RFC 0003 section 12.5): the JSON text one data channel
// message or one relayed `text` holds, alike on both paths, so a link can
// change paths without either side reading a message differently.
// `[0, data]` carries the app's data, `[1, t]` is a clock ping and
// `[2, t, u]` its pong (`clock.ts`); kinds 3 to 8 are host mode's
// (`HostMessage`: a channel message, a subscribe and an unsubscribe, a
// seed's chunk, an item, a refused subscribe). A message whose kind this
// client does not know, whose members are not what its kind says, or that
// is not JSON, is ignored.
//
// React-free.

import type { HostMessage, PeerMessage } from "../../protocol/envelope";
import type { WireError } from "../../protocol/errors";
import { isName, isRecord } from "../../protocol/guards";
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

/** A host mode message's members after its kind, read: `undefined` when they are not its kind's. */
function readHostMessage(value: readonly unknown[]): HostMessage | undefined {
  const [kind, service, name, third, fourth, fifth] = value;
  if (!isName(service) || !isName(name)) {
    return undefined;
  }
  if (kind === 3) {
    return value.length >= 4 ? [3, service, name, third] : undefined;
  }
  if (!isName(third)) {
    return undefined;
  }
  switch (kind) {
    case 4:
    case 5:
      return [kind, service, name, third];
    case 6:
      return Array.isArray(fourth) && typeof fifth === "boolean"
        ? [6, service, name, third, fourth as unknown[], fifth]
        : undefined;
    case 7:
      return value.length >= 5 ? [7, service, name, third, fourth] : undefined;
    case 8:
      return isRecord(fourth) && isName(fourth.code) && typeof fourth.message === "string"
        ? [8, service, name, third, { code: fourth.code, message: fourth.message } as WireError]
        : undefined;
    default:
      return undefined;
  }
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
  if (kind === 2) {
    return isTime(first) && isTime(second) ? [2, first, second] : undefined;
  }
  return readHostMessage(value as readonly unknown[]);
}
