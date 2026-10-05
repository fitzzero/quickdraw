// `requireSession(keys)` (finding F2.11): an app's own REST route behind the
// auth routes kit's sessions, read the way `GET /auth/me` reads them, the JWT
// verified once, a revoked session refused at once; the principal it builds,
// which `sessionOf(req)` hands the route typed (F5.4); and the route calling a
// service in process as that principal, with its grants loaded (F5.1).

import express from "express";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract, httpStatus, mutation, query, toWire } from "../../../index";
import { captureLogger, db, type AppPrincipal } from "../../__tests__/fixtures";
import { initQuickdraw } from "../../init";
import { verifyJWT } from "../jwt";
import { APP_ORIGIN, authHarness, get, post, SECRET, signIn, userIdOf } from "./__tests__/harness";
import {
  requireSession,
  sessionOf,
  type RequestSession,
  type SessionRequest,
} from "./requireSession";
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
    expect(() =>
      requireSession(
        { sessions: createMemorySessionStore(), jwtSecret: SECRET },
        { loadPrincipal: "nobody" as never },
      ),
    ).toThrow("requireSession: loadPrincipal must be a function");
  });

  it("gives the route its user, session and principal through sessionOf, typed (finding F5.4)", async () => {
    let keys: tokens.SessionKeys | undefined;
    const seen: RequestSession<AppPrincipal>[] = [];
    const booted = await harness.boot({}, () => {
      const app = express();
      app.get(
        "/api/me",
        (req, res, next) => {
          const loadPrincipal = (userId: string): AppPrincipal | null =>
            userId === userIdOf("bob@demo.local") ? null : { userId, kind: "agent" };
          const signedIn = requireSession(keys ?? stubKeys(), { loadPrincipal });
          signedIn(req, res, next);
        },
        (req, res) => {
          const session = sessionOf<AppPrincipal>(req);
          seen.push(session);
          const { userId, sessionId, principal } = req as SessionRequest<AppPrincipal>;
          res.json({ same: session.principal === principal, userId, sessionId });
        },
      );
      return app;
    });
    keys = { sessions: booted.sessions, jwtSecret: SECRET };
    const { session } = await signIn(booted.url, "ada@demo.local");
    const answer = await get(`${booted.url}/api/me`, session);
    expect(await answer.json()).toEqual({
      same: true,
      userId: userIdOf("ada@demo.local"),
      sessionId: seen[0]?.sessionId,
    });
    expect(seen[0]).toEqual({
      userId: userIdOf("ada@demo.local"),
      sessionId: expect.any(String),
      principal: { userId: userIdOf("ada@demo.local"), kind: "agent" },
    });
    // A user loadPrincipal has no principal for is refused, as socketAuth refuses the socket.
    const refused = await get(
      `${booted.url}/api/me`,
      (await signIn(booted.url, "bob@demo.local")).session,
    );
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({
      error: "UNAUTHENTICATED",
      message: "The session's user has no principal",
    });
    expect(() => sessionOf({})).toThrow(
      "sessionOf: no requireSession let this request through; mount requireSession(keys) before the route",
    );
  });

  it('builds { userId, kind: "user" } without loadPrincipal, and refuses one that names another user', async () => {
    let keys: tokens.SessionKeys | undefined;
    const booted = await harness.boot({}, () => {
      const app = express();
      app.get(
        "/api/me",
        (req, res, next) => {
          requireSession(keys ?? stubKeys())(req, res, next);
        },
        (req, res) => {
          res.json(sessionOf(req).principal);
        },
      );
      app.get(
        "/api/other",
        (req, res, next) => {
          requireSession(keys ?? stubKeys(), {
            loadPrincipal: (): AppPrincipal => ({ userId: "someone-else", kind: "user" }),
          })(req, res, next);
        },
        (_req, res) => {
          res.json({});
        },
      );
      app.use(
        (
          error: unknown,
          _req: express.Request,
          res: express.Response,
          _next: express.NextFunction,
        ) => {
          res.status(500).json({ message: error instanceof Error ? error.message : "" });
        },
      );
      return app;
    });
    keys = { sessions: booted.sessions, jwtSecret: SECRET };
    const { session } = await signIn(booted.url, "ada@demo.local");
    expect(await (await get(`${booted.url}/api/me`, session)).json()).toEqual({
      userId: userIdOf("ada@demo.local"),
      kind: "user",
    });
    const other = await get(`${booted.url}/api/other`, session);
    expect(other.status).toBe(500);
    expect(await other.json()).toEqual({
      message: "requireSession: loadPrincipal must return the principal of the session's user",
    });
  });
});

describe("the session cookie's Origin (finding F8.5, and the final review of the release candidates)", () => {
  /** An app whose `POST /api/items/delete` takes a form body, behind `requireSession(keys, options)`. */
  function formApp(
    keys: () => tokens.SessionKeys,
    options: Parameters<typeof requireSession>[1] = {},
    acted: unknown[] = [],
  ) {
    const app = express();
    app.post(
      "/api/items/delete",
      express.urlencoded({ extended: false }),
      (req, res, next) => {
        requireSession(keys(), options)(req as SessionRequest, res, next);
      },
      (req, res) => {
        acted.push(sessionOf(req).userId);
        res.json({ deleted: true });
      },
    );
    return app;
  }

  async function bootForm(options: Parameters<typeof requireSession>[1] = {}) {
    let keys: tokens.SessionKeys | undefined;
    const acted: unknown[] = [];
    const booted = await harness.boot({}, () =>
      formApp(
        () => keys ?? { sessions: createMemorySessionStore(), jwtSecret: SECRET },
        options,
        acted,
      ),
    );
    keys = { sessions: booted.sessions, jwtSecret: SECRET };
    const { session } = await signIn(booted.url, "ada@demo.local");
    const send = (headers: Record<string, string>) =>
      fetch(`${booted.url}/api/items/delete`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: "id=item-1",
      });
    return { booted, session, send, acted };
  }

  it("refuses a cross-site form POST with the cookie, and lets the app's own pages through", async () => {
    const { session, send, acted } = await bootForm();
    // The review's reproduction: another site's form, the user's cookie riding along.
    const forged = await send({
      cookie: session,
      origin: "http://evil.example",
      "sec-fetch-site": "cross-site",
    });
    expect(forged.status).toBe(403);
    expect(await forged.json()).toEqual({
      error: "FORBIDDEN",
      message:
        "This page's origin may not use the session cookie; send it from an allowed origin or use a bearer token",
    });
    expect(acted).toEqual([]);
    // The routes' allowlist applies: the app's origin, and a pattern of it.
    expect((await send({ cookie: session, origin: APP_ORIGIN })).status).toBe(200);
    expect((await send({ cookie: session, origin: "http://pr.preview.test" })).status).toBe(200);
    // No Origin: curl, or a server forwarding the cookie, unless the browser says another site sent it.
    expect((await send({ cookie: session })).status).toBe(200);
    expect((await send({ cookie: session, "sec-fetch-site": "same-site" })).status).toBe(403);
    expect((await send({ cookie: session, origin: "null" })).status).toBe(403);
    // A bearer token is not ambient: no Origin check.
    const token = session.slice("session=".length);
    const bearer = await send({ authorization: `Bearer ${token}`, origin: "http://evil.example" });
    expect(bearer.status).toBe(200);
    expect(acted).toEqual(Array.from({ length: 4 }, () => userIdOf("ada@demo.local")));
  });

  it("takes allowedOrigins of its own, and with none and no routes on its store lets no page use the cookie", async () => {
    const own = await bootForm({ allowedOrigins: ["http://admin.test"] });
    expect((await own.send({ cookie: own.session, origin: "http://admin.test" })).status).toBe(200);
    expect((await own.send({ cookie: own.session, origin: APP_ORIGIN })).status).toBe(403);
    // A store no createAuthRoutes writes to: no list to default to.
    const sessions = createMemorySessionStore();
    const { issueSession } = await import("./tokens");
    const issued = await issueSession({ sessions, jwtSecret: SECRET }, "ada", { provider: "mock" });
    const app = formApp(() => ({ sessions, jwtSecret: SECRET }));
    const booted = await harness.boot({}, () => app);
    const send = (headers: Record<string, string>) =>
      fetch(`${booted.url}/api/items/delete`, {
        method: "POST",
        headers: {
          cookie: `session=${issued.token}`,
          "content-type": "application/json",
          ...headers,
        },
        body: "{}",
      });
    expect((await send({ origin: APP_ORIGIN })).status).toBe(403);
    expect((await send({})).status).toBe(200);
  });
});

describe("cookieOriginAllowed", () => {
  it("applies socketAuth's rule: an HTTP request's and a socket handshake's", async () => {
    const { cookieOriginAllowed } = await import("./socketAuth");
    const allowed = [APP_ORIGIN] as const;
    const http = (headers: Record<string, string>) => cookieOriginAllowed({ headers }, allowed);
    const socket = (headers: Record<string, string>, allowMissingOrigin = false) =>
      cookieOriginAllowed({ headers, transport: "socket" }, allowed, { allowMissingOrigin });
    expect(http({ origin: APP_ORIGIN })).toBe(true);
    expect(http({ origin: "http://evil.example" })).toBe(false);
    expect(http({})).toBe(true);
    expect(http({ "sec-fetch-site": "same-origin" })).toBe(true);
    expect(http({ "sec-fetch-site": "cross-site" })).toBe(false);
    expect(socket({ origin: APP_ORIGIN })).toBe(true);
    expect(socket({})).toBe(false);
    expect(socket({}, true)).toBe(true);
    expect(socket({ "sec-fetch-site": "same-origin" })).toBe(true);
    expect(() => cookieOriginAllowed({ headers: {} }, ["not an origin"])).toThrow(
      "cookieOriginAllowed: allowedOrigins entries are origins",
    );
  });
});

describe("a REST route calling a service in process (finding F5.1)", () => {
  const reports = defineContract("reportService", {
    methods: {
      summary: query({
        input: z.undefined(),
        output: z.object({
          userId: z.string(),
          grants: z.record(z.string(), z.string()).nullable(),
        }),
      }),
      purge: mutation({ input: z.undefined(), output: z.null() }),
    },
  });

  /** The app's types name the reports contract, so `app.caller` is typed. */
  const app = initQuickdraw<{
    db: typeof db;
    principal: AppPrincipal;
    contracts: { reports: typeof reports };
  }>();

  it("calls as the session's principal, with the grants a socket of the same user gets", async () => {
    const reportService = app.defineService(reports, {
      methods: {
        summary: {
          access: { service: "Read" },
          handler: ({ ctx }) => ({
            userId: ctx.principal.userId,
            grants: ctx.principal.serviceAccess ?? null,
          }),
        },
        purge: { access: { service: "Admin" }, handler: () => null },
      },
    });
    // Every user starts with Read on the reports, as an app's default grants give
    // (quickdraw-chat's SERVICE_DEFAULT_ACCESS): only the loader knows it.
    const server = app.createServer({
      services: [reportService],
      db,
      logger: captureLogger(),
      auth: { loadServiceAccess: () => ({ reportService: "Read" }) },
    });
    let keys: tokens.SessionKeys | undefined;
    const booted = await harness.boot({}, () => {
      const routes = express();
      routes.post(
        "/api/reports/:method",
        (req, res, next) => {
          requireSession(keys ?? stubKeys())(req, res, next);
        },
        (req, res) => {
          void (async () => {
            const caller = app.caller(sessionOf<AppPrincipal>(req).principal).reportService;
            try {
              res.json(
                req.params.method === "purge" ? await caller.purge() : await caller.summary(),
              );
            } catch (error) {
              const failure = toWire(error);
              res.status(httpStatus(failure.code)).json(failure);
            }
          })();
        },
      );
      return routes;
    });
    try {
      keys = { sessions: booted.sessions, jwtSecret: SECRET };
      const { session } = await signIn(booted.url, "ada@demo.local");
      const summary = await post(`${booted.url}/api/reports/summary`, { cookie: session });
      expect(summary.status).toBe(200);
      expect(await summary.json()).toEqual({
        userId: userIdOf("ada@demo.local"),
        grants: { reportService: "Read" },
      });
      // A grant the user lacks is refused as over a socket.
      const purge = await post(`${booted.url}/api/reports/purge`, { cookie: session });
      expect(purge.status).toBe(403);
      expect(await purge.json()).toMatchObject({ code: "FORBIDDEN" });
      expect((await post(`${booted.url}/api/reports/summary`)).status).toBe(401);
    } finally {
      await server.close();
    }
  });
});

/** Keys for the moment an app is built, before the harness made its store. */
function stubKeys(): tokens.SessionKeys {
  return { sessions: createMemorySessionStore(), jwtSecret: SECRET };
}
