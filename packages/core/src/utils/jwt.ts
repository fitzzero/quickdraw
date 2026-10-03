// Reading a JWT's payload without verifying it, carried over unchanged from
// 4.1 (`legacy-src/client/utils/auth.ts:29-63`). Pure and DOM-free (`atob` is
// a global in browsers, Node and React Native), so the `./utils` entry
// exports it for React server components too. The helpers that keep the
// token in `localStorage` stay on `./client` (`../client/auth.ts`).

export interface JWTPayload {
  userId: string;
  email?: string;
}

/**
 * Parse JWT payload client-side (not verified, for display purposes only).
 */
export function parseJWTPayload(token: string): JWTPayload | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts[1]) return null;

    const decoded = atob(parts[1]);
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
