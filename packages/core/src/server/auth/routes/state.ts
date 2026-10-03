// The OAuth `state` of a sign-in (RFC 6749 section 10.12), bound to the
// browser that started it and redeemable once. `start` sends the state to
// the provider and keeps it, with the provider and the validated return
// origin, in a short-lived HttpOnly cookie (`__Host-qd_oauth` on `/` over a
// secure request, else `qd_oauth` on the auth routes' path). The
// callback clears that cookie whatever happens, accepts the state only when
// the provider sent back the cookie's own value, for the same provider and
// within ten minutes, and remembers each redeemed state in this process until
// it would have expired anyway, so a replayed callback is refused even when
// its cookie is replayed with it. The return origin read back from the cookie
// is validated again before any redirect (`createAuthRoutes`).

import { randomBytes, timingSafeEqual } from "node:crypto";

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

/** The state cookie's value for a sign-in. */
export function encodePending(pending: PendingSignIn): string {
  return Buffer.from(JSON.stringify(pending), "utf8").toString("base64url");
}

/** The sign-in a state cookie's value carries, or `null` when it carries none. */
export function decodePending(raw: string | undefined): PendingSignIn | null {
  if (raw === undefined || raw === "") {
    return null;
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
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
