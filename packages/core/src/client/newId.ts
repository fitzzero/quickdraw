// `newId()` (finding F11.2 of the quickdraw-chat migration): an id for a row
// the client creates and the server keeps, so that an optimistic item whose
// call's outcome is unknown can be found by its scope's next load, and its
// `retry()` cannot write a second row (`additions.ts`). A version 4 UUID,
// from `crypto.randomUUID()` where the runtime has it, else made from
// `crypto.getRandomValues()`: browsers give `randomUUID` to secure pages only
// (https, localhost), and a dev server opened at its LAN address is plain
// http, while `getRandomValues` is on every page, in Node, and in React
// Native with a `getRandomValues` polyfill.
//
// React-free, and no dependency.

/** The Web Crypto members `newId` uses. */
interface IdCrypto {
  readonly randomUUID?: () => string;
  readonly getRandomValues?: (array: Uint8Array) => Uint8Array;
}

/** Byte `index` of a version 4 UUID made from the random `byte`: the version in byte 6, the RFC 9562 variant in byte 8. */
function uuidByte(byte: number, index: number): number {
  if (index === 6) {
    return 0x40 + (byte % 0x10);
  }
  return index === 8 ? 0x80 + (byte % 0x40) : byte;
}

/** 16 random bytes as a version 4 UUID. */
function uuidOf(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (byte, index) =>
    uuidByte(byte, index).toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * A new id for a row the client creates and the server keeps: a version 4
 * UUID, from `crypto.randomUUID()`, or from `crypto.getRandomValues()` where
 * that is missing (a page over plain http, which browsers do not give
 * `randomUUID`). Give it to an item an optimistic update adds and to the
 * create's input, so the scope's next load can find the item after a lost
 * answer and `retry()` cannot write twice. Throws a `TypeError` in a runtime
 * without Web Crypto.
 *
 * @example
 * create.mutate({ id: newId(), chatId, content });
 */
export function newId(): string {
  const { crypto } = globalThis as { readonly crypto?: IdCrypto };
  if (typeof crypto?.randomUUID === "function") {
    return crypto.randomUUID();
  }
  if (typeof crypto?.getRandomValues !== "function") {
    throw new TypeError("newId: this runtime has no crypto.getRandomValues");
  }
  return uuidOf(crypto.getRandomValues(new Uint8Array(16)));
}
