// `bearerAuth`: a bearer token checked against the session store on every
// call. No token is anonymous; a token whose session was revoked, logged out
// everywhere or has expired, and a JWT without a session, are refused at
// once (the 5.1 audit's AUTH-1: `verifyJWT` alone let them through until the
// JWT expired); a live one is its user's principal.

import { afterEach, describe, expect, it, vi } from "vitest";
import { createJWT } from "../jwt";
import { bearerAuth } from "./bearerAuth";
import { createMemorySessionStore } from "./sessions";
import { issueSession } from "./tokens";

const SECRET = "a-test-secret-of-at-least-thirty-two-characters";

afterEach(() => {
  vi.useRealTimers();
});

const REFUSED = { code: "UNAUTHENTICATED" };

describe("bearerAuth", () => {
  it("is anonymous without a token", async () => {
    const verify = bearerAuth({ sessions: createMemorySessionStore(), jwtSecret: SECRET });
    for (const token of [null, undefined, "", 42]) {
      expect(await verify(token), String(token)).toBeNull();
    }
  });

  it("signs a live session's token in, as its user or as loadPrincipal builds them", async () => {
    const sessions = createMemorySessionStore();
    const { token } = await issueSession({ sessions, jwtSecret: SECRET }, "alice", {
      provider: "test",
    });
    expect(await bearerAuth({ sessions, jwtSecret: SECRET })(token)).toEqual({
      userId: "alice",
      kind: "user",
    });
    const agents = bearerAuth({
      sessions,
      jwtSecret: SECRET,
      loadPrincipal: (userId) => ({ userId, kind: "agent" as const }),
    });
    expect(await agents(token)).toEqual({ userId: "alice", kind: "agent" });
  });

  it("refuses a revoked session, every session after revokeAll, and a JWT without one", async () => {
    const sessions = createMemorySessionStore();
    const keys = { sessions, jwtSecret: SECRET };
    const verify = bearerAuth(keys);
    const first = await issueSession(keys, "alice", { provider: "test" });
    const second = await issueSession(keys, "alice", { provider: "test" });
    await sessions.revoke(first.session.id);
    await expect(verify(first.token)).rejects.toMatchObject(REFUSED);
    expect(await verify(second.token)).toMatchObject({ userId: "alice" });
    await sessions.revokeAll("alice");
    await expect(verify(second.token)).rejects.toMatchObject(REFUSED);
    await expect(verify(await createJWT({ userId: "alice" }, SECRET))).rejects.toMatchObject(
      REFUSED,
    );
    await expect(verify("not-a-jwt")).rejects.toMatchObject(REFUSED);
  });

  it("refuses a session once it has expired", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const sessions = createMemorySessionStore();
    const keys = { sessions, jwtSecret: SECRET };
    const { token } = await issueSession(keys, "alice", { provider: "test" }, 1000);
    expect(await bearerAuth(keys)(token)).toMatchObject({ userId: "alice" });
    vi.setSystemTime(Date.now() + 2000);
    await expect(bearerAuth(keys)(token)).rejects.toMatchObject(REFUSED);
  });

  it("refuses a session whose user has no principal, and throws for another user's", async () => {
    const sessions = createMemorySessionStore();
    const keys = { sessions, jwtSecret: SECRET };
    const { token } = await issueSession(keys, "alice", { provider: "test" });
    await expect(bearerAuth({ ...keys, loadPrincipal: () => null })(token)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
      message: "The session's user has no principal",
    });
    await expect(
      bearerAuth({ ...keys, loadPrincipal: () => ({ userId: "mallory" }) })(token),
    ).rejects.toThrow(
      new TypeError("bearerAuth: loadPrincipal must return the principal of the session's user"),
    );
  });

  it("checks its options when it is made", () => {
    const sessions = createMemorySessionStore();
    expect(() => bearerAuth({ sessions, jwtSecret: "ten-chars!" })).toThrow(
      "bearerAuth: jwtSecret must be a secret of at least 32 characters",
    );
    expect(() => bearerAuth({ sessions: {} as never, jwtSecret: SECRET })).toThrow(
      "bearerAuth: sessions must be a SessionStore",
    );
    expect(() => bearerAuth({ sessions, jwtSecret: SECRET, loadPrincipal: 1 as never })).toThrow(
      "bearerAuth: loadPrincipal must be a function",
    );
  });
});
