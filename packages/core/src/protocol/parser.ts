// A JSON-only Socket.IO parser (RFC 0003 section 8.4). The stock encoder
// walks every event and acknowledgement looking for binary values, then
// serializes it; this one skips the walk. For a packet without binary its
// output is the stock output byte for byte, because it is the stock encoder's
// own string encoding: `encode` is overridden to call `encodeAsString`
// directly (socket.io-parser 4.2.5 `Encoder.encode`). The 4.x legacy shim
// therefore needs no second parser. The decoder is the stock decoder, so a
// server using this parser still reads packets from a client that uses the
// stock one, binary included.
//
// Apps that send binary use the stock parser instead (`binary: true` on the
// server). This module imports `socket.io-parser`, so it is its own export,
// `@fitzzero/quickdraw-core/parser`, and the package root stays free of
// dependencies.
//
// The server hands it pre-encoded arguments (`preEncoded.ts`) for text that
// several packets share, such as a shared run's reply to each of its callers:
// their text is spliced in as written, so it is encoded once, not per packet.

import { Decoder, Encoder, PacketType, type Packet } from "socket.io-parser";
import { isPreEncoded, type PreEncoded } from "./preEncoded";
import { utf8ByteLength } from "./utf8";

/** Options of {@link createJsonParser}. */
export interface JsonParserOptions {
  /**
   * Called with every packet the encoder writes and its size in UTF-8 bytes:
   * events, acknowledgements (a call's response travels as one) and connection
   * packets. A broadcast is encoded once, so it is reported once, not once per
   * recipient. The hook runs inside `emit`: keep it cheap. It must not throw;
   * if it does, the error is ignored and the packet is still sent.
   */
  readonly onEncoded?: (packet: Packet, byteLength: number) => void;
}

/** A Socket.IO parser: the `parser` option of both `new Server()` and `io()`. */
export interface JsonParser {
  readonly Encoder: typeof Encoder;
  readonly Decoder: typeof Decoder;
}

type EncodedHook = NonNullable<JsonParserOptions["onEncoded"]>;

/** The stock encoder's string encoding; `private` in its type declarations only. */
interface StringEncoding {
  encodeAsString(this: Encoder, packet: Packet): string;
}

const hasBlob = typeof Blob === "function";

/** Binary as the stock parser defines it: an `ArrayBuffer`, a view of one (`Buffer` too) or a `Blob`. */
function isBinary(value: unknown): value is object {
  return (
    typeof value === "object" &&
    value !== null &&
    (ArrayBuffer.isView(value) ||
      value instanceof ArrayBuffer ||
      (hasBlob && value instanceof Blob))
  );
}

function binaryMessage(packet: Packet, index: number, value: object): string {
  const kind = Object.prototype.toString.call(value).slice(8, -1);
  const where =
    packet.type === PacketType.ACK
      ? `Argument ${index + 1} of acknowledgement ${String(packet.id)}`
      : `Argument ${index} of event "${String(packet.data[0])}"`;
  return (
    `${where} is binary (${kind}), which the JSON-only Socket.IO parser cannot send. ` +
    "Use the stock Socket.IO parser to send binary; a quickdraw server takes `binary: true`."
  );
}

/**
 * Throws when an argument of an event or an acknowledgement is binary. It
 * looks at the arguments themselves, never inside them: that search is the
 * cost this parser exists to remove. Binary nested in an argument is written
 * the way `JSON.stringify` writes it.
 */
function rejectBinaryArguments(packet: Packet): void {
  if (packet.type !== PacketType.EVENT && packet.type !== PacketType.ACK) {
    return;
  }
  const args: unknown = packet.data;
  if (!Array.isArray(args)) {
    return;
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg: unknown = args[index];
    if (isBinary(arg)) {
      throw new TypeError(binaryMessage(packet, index, arg));
    }
  }
}

/** The stock `encodeAsString`, or a clear error when a socket.io-parser release drops it. */
function stockEncodeAsString(): StringEncoding["encodeAsString"] {
  const { encodeAsString } = Encoder.prototype as unknown as Partial<StringEncoding>;
  if (typeof encodeAsString !== "function") {
    throw new TypeError(
      "createJsonParser: socket.io-parser's Encoder has no encodeAsString method, " +
        "which the JSON parser is built on. Install socket.io-parser 4.2.4 or a later 4.x.",
    );
  }
  return encodeAsString;
}

/** The arguments of an event or acknowledgement when every one is pre-encoded. */
function preEncodedArguments(packet: Packet): readonly PreEncoded[] | undefined {
  const data: unknown = packet.data;
  if (
    (packet.type !== PacketType.EVENT && packet.type !== PacketType.ACK) ||
    !Array.isArray(data)
  ) {
    return undefined;
  }
  const args: readonly unknown[] = data;
  return args.length > 0 && args.every(isPreEncoded) ? args : undefined;
}

/**
 * The text of an event or acknowledgement whose arguments are all
 * pre-encoded: the stock encoding of the packet without its arguments, then
 * the arguments' own text as a JSON array, which is what the stock encoding
 * writes for their values. `undefined` for any other packet, and when the
 * encoder was given a `replacer` (the stock encoding then writes the values).
 */
function splicedText(
  encoder: Encoder,
  packet: Packet,
  encodeAsString: StringEncoding["encodeAsString"],
): string | undefined {
  const args = preEncodedArguments(packet);
  const { replacer } = encoder as unknown as { readonly replacer?: unknown };
  if (args === undefined || replacer !== undefined) {
    return undefined;
  }
  const head = encodeAsString.call(encoder, { ...packet, data: undefined });
  return `${head}[${args.map((arg) => arg.json()).join(",")}]`;
}

function report(onEncoded: EncodedHook, packet: Packet, text: string): void {
  try {
    onEncoded(packet, utf8ByteLength(text));
  } catch {
    // Measuring never stops a packet: a throw here would surface from `emit`.
  }
}

/**
 * Creates a Socket.IO parser that writes packets as JSON text only: the stock
 * encoder without its search for binary values, and the stock decoder. Pass it
 * as `parser` to the server and to the client; either end may also keep the
 * stock parser, since the two write the same text.
 *
 * An event or acknowledgement whose argument is binary (a `Buffer`, typed
 * array, `ArrayBuffer`, `DataView` or `Blob`) throws a `TypeError` from
 * `emit`. Binary inside an argument is not looked for.
 */
export function createJsonParser(options: JsonParserOptions = {}): JsonParser {
  const { onEncoded } = options;
  const encodeAsString = stockEncodeAsString();

  class JsonEncoder extends Encoder {
    override encode(packet: Packet): string[] {
      rejectBinaryArguments(packet);
      const text = splicedText(this, packet, encodeAsString) ?? encodeAsString.call(this, packet);
      if (onEncoded !== undefined) {
        report(onEncoded, packet, text);
      }
      return [text];
    }
  }

  return Object.freeze({ Encoder: JsonEncoder, Decoder });
}
