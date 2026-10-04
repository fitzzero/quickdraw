// A Socket.IO argument whose JSON text is written outside the encoder, so
// text many packets share is written once (RFC 0003 sections 8.4 and 9): the
// reply of a shared run goes to every caller in the same text. The JSON
// parser (`parser.ts`) writes that text as the argument. Anything else that
// serializes the argument, `JSON.stringify` or the stock parser's encoder,
// writes its value through `toJSON`. Internal: the server builds these and
// only its own JSON parser reads them.

/** An argument whose JSON text `json()` writes; see the module comment. */
export class PreEncoded {
  /**
   * @param value - What the argument is.
   * @param json - Writes `JSON.stringify(value)`; called once per packet, and
   *   may throw what `JSON.stringify` throws.
   */
  constructor(
    readonly value: unknown,
    readonly json: () => string,
  ) {}

  toJSON(): unknown {
    return this.value;
  }
}

export function isPreEncoded(value: unknown): value is PreEncoded {
  return value instanceof PreEncoded;
}
