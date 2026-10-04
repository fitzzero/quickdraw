// `requireSession(keys)` (finding F2.11): an app's own REST route behind the
// auth routes kit's sessions, read the way `GET /auth/me` reads them, the JWT
// verified once, a revoked session refused at once.

import express from "express";
import { describe, expect, it, vi } from "vitest";
import { verifyJWT } from "../jwt";
import { authHarness, get, post, SECRET, signIn, userIdOf } from "./__tests__/harness";
import { requireSession, type SessionRequest } from "./requireSession";
import { createMemorySessionStore } from "./sessions";
import type * as tokens from "./tokens";

// Counts the JWT verifications: requireSession makes one per request.
vi.mock("../jwt", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../jwt")>();
  return { ...actual, verifyJWT: vi.fn(actual.verifyJWT) };
});

const harness = authHarness();

/** An app whose `GET /api/me` answers the user and session `requireSession` found. */
function appWith(keys: () => tokens.SessionKeys) {
  const app = express();
  app.get(
    "/api/me",
    (req, res, next) => {
      requireSession(keys())(req as SessionRequest, res, next);
    },
    (req, res) => {
      const { userId, sessionId } = req as SessionRequest;
      res.json({ userId, sessionId });
    },
  );
  return app;
}

describe("requireSession", () => {
  it("lets a live session through by its cookie or a bearer token, and refuses it once revoked", async () => {
    let keys: tokens.SessionKeys | undefined;
    const booted = await harness.boot({}, () =>
      appWith(() => keys ?? { sessions: createMemorySessionStore(), jwtSecret: SECRET }),
    );
    keys = { sessions: booted.sessions, jwtSecret: SECRET };
    const { session } = await signIn(booted.url, "ada@demo.local");
    const token = session.slice("session=".length);
    const viaCookie = await get(`${booted.url}/api/me`, session);
    expect(viaCookie.status).toBe(200);
    expect(await viaCookie.json()).toEqual({
      userId: userIdOf("ada@demo.local"),
      sessionId: expect.any(String),
    });
    const viaBearer = await get(`${booted.url}/api/me`, undefined, {
      authorization: `Bearer ${token}`,
    });
    expect(await viaBearer.json()).toMatchObject({ userId: userIdOf("ada@demo.local") });
    await post(`${booted.url}/auth/logout`, { cookie: session });
    const revoked = await get(`${booted.url}/api/me`, session);
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toEqual({ error: "UNAUTHENTICATED", message: "Not signed in" });
    expect((await get(`${booted.url}/api/me`)).status).toBe(401);
  });

  it("verifies the JWT once per request, and reads the store once", async () => {
    let keys: tokens.SessionKeys | undefined;
    const booted = await harness.boot({}, () =>
      appWith(() => keys ?? { sessions: createMemorySessionStore(), jwtSecret: SECRET }),
    );
    keys = { sessions: booted.sessions, jwtSecret: SECRET };
    const { session } = await signIn(booted.url, "bob@demo.local");
    const reads = vi.spyOn(booted.sessions, "get");
    vi.mocked(verifyJWT).mockClear();
    expect((await get(`${booted.url}/api/me`, session)).status).toBe(200);
    expect(vi.mocked(verifyJWT)).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenCalledTimes(1);
  });

  it("hands a failing store to next(error)", async () => {
    const failing = createMemorySessionStore();
    const keys = { sessions: { ...failing, get: () => Promise.reject(new Error("store down")) } };
    const app = express();
    app.get(
      "/api/me",
      requireSession({ ...keys, jwtSecret: SECRET }) as express.RequestHandler,
      (_req, res) => {
        res.json({});
      },
    );
    let seen: unknown;
    app.use(
      (
        error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        seen = error;
        res.status(503).end();
      },
    );
    const booted = await harness.boot({}, () => app);
    const { session } = await signIn(booted.url, "ada@demo.local");
    expect((await get(`${booted.url}/api/me`, session)).status).toBe(503);
    expect(seen).toMatchObject({ message: "store down" });
  });

  it("checks its keys", () => {
    expect(() =>
      requireSession({ sessions: createMemorySessionStore(), jwtSecret: "short" }),
    ).toThrow("requireSession: jwtSecret must be a secret of at least 32 characters");
  });
});
