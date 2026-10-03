// `socketAuth` (RFC 0003 section 12.6) as `createServer`'s `authenticate`,
// over a real server whose Express app also serves the auth routes: sockets
// and HTTP calls authenticated by the session the routes issue, refused once
// it is revoked, and the Origin check on cookie-authenticated handshakes.

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract, isAuthenticationRefused, query } from "../../../index";
import { captureLogger, type AppPrincipal } from "../../__tests__/fixtures";
import { initQuickdraw, type ServerAuth } from "../../index";
import { call, transportHarness, v5Auth } from "../../transports/__tests__/harness";
import { APP_ORIGIN, baseOptions, post, SECRET, signIn, userIdOf } from "./__tests__/harness";
import { createAuthRoutes } from "./createAuthRoutes";
import { createMemorySessionStore } from "./sessions";
import { socketAuth } from "./socketAuth";
import { issueSession } from "./tokens";

const who = defineContract("whoService", {
  methods: {
    whoami: query({ input: z.undefined(), output: z.unknown() }),
    ping: query({ input: z.undefined(), output: z.unknown() }),
  },
});

const qd = initQuickdraw<{ principal: AppPrincipal }>();

const whoService = qd.defineService(who, {
  methods: {
    whoami: { access: "authenticated", handler: ({ ctx }) => ctx.principal },
    ping: { access: "public", handler: ({ ctx }) => ctx.principal?.userId ?? null },
  },
});

const servers = transportHarness();

afterEach(() => {
  vi.unstubAllEnvs();
});

type Authenticate = (
  sessions: ReturnType<typeof createMemorySessionStore>,
) => ServerAuth<AppPrincipal>;

const defaultAuth: Authenticate = (sessions) => ({
  authenticate: socketAuth({
    sessions,
    jwtSecret: SECRET,
    allowedOrigins: [APP_ORIGIN, /^http:\/\/[a-z]+\.preview\.test$/],
    loadPrincipal: (userId): AppPrincipal => ({ userId, kind: "user" }),
  }),
});

/** A server with `socketAuth` and the auth routes on one Express app. */
async function boot(auth: Authenticate = defaultAuth) {
  vi.stubEnv("ENABLE_MOCK_OAUTH", "true");
  const app = express();
  const sessions = createMemorySessionStore();
  const logger = captureLogger();
  const { url } = await servers.start({
    app,
    services: [whoService],
    logger,
    auth: auth(sessions),
  });
  const record = { logins: [], guests: [] };
  app.use(createAuthRoutes(baseOptions(url, captureLogger(), sessions, record)));
  return { url, sessions, logger };
}

/** Opens a v5 socket with these handshake headers (and `auth`); resolves with what happened. */
async function connect(
  url: string,
  headers: Record<string, string>,
  auth: Record<string, unknown> = v5Auth(null),
): Promise<{ readonly whoami: unknown } | { readonly refused: unknown }> {
  const opened = servers.open(url, auth, { extraHeaders: headers });
  try {
    await opened.connected;
  } catch (error) {
    return { refused: (error as { readonly data?: unknown }).data };
  }
  await opened.hello;
  return { whoami: await call(opened.socket, { id: 1, s: "whoService", m: "whoami" }) };
}

const REFUSED = { refused: { code: "UNAUTHENTICATED" } };

function signedIn(userId: string) {
  return { whoami: { ok: true, d: { userId, kind: "user" } } };
}

describe("a socket with the session cookie", () => {
  it("is authenticated from an allowed page, and refused once the session is logged out", async () => {
    const { url, logger } = await boot();
    const { session } = await signIn(url, "ada@demo.local");
    const page = { cookie: session, origin: APP_ORIGIN };
    expect(await connect(url, page)).toEqual(signedIn(userIdOf("ada@demo.local")));

    await post(`${url}/auth/logout`, { cookie: session });
    // The JWT has not expired; the store no longer holds its session.
    const refused = await connect(url, page);
    expect(refused).toEqual(REFUSED);
    expect(isAuthenticationRefused((refused as { refused: unknown }).refused)).toBe(true);
    // A refusal is the client's doing: logged at debug, not error.
    expect(logger.at("error")).toEqual([]);
    expect(logger.at("debug").map((entry) => entry.message)).toContain(
      "Socket authentication failed",
    );
  });

  it("is refused for every session of the user after logout-all", async () => {
    const { url } = await boot();
    const laptop = await signIn(url, "ada@demo.local");
    const phone = await signIn(url, "ada@demo.local");
    const bob = await signIn(url, "bob@demo.local");
    await post(`${url}/auth/logout-all`, { cookie: phone.session });
    for (const { session } of [laptop, phone]) {
      expect(await connect(url, { cookie: session, origin: APP_ORIGIN })).toEqual(REFUSED);
    }
    expect(await connect(url, { cookie: bob.session, origin: APP_ORIGIN })).toEqual(
      signedIn(userIdOf("bob@demo.local")),
    );
  });

  it("checks Origin: refused when it is not allowed or absent, unless same-origin or allowed missing", async () => {
    const { url } = await boot();
    const { session } = await signIn(url, "ada@demo.local");
    const ada = signedIn(userIdOf("ada@demo.local"));
    for (const origin of [
      "https://evil.test",
      "http://app.test.evil.test",
      "null",
      "http://APP.test:80x",
    ]) {
      expect(await connect(url, { cookie: session, origin }), origin).toEqual(REFUSED);
    }
    expect(await connect(url, { cookie: session })).toEqual(REFUSED);
    expect(await connect(url, { cookie: session, "sec-fetch-site": "cross-site" })).toEqual(
      REFUSED,
    );
    expect(await connect(url, { cookie: session, origin: "http://pr.preview.test" })).toEqual(ada);
    // A browser's same-origin long-polling handshake carries no Origin, but says so.
    expect(await connect(url, { cookie: session, "sec-fetch-site": "same-origin" })).toEqual(ada);

    const native = await boot((sessions) => ({
      authenticate: socketAuth({
        sessions,
        jwtSecret: SECRET,
        allowedOrigins: [APP_ORIGIN],
        allowMissingOrigin: true,
        loadPrincipal: (userId): AppPrincipal => ({ userId, kind: "user" }),
      }),
    }));
    const nativeSession = (await signIn(native.url, "ada@demo.local")).session;
    expect(await connect(native.url, { cookie: nativeSession })).toEqual(ada);
    expect(
      await connect(native.url, { cookie: nativeSession, origin: "https://evil.test" }),
    ).toEqual(REFUSED);
  });

  it("is refused when the cookie is not a live session's", async () => {
    const { url } = await boot();
    for (const cookie of ["session=garbage", "session=a.b.c"]) {
      expect(await connect(url, { cookie, origin: APP_ORIGIN })).toEqual(REFUSED);
    }
  });
});

describe("a socket without the cookie", () => {
  it("is anonymous without credentials, whatever its Origin", async () => {
    const { url } = await boot();
    const opened = servers.open(url, v5Auth(null), {
      extraHeaders: { origin: "https://evil.test" },
    });
    await opened.hello;
    expect(await call(opened.socket, { id: 1, s: "whoService", m: "ping" })).toEqual({
      ok: true,
      d: null,
    });
    expect(await call(opened.socket, { id: 2, s: "whoService", m: "whoami" })).toMatchObject({
      ok: false,
      e: { code: "UNAUTHENTICATED" },
    });
  });

  it("authenticates by a bearer token in auth.token, which needs no Origin", async () => {
    const { url } = await boot();
    const { session } = await signIn(url, "bob@demo.local");
    const token = session.slice("session=".length);
    const bob = signedIn(userIdOf("bob@demo.local"));
    expect(await connect(url, {}, { ...v5Auth(null), token })).toEqual(bob);
    expect(await connect(url, { origin: "https://evil.test" }, { ...v5Auth(null), token })).toEqual(
      bob,
    );
    // The token is checked against the store like the cookie.
    await post(`${url}/auth/logout`, { headers: { authorization: `Bearer ${token}` } });
    expect(await connect(url, {}, { ...v5Auth(null), token })).toEqual(REFUSED);
  });
});

describe("loadPrincipal", () => {
  it("builds the principal, and refuses when it returns none or another user's", async () => {
    const loadPrincipal = vi.fn((userId: string): AppPrincipal | null => {
      if (userId === userIdOf("bob@demo.local")) {
        return null;
      }
      if (userId === "eve") {
        return { userId: "someone-else", kind: "user" };
      }
      return { userId, kind: "agent", serviceAccess: { whoService: "Admin" } };
    });
    const { url, logger, sessions } = await boot((store) => ({
      authenticate: socketAuth({
        sessions: store,
        jwtSecret: SECRET,
        allowedOrigins: [APP_ORIGIN],
        loadPrincipal,
      }),
    }));
    const ada = await signIn(url, "ada@demo.local");
    expect(await connect(url, { cookie: ada.session, origin: APP_ORIGIN })).toEqual({
      whoami: {
        ok: true,
        d: {
          userId: userIdOf("ada@demo.local"),
          kind: "agent",
          serviceAccess: { whoService: "Admin" },
        },
      },
    });
    expect(loadPrincipal).toHaveBeenCalledWith(
      userIdOf("ada@demo.local"),
      expect.objectContaining({ userId: userIdOf("ada@demo.local"), expiresAt: expect.any(Date) }),
    );
    // No principal: the user is gone. A refusal, logged at debug.
    const bob = await signIn(url, "bob@demo.local");
    expect(await connect(url, { cookie: bob.session, origin: APP_ORIGIN })).toEqual(REFUSED);
    expect(logger.at("error")).toEqual([]);
    // Another user's principal is the app's bug: refused, and logged at error.
    const { token } = await issueSession({ sessions, jwtSecret: SECRET }, "eve", {
      provider: "test",
    });
    expect(await connect(url, {}, { ...v5Auth(null), token })).toEqual(REFUSED);
    expect(logger.at("error").map((entry) => entry.meta?.error)).toEqual([
      expect.objectContaining({
        message: "socketAuth: loadPrincipal must return the principal of the session's user",
      }),
    ]);
  });

  it('defaults to { userId, kind: "user" }, whose grants createServer\'s loadServiceAccess loads', async () => {
    const { url } = await boot((sessions) => ({
      authenticate: socketAuth({
        sessions,
        jwtSecret: SECRET,
        allowedOrigins: [APP_ORIGIN],
      }) as ServerAuth<AppPrincipal>["authenticate"],
      loadServiceAccess: () => ({ whoService: "Read" }),
    }));
    const { session } = await signIn(url, "ada@demo.local");
    expect(await connect(url, { cookie: session, origin: APP_ORIGIN })).toEqual({
      whoami: {
        ok: true,
        d: {
          userId: userIdOf("ada@demo.local"),
          kind: "user",
          serviceAccess: { whoService: "Read" },
        },
      },
    });
  });
});

describe("an HTTP call", () => {
  it("is authenticated by the session cookie or a bearer token, and refused once revoked", async () => {
    const { url, logger } = await boot();
    const { session } = await signIn(url, "ada@demo.local");
    const whoami = (headers: Record<string, string>) =>
      fetch(`${url}/qd/whoService/whoami`, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
      });
    // No Origin check on HTTP: its JSON content type needs a CORS preflight instead.
    const byCookie = await whoami({ cookie: session });
    expect(await byCookie.json()).toEqual({
      ok: true,
      d: { userId: userIdOf("ada@demo.local"), kind: "user" },
    });
    const bearer = { authorization: `Bearer ${session.slice("session=".length)}` };
    expect(await (await whoami(bearer)).json()).toMatchObject({ ok: true });

    await post(`${url}/auth/logout`, { cookie: session });
    for (const headers of [{ cookie: session }, bearer]) {
      const refused = await whoami(headers);
      expect(refused.status).toBe(401);
      expect(await refused.json()).toEqual({
        ok: false,
        e: { code: "UNAUTHENTICATED", message: "Authentication failed" },
      });
    }
    expect(logger.at("error")).toEqual([]);
    expect(logger.at("debug").map((entry) => entry.message)).toContain(
      "HTTP authentication failed",
    );
  });
});

describe("the options", () => {
  it("are checked", () => {
    const sessions = createMemorySessionStore();
    const base = { sessions, jwtSecret: SECRET, allowedOrigins: [APP_ORIGIN] };
    expect(() => socketAuth({ ...base, jwtSecret: "short" })).toThrow(
      "socketAuth: jwtSecret must be a secret of at least 32 characters",
    );
    expect(() => socketAuth({ ...base, sessions: {} as never })).toThrow(
      "socketAuth: sessions must be a SessionStore",
    );
    expect(() => socketAuth({ ...base, allowedOrigins: ["*"] })).toThrow(
      "socketAuth: allowedOrigins entries are origins",
    );
    expect(() => socketAuth({ ...base, loadPrincipal: 1 as never })).toThrow(
      "socketAuth: loadPrincipal must be a function",
    );
    // An empty list is allowed: no page may then use the cookie on a socket.
    expect(socketAuth({ ...base, allowedOrigins: [] })).toBeTypeOf("function");
  });
});
