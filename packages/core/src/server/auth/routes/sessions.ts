// Where signed-in sessions live (RFC 0003 section 12.6). The app owns the
// store: `createAuthRoutes` creates a session at each sign-in and revokes it
// at logout, and `socketAuth` reads it on every handshake, so a revoked
// session stops authenticating at once, even while its JWT has not expired.
// `createMemorySessionStore` is for development and tests; an app keeps its
// sessions in its database (the README has a Prisma store).

import { randomUUID } from "node:crypto";
import type { MaybePromise } from "../../types";

/** A session as the store keeps it. A store's own rows may carry more fields. */
export interface AuthSession {
  /** The session's id. The session's JWT names it in its `sid` claim. */
  readonly id: string;
  /** The user the session signs in. */
  readonly userId: string;
  /** When the session ends. The kit refuses it afterwards, whatever the store answers. */
  readonly expiresAt: Date;
}

/** What the kit tells the store about a session it asks it to create. */
export interface SessionMeta {
  /** How the user signed in: a provider's id (`"google"`, `"discord"`, `"mock"`) or `"guest"`. */
  readonly provider: string;
  /** When the session ends. Its JWT and its cookie end then too. */
  readonly expiresAt: Date;
  /** The sign-in request's `User-Agent`, for a list of where the user is signed in. */
  readonly userAgent?: string;
  /** The sign-in request's IP address as Express reports it (`req.ip`), for the same. */
  readonly ip?: string;
}

/**
 * The app's session storage. `get` answers `null` (or `undefined`) for a
 * session that does not exist or was revoked; after `revoke(id)` or
 * `revokeAll(userId)`, `get` must answer `null` for those sessions. What
 * `revoke` and `revokeAll` return is ignored.
 */
export interface SessionStore {
  /** Stores a new session for `userId` and returns it, with the id the store gave it. */
  create(userId: string, meta: SessionMeta): MaybePromise<AuthSession>;
  get(sessionId: string): MaybePromise<AuthSession | null | undefined>;
  revoke(sessionId: string): MaybePromise<unknown>;
  revokeAll(userId: string): MaybePromise<unknown>;
}

/** The in-memory store: a synchronous {@link SessionStore}, plus a count for tests. */
export interface MemorySessionStore extends SessionStore {
  create(userId: string, meta: SessionMeta): AuthSession;
  get(sessionId: string): AuthSession | null;
  revoke(sessionId: string): void;
  revokeAll(userId: string): void;
  /** How many sessions it holds, expired ones included until the next `create` drops them. */
  readonly size: number;
}

/**
 * A {@link SessionStore} in this process's memory, for development and
 * tests. Its sessions are lost on restart and are not shared between
 * processes, so production apps store them in their database.
 */
export function createMemorySessionStore(): MemorySessionStore {
  const sessions = new Map<string, AuthSession>();
  const dropExpired = (now: number): void => {
    for (const [id, session] of sessions) {
      if (session.expiresAt.getTime() <= now) {
        sessions.delete(id);
      }
    }
  };
  return {
    create(userId, meta) {
      dropExpired(Date.now());
      const session = Object.freeze({ id: randomUUID(), userId, expiresAt: meta.expiresAt });
      sessions.set(session.id, session);
      return session;
    },
    get: (sessionId) => sessions.get(sessionId) ?? null,
    revoke(sessionId) {
      sessions.delete(sessionId);
    },
    revokeAll(userId) {
      for (const [id, session] of sessions) {
        if (session.userId === userId) {
          sessions.delete(id);
        }
      }
    },
    get size() {
      return sessions.size;
    },
  };
}
