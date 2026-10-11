// The OAuth `state` of a sign-in (RFC 6749 section 10.12), bound to the
// browser that started it and redeemable once. `start` sends the state to
// the provider and keeps it, with the provider and the validated return
// origin, in a short-lived HttpOnly cookie: `__Host-qd_oauth` on `/` over a
// secure request or whenever `publicUrl` is https, else `qd_oauth` on the
// auth routes' path. The `__Host-` name is what keeps a sibling site from
// planting a state the routes issued to an attacker, to sign the browser in
// as them (the 5.1 audit's AUTH-2b, a login CSRF): only this host, over
// HTTPS, can set it, so a deployment whose state cookie is `qd_oauth` keeps
// that risk. The cookie is also signed with an HMAC-SHA256 under a key
// derived from the JWT secret, so a payload the routes did not write (its
// state, origin, provider or issue time) is no sign-in; the MAC does not
// say which browser a state was issued to. The callback
// clears that cookie whatever happens, accepts the state only when the
// provider sent back the cookie's own value, for the same provider and
// within ten minutes, and remembers each redeemed state in this process until
// it would have expired anyway, so a replayed callback is refused even when
// its cookie is replayed with it. The return origin read back from the cookie
// is validated again before any redirect (`createAuthRoutes`).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The cookie that carries a sign-in in progress, on a request that is not secure. */
export const OAUTH_STATE_COOKIE = "qd_oauth";

/**
 * The cookie that carries a sign-in in progress on a secure request: the
 * `__Host-` prefix keeps any other site under the same parent domain from
 * planting a state of its own (a login CSRF), and requires `Path=/`.
 */
export const HOST_OAUTH_STATE_COOKIE = "__Host-qd_oauth";

/** How long a sign-in may take from `start` to its callback. */
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

/** At most this many redeemed states are remembered; the oldest are forgotten first. */
const MAX_REDEEMED = 10_000;

/** A sign-in in progress, as its cookie carries it. */
export interface PendingSignIn {
  /** The `state` sent to the provider. */
  readonly state: string;
  /** The provider's id. */
  readonly provider: string;
  /** The validated origin to return to. */
  readonly origin: string;
  /** When `start` issued it, in epoch milliseconds. */
  readonly issuedAt: number;
}

/** A new state: 256 random bits, base64url. */
export function newState(): string {
  return randomBytes(32).toString("base64url");
}

/** The key the state cookie is signed with: derived from the JWT secret, for this use only. */
export function oauthStateKey(jwtSecret: string): Buffer {
  return createHmac("sha256", jwtSecret).update("quickdraw:oauth-state").digest();
}

function macOf(payload: string, key: Buffer): Buffer {
  return createHmac("sha256", key).update(payload).digest();
}

/** The state cookie's value for a sign-in: its JSON, base64url, then `.` and its MAC under `key`. */
export function encodePending(pending: PendingSignIn, key: Buffer): string {
  const payload = Buffer.from(JSON.stringify(pending), "utf8").toString("base64url");
  return `${payload}.${macOf(payload, key).toString("base64url")}`;
}

/**
 * The sign-in a state cookie's value carries, or `null` when it carries
 * none: its MAC under `key` is checked (in constant time) before anything
 * is read, so a cookie the routes did not write is none.
 */
export function decodePending(raw: string | undefined, key: Buffer): PendingSignIn | null {
  const dot = raw === undefined ? -1 : raw.lastIndexOf(".");
  if (raw === undefined || dot <= 0) {
    return null;
  }
  const payload = raw.slice(0, dot);
  const mac = Buffer.from(raw.slice(dot + 1), "base64url");
  const expected = macOf(payload, key);
  if (mac.length !== expected.length || !timingSafeEqual(mac, expected)) {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const { state, provider, origin, issuedAt } = (value ?? {}) as Partial<
    Record<keyof PendingSignIn, unknown>
  >;
  if (
    typeof state !== "string" ||
    typeof provider !== "string" ||
    typeof origin !== "string" ||
    typeof issuedAt !== "number"
  ) {
    return null;
  }
  return { state, provider, origin, issuedAt };
}

function sameString(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * True when the callback's `state` is the pending sign-in's own, for the
 * same provider, issued no more than {@link OAUTH_STATE_TTL_MS} ago.
 */
export function stateMatches(
  pending: PendingSignIn,
  provider: string,
  returned: string | null,
  now: number,
): boolean {
  const age = now - pending.issuedAt;
  return (
    returned !== null &&
    pending.provider === provider &&
    age >= 0 &&
    age <= OAUTH_STATE_TTL_MS &&
    sameString(pending.state, returned)
  );
}

/** The states this process has redeemed, so each is redeemed once. */
export interface RedeemedStates {
  /** Records `state` as redeemed; false when it already was. */
  redeem(state: string, now: number): boolean;
}

/** An empty record of redeemed states, each kept until it would have expired anyway. */
export function redeemedStates(): RedeemedStates {
  // Insertion order is redemption order, so the oldest entries come first.
  const redeemed = new Map<string, number>();
  return {
    redeem(state, now) {
      for (const [key, until] of redeemed) {
        if (until > now && redeemed.size < MAX_REDEEMED) {
          break;
        }
        redeemed.delete(key);
      }
      if (redeemed.has(state)) {
        return false;
      }
      redeemed.set(state, now + OAUTH_STATE_TTL_MS);
      return true;
    },
  };
}
