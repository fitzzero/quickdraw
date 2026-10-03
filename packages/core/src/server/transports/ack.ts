// Replies a transport sends itself, and acknowledging a socket call while
// measuring its reply (RFC 0003 section 9, step 9). The JSON parser reports
// each packet it encodes; an acknowledgement is encoded synchronously inside
// the `ack()` call that sends it, so the packet reported while `ack()` runs is
// that reply. The size reaches the completion record through the
// dispatcher's `respond`.
//
// Socket.IO's server-side `ack()` marks itself sent only after the packet was
// written, so when encoding the reply throws (a `BigInt` or a cycle that
// `JSON.stringify` refuses), the same `ack()` can still send a fallback.

import { PacketType } from "socket.io-parser";
import type { Failure } from "../../protocol/envelope";
import { INTERNAL_MESSAGE, QuickdrawError, type WireIssue } from "../../protocol/errors";
import { createJsonParser, type JsonParser } from "../../protocol/parser";

/**
 * A `VALIDATION` error for a frame or request the transport could not read,
 * before any method ran, with its one issue in `data.issues` as RFC 0003
 * section 3 requires.
 */
export function unreadable(message: string, path: WireIssue["path"] = []): QuickdrawError {
  return new QuickdrawError("VALIDATION", message, { issues: [{ path, message }] });
}

/** The reply a call gets when its own reply could not be encoded. */
export const INTERNAL_FAILURE: Failure = Object.freeze({
  ok: false,
  e: Object.freeze({ code: "INTERNAL", message: INTERNAL_MESSAGE }),
});

/** The function Socket.IO hands a listener to acknowledge an event. */
export type Acknowledge = (reply: unknown) => void;

/** Picks the parser a server uses and measures the acknowledgements it writes. */
export interface ReplyMeter {
  /** The parser to give Socket.IO: the JSON parser, or `undefined` for the stock one. */
  readonly parser: JsonParser | undefined;
  /**
   * Runs `send`, which writes one acknowledgement, and returns that reply's
   * size in UTF-8 bytes. `undefined` when nothing was measured: the stock
   * parser measures nothing, and a closed socket writes nothing.
   */
  measure(send: () => void): number | undefined;
}

interface Measurement {
  bytes: number | undefined;
}

/** The JSON parser with a meter on its encoder, or the stock parser when `binary` is true. */
export function createReplyMeter(binary: boolean): ReplyMeter {
  if (binary) {
    return {
      parser: undefined,
      measure(send) {
        send();
        return undefined;
      },
    };
  }
  let current: Measurement | undefined;
  const parser = createJsonParser({
    onEncoded(packet, bytes) {
      if (current !== undefined && packet.type === PacketType.ACK) {
        current.bytes = bytes;
      }
    },
  });
  return {
    parser,
    measure(send) {
      const measurement: Measurement = { bytes: undefined };
      const outer = current;
      current = measurement;
      try {
        send();
      } finally {
        current = outer;
      }
      return measurement.bytes;
    },
  };
}

/**
 * Sends `reply` through `ack` and returns its size. When the reply cannot be
 * encoded, reports the error and sends `fallback` through the same `ack`
 * instead. Never throws.
 */
export function acknowledge(
  meter: ReplyMeter,
  ack: Acknowledge,
  reply: unknown,
  fallback: unknown,
  report: (error: unknown) => void,
): number | undefined {
  try {
    return meter.measure(() => ack(reply));
  } catch (error) {
    report(error);
  }
  try {
    return meter.measure(() => ack(fallback));
  } catch (error) {
    report(error);
    return undefined;
  }
}
