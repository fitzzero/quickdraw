import * as jose from "jose";
import { consoleLogger } from "../../contract/logger";

export interface JWTPayload {
  userId: string;
  email?: string;
  /**
   * The session the token belongs to: the id of the auth routes kit's
   * `SessionStore` entry, which `socketAuth` checks on every handshake.
   */
  sid?: string;
  exp?: number;
  iat?: number;
}

const DEFAULT_EXPIRATION = "7d";

/**
 * Create a JWT token for authentication.
 *
 * @param payload - The payload to encode in the JWT
 * @param secret - The secret key for signing
 * @param expiresIn - When it expires: a time span from now, as jose reads
 *   one ("7d", "1h"; default 7 days), counted from the current whole second,
 *   or the time itself, in seconds since the epoch
 */
export async function createJWT(
  payload: Omit<JWTPayload, "exp" | "iat">,
  secret: string,
  expiresIn: string | number = DEFAULT_EXPIRATION,
): Promise<string> {
  const secretKey = new TextEncoder().encode(secret);

  const jwt = await new jose.SignJWT(payload as jose.JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secretKey);

  return jwt;
}

/**
 * The token's payload when its signature and expiry verify with `secret`,
 * or `null`: `verifyJWT` without its warning, for the kit's own reads, which
 * check the session store themselves (`liveSession`, the logout route,
 * `createRequireAuth`).
 */
export async function readVerifiedJWT(token: string, secret: string): Promise<JWTPayload | null> {
  try {
    const secretKey = new TextEncoder().encode(secret);
    const { payload } = await jose.jwtVerify(token, secretKey);

    return {
      userId: payload.userId as string,
      email: payload.email as string | undefined,
      ...(typeof payload.sid === "string" && { sid: payload.sid }),
      exp: payload.exp,
      iat: payload.iat,
    };
  } catch {
    return null;
  }
}

/** Whether `verifyJWT` already warned, in this process, that it checks no session store. */
let warnedSessionToken = false;

/**
 * Verify and decode a JWT token: its signature and expiry, nothing more.
 * It is never a session check: a token of a session that was signed out,
 * logged out everywhere or revoked still verifies until the JWT expires (7
 * days by default). Check a session token with `liveSession({ sessions,
 * jwtSecret }, token)`, `bearerAuth(...)` or `socketAuth(...)`, which ask the
 * session store on every call. In development it warns once per process
 * when it verifies a token that carries a session (`sid`).
 *
 * @param token - The JWT token to verify
 * @param secret - The secret key for verification
 * @returns The decoded payload, or null if invalid
 */
export async function verifyJWT(token: string, secret: string): Promise<JWTPayload | null> {
  const payload = await readVerifiedJWT(token, secret);
  if (payload?.sid !== undefined && process.env.NODE_ENV !== "production" && !warnedSessionToken) {
    warnedSessionToken = true;
    consoleLogger.warn(
      "[quickdraw] verifyJWT verified a session token (it carries sid): verifyJWT checks the signature and expiry only, never the session store, so a signed-out or revoked session still passes. Check session tokens with liveSession({ sessions, jwtSecret }, token), bearerAuth(...) or socketAuth(...).",
    );
  }
  return payload;
}
