// The session store seam and the session JWT: the in-memory store, issuing
// a session, and reading a token back only while its session is live.

import * as jose from "jose";
import { describe, expect, it } from "vitest";
import { verifyJWT } from "../jwt";
import { createMemorySessionStore, type SessionStore } from "./sessions";
import { DEFAULT_SESSION_TTL_MS, issueSession, liveSession } from "./tokens";

const SECRET = "a-test-secret-of-at-least-thirty-two-characters";

describe("createMemorySessionStore", () => {
  it("creates, gets, revokes one session or every session of a user, and drops expired ones", () => {
    const store = createMemorySessionStore();
    const later = new Date(Date.now() + 60_000);
    const a1 = store.create("a", { provider: "mock", expiresAt: later });
    const a2 = store.create("a", { provider: "google", expiresAt: later });
    const b1 = store.create("b", { provider: "guest", expiresAt: later });
    expect(a1).toEqual({ id: expect.any(String), userId: "a", expiresAt: later });
    expect(new Set([a1.id, a2.id, b1.id]).size).toBe(3);
    expect(store.get(a1.id)).toBe(a1);
    expect(store.get("missing")).toBeNull();
    expect(store.get("__proto__")).toBeNull();

    store.revoke(a1.id);
    expect(store.get(a1.id)).toBeNull();
    store.revokeAll("a");
    expect([store.get(a2.id), store.get(b1.id)]).toEqual([null, b1]);

    store.create("c", { provider: "mock", expiresAt: new Date(Date.now() - 1) });
    expect(store.size).toBe(2);
    store.create("d", { provider: "mock", expiresAt: later });
    expect(store.size).toBe(2);
  });
});

describe("issueSession and liveSession", () => {
  it("stores a session and signs a JWT naming it, expiring with it", async () => {
    const sessions = createMemorySessionStore();
    const keys = { sessions, jwtSecret: SECRET };
    const { session, token } = await issueSession(keys, "ada", { provider: "mock", ip: "1.2.3.4" });
    expect(session.expiresAt.getTime() - Date.now()).toBeGreaterThan(DEFAULT_SESSION_TTL_MS - 5000);
    const payload = await verifyJWT(token, SECRET);
    expect(payload).toMatchObject({ userId: "ada", sid: session.id });
    expect((payload?.exp ?? 0) - (payload?.iat ?? 0)).toBe(DEFAULT_SESSION_TTL_MS / 1000);
    expect(await liveSession(keys, token)).toBe(session);
    await sessions.revoke(session.id);
    expect(await liveSession(keys, token)).toBeNull();
  });

  it("refuses a store that does not return the session it created, and a short lifetime", async () => {
    const broken: SessionStore = {
      create: () => ({ id: "", userId: "ada", expiresAt: new Date() }),
      get: () => null,
      revoke: () => undefined,
      revokeAll: () => undefined,
    };
    await expect(
      issueSession({ sessions: broken, jwtSecret: SECRET }, "ada", { provider: "mock" }),
    ).rejects.toThrow("SessionStore.create must return the session it created, with its id");
    const keys = { sessions: createMemorySessionStore(), jwtSecret: SECRET };
    await expect(issueSession(keys, "ada", { provider: "mock" }, 10)).rejects.toThrow(
      "issueSession: ttlMs must be a whole number of milliseconds, 1000 or more",
    );
    await expect(
      issueSession({ ...keys, jwtSecret: "short" }, "ada", { provider: "x" }),
    ).rejects.toThrow("issueSession: jwtSecret must be a secret of at least 32 characters");
  });

  it("reads a store's expiry as a string, and refuses an invalid one", async () => {
    const expiresAt: unknown[] = [new Date(Date.now() + 60_000).toISOString(), "not a date"];
    const sessions: SessionStore = {
      create: (userId) => ({ id: "s1", userId, expiresAt: new Date() }),
      get: () => ({ id: "s1", userId: "ada", expiresAt: expiresAt.shift() as Date }),
      revoke: () => undefined,
      revokeAll: () => undefined,
    };
    const keys = { sessions, jwtSecret: SECRET };
    const { token } = await issueSession(keys, "ada", { provider: "mock" });
    expect(await liveSession(keys, token)).toMatchObject({ id: "s1" });
    expect(await liveSession(keys, token)).toBeNull();
  });

  it("refuses a token without a session id, and a JWT whose algorithm is none", async () => {
    const keys = { sessions: createMemorySessionStore(), jwtSecret: SECRET };
    const { session } = await issueSession(keys, "ada", { provider: "mock" });
    const unsigned = new jose.UnsecuredJWT({ userId: "ada", sid: session.id })
      .setIssuedAt()
      .setExpirationTime("1h")
      .encode();
    expect(await liveSession(keys, unsigned)).toBeNull();
    const noSid = await new jose.SignJWT({ userId: "ada" })
      .setProtectedHeader({ alg: "HS256" })
      .setExpirationTime("1h")
      .sign(new TextEncoder().encode(SECRET));
    expect(await liveSession(keys, noSid)).toBeNull();
  });
});
