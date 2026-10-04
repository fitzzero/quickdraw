// A signed-in session's credential: a JWT naming its user and its session
// (`sid`), signed with the app's secret, valid only while the app's
// `SessionStore` still holds that session for that user and the session has
// not expired. The routes issue it at sign-in, and the routes and
// `socketAuth` read it back with `liveSession`. Both are exported for an
// app's own sign-in flows (login codes, an embedded activity), so the
// sessions they start work with `socketAuth` like the routes' own.

import { createJWT, verifyJWT } from "../jwt";
import type { AuthSession, SessionMeta, SessionStore } from "./sessions";

/** The shortest `jwtSecret` the kit accepts: HS256 wants a key of 256 bits or more. */
export const MIN_JWT_SECRET_LENGTH = 32;

/** The default session lifetime: 7 days, the 4.1 JWT and cookie default. */
export const DEFAULT_SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Where sessions are stored, and the secret their JWTs are signed with. */
export interface SessionKeys {
  readonly sessions: SessionStore;
  readonly jwtSecret: string;
}

/** Throws a `TypeError` naming `owner` unless `keys` holds a usable store and secret. */
export function checkSessionKeys(keys: Partial<SessionKeys>, owner: string): SessionKeys {
  const { sessions, jwtSecret } = keys;
  const store = (sessions ?? {}) as Partial<Record<keyof SessionStore, unknown>>;
  const methods = ["create", "get", "revoke", "revokeAll"] as const;
  if (sessions === undefined || !methods.every((name) => typeof store[name] === "function")) {
    throw new TypeError(
      `${owner}: sessions must be a SessionStore (create, get, revoke, revokeAll)`,
    );
  }
  if (typeof jwtSecret !== "string" || jwtSecret.length < MIN_JWT_SECRET_LENGTH) {
    throw new TypeError(
      `${owner}: jwtSecret must be a secret of at least ${MIN_JWT_SECRET_LENGTH} characters`,
    );
  }
  return { sessions, jwtSecret };
}

/** A new session, stored, and its JWT, which expires with it. */
export interface IssuedSession {
  readonly session: AuthSession;
  readonly token: string;
}

/**
 * Starts a session for `userId`: creates it in the store, lasting `ttlMs`
 * (default 7 days), and signs its JWT. Send the token as the session cookie
 * (`setSessionCookie`) or give it to a cookie-less client for `auth.token`.
 * Throws when the store does not return the session it created.
 */
export async function issueSession(
  keys: SessionKeys,
  userId: string,
  meta: Omit<SessionMeta, "expiresAt">,
  ttlMs: number = DEFAULT_SESSION_TTL_MS,
): Promise<IssuedSession> {
  checkSessionKeys(keys, "issueSession");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1000) {
    throw new TypeError("issueSession: ttlMs must be a whole number of milliseconds, 1000 or more");
  }
  const expiresAt = new Date(Date.now() + ttlMs);
  const session: Partial<AuthSession> | null | undefined = await keys.sessions.create(userId, {
    ...meta,
    expiresAt,
  });
  if (typeof session?.id !== "string" || session.id === "" || session.userId !== userId) {
    throw new TypeError("SessionStore.create must return the session it created, with its id");
  }
  const seconds = Math.max(1, Math.ceil(ttlMs / 1000));
  const token = await createJWT({ userId, sid: session.id }, keys.jwtSecret, `${seconds}s`);
  return { session: session as AuthSession, token };
}

/**
 * The live session `token` stands for, or `null`: the JWT verifies with the
 * secret and has not expired, names a session, and the store still holds
 * that session, for the token's user, before its `expiresAt`.
 */
export async function liveSession(keys: SessionKeys, token: string): Promise<AuthSession | null> {
  checkSessionKeys(keys, "liveSession");
  const payload = await verifyJWT(token, keys.jwtSecret);
  if (
    payload === null ||
    typeof payload.userId !== "string" ||
    payload.userId === "" ||
    payload.sid === undefined
  ) {
    return null;
  }
  const session = await keys.sessions.get(payload.sid);
  if (session === null || session === undefined || session.userId !== payload.userId) {
    return null;
  }
  // A store may return the expiry as a string or a number; an invalid date is refused.
  const expiresAt = new Date(session.expiresAt).getTime();
  return expiresAt > Date.now() ? session : null;
}
