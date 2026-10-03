// Reading a JWT's payload without verifying it, carried over from 4.1
// (`legacy-src/client/utils/auth.ts:29-63`). Pure and DOM-free (`atob` is a
// global in browsers, Node and React Native), so the `./utils` entry exports
// it for React server components too. The helpers that keep the token in
// `localStorage` stay on `./client` (`../client/auth.ts`).
//
// A JWT's segments are base64url (RFC 7515): `-` and `_` where base64 has
// `+` and `/`, and no padding. 4.1 handed them to `atob` as they were, which
// refuses those characters and a length that is not a multiple of 4; here a
// segment is turned into padded base64 first, and its bytes read as UTF-8.

export interface JWTPayload {
  userId: string;
  email?: string;
}

/** The text of a base64url segment: its bytes as UTF-8 where `TextDecoder` exists, else as Latin-1. */
function decodeSegment(segment: string): string {
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
  if (typeof TextDecoder === "undefined") {
    return binary;
  }
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

/**
 * Parse JWT payload client-side (not verified, for display purposes only).
 */
export function parseJWTPayload(token: string): JWTPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;

    const decoded = decodeSegment(parts[1]);
    const payload: unknown = JSON.parse(decoded);

    if (
      typeof payload === "object" &&
      payload !== null &&
      "userId" in payload &&
      typeof (payload as { userId: unknown }).userId === "string"
    ) {
      const typedPayload = payload as { userId: string; email?: string };
      return {
        userId: typedPayload.userId,
        email: typedPayload.email,
      };
    }
    return null;
  } catch {
    return null;
  }
}
