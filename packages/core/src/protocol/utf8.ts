// The UTF-8 size of a string without encoding it. Node and Bun count natively
// with `Buffer.byteLength`; browsers and React Native have no `Buffer`, so
// there the string is counted in a loop. Internal to the JSON parser.

interface ByteCounter {
  byteLength(text: string, encoding: "utf8"): number;
}

const nodeBuffer: ByteCounter | undefined = (globalThis as { Buffer?: ByteCounter }).Buffer;

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

/**
 * Counts the bytes UTF-8 encodes `text` into. A surrogate pair is one 4-byte
 * code point; a lone surrogate counts as the 3-byte U+FFFD an encoder writes
 * in its place.
 */
export function countUtf8Bytes(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit < 0x80) {
      bytes += 1;
    } else if (unit < 0x800) {
      bytes += 2;
    } else if (isHighSurrogate(unit) && isLowSurrogate(text.charCodeAt(index + 1))) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

/** The size of `text` in UTF-8 bytes, as it goes over the wire. */
export function utf8ByteLength(text: string): number {
  return nodeBuffer === undefined ? countUtf8Bytes(text) : nodeBuffer.byteLength(text, "utf8");
}
