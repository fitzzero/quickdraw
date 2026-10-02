// @vitest-environment node
import { describe, expect, it } from "vitest";
import { createJWT } from "./jwt";
import {
  createRequireAuth,
  extractBearerOrCookieToken,
  type AuthRequest,
  type AuthResponse,
} from "./restMiddleware";

const SECRET = "test-secret";

function createFakeResponse(): {
  res: AuthResponse;
  state: { status?: number; body?: unknown };
} {
  const state: { status?: number; body?: unknown } = {};
  const res: AuthResponse = {
    status(code) {
      state.status = code;
      return {
        json(body) {
          state.body = body;
          return body;
        },
      };
    },
  };
  return { res, state };
}

async function run(
  req: AuthRequest,
  getSession: (token: string) => Promise<{ expiresAt: Date } | null>,
): Promise<{ status?: number; nextCalled: boolean; userId?: string }> {
  const middleware = createRequireAuth({ getSession, jwtSecret: SECRET });
  const { res, state } = createFakeResponse();
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });
  return { status: state.status, nextCalled, userId: req.userId };
}

const futureSession = async (): Promise<{ expiresAt: Date }> => ({
  expiresAt: new Date(Date.now() + 60_000),
});

describe("extractBearerOrCookieToken", () => {
  it("prefers the session cookie over the Authorization header", () => {
    const req: AuthRequest = {
      cookies: { session: "cookie-token" },
      headers: { authorization: "Bearer header-token" },
    };
    expect(extractBearerOrCookieToken(req)).toBe("cookie-token");
  });

  it("falls back to Bearer token, then null", () => {
    expect(extractBearerOrCookieToken({ headers: { authorization: "Bearer header-token" } })).toBe(
      "header-token",
    );
    expect(extractBearerOrCookieToken({ headers: {} })).toBeNull();
  });
});

describe("createRequireAuth", () => {
  it("rejects requests without a token", async () => {
    const result = await run({ headers: {} }, futureSession);
    expect(result.status).toBe(401);
    expect(result.nextCalled).toBe(false);
  });

  it("rejects invalid JWTs", async () => {
    const result = await run({ headers: { authorization: "Bearer not-a-jwt" } }, futureSession);
    expect(result.status).toBe(401);
  });

  it("rejects valid JWTs whose session is missing or expired", async () => {
    const jwt = await createJWT({ userId: "user-1" }, SECRET);

    const missing = await run({ headers: { authorization: `Bearer ${jwt}` } }, async () => null);
    expect(missing.status).toBe(401);

    const expired = await run({ headers: { authorization: `Bearer ${jwt}` } }, async () => ({
      expiresAt: new Date(Date.now() - 1000),
    }));
    expect(expired.status).toBe(401);
  });

  it("attaches userId and calls next on success", async () => {
    const jwt = await createJWT({ userId: "user-1" }, SECRET);
    const result = await run({ headers: { authorization: `Bearer ${jwt}` } }, futureSession);
    expect(result.nextCalled).toBe(true);
    expect(result.userId).toBe("user-1");
  });

  it("authenticates via the session cookie", async () => {
    const jwt = await createJWT({ userId: "user-2" }, SECRET);
    const result = await run({ cookies: { session: jwt }, headers: {} }, futureSession);
    expect(result.nextCalled).toBe(true);
    expect(result.userId).toBe("user-2");
  });
});
