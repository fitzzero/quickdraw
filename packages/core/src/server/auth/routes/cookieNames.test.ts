// The session cookie's name, written and read by one rule
// (`sessionCookieNameFor`): the auth routes, `setSessionCookie`, the HTTP
// transport and `socketAuth` on one server, in the deployments where they used
// to disagree. Each signs in, then calls with the same headers over the HTTP
// transport, over a socket and through `GET /auth/me`.

import express from "express";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { defineContract, query } from "../../../index";
import { captureLogger, type AppPrincipal } from "../../__tests__/fixtures";
import { initQuickdraw } from "../../index";
import { call, transportHarness, v5Auth } from "../../transports/__tests__/harness";
import { setSessionCookie } from "../sessionCookie";
import { guest } from "./guest";
import { createAuthRoutes } from "./createAuthRoutes";
import { createMemorySessionStore } from "./sessions";
import { socketAuth } from "./socketAuth";
import { issueSession } from "./tokens";
import type { AuthRoutesOptions } from "./types";

const SECRET = "a-test-secret-of-at-least-thirty-two-characters";
/** A web app served over HTTPS (in development: `next dev --experimental-https`). */
const WEB = "https://localhost:3000";
const PLAIN_WEB = "http://localhost:3000";

const who = defineContract("whoService", {
  methods: { whoami: query({ input: z.undefined(), output: z.unknown() }) },
});
const qd = initQuickdraw<{ principal: AppPrincipal }>();
const whoService = qd.defineService(who, {
  methods: {
    whoami: { access: "authenticated", handler: ({ ctx }) => ctx.principal.userId },
  },
});

const servers = transportHarness();

afterEach(() => {
  vi.unstubAllEnvs();
});

interface BootOptions {
  readonly trustProxy?: boolean;
  readonly cookie?: AuthRoutesOptions["cookie"];
  /** The transports' own `cookieName`. */
  readonly cookieName?: string;
}

/** A server whose Express app serves the auth routes, the HTTP transport and sockets. */
async function boot(options: BootOptions = {}) {
  const app = express();
  if (options.trustProxy === true) {
    app.set("trust proxy", 1);
  }
  const sessions = createMemorySessionStore();
  const routesLogger = captureLogger();
  const named = options.cookieName === undefined ? {} : { cookieName: options.cookieName };
  const { url } = await servers.start({
    app,
    services: [whoService],
    logger: captureLogger(),
    auth: {
      authenticate: socketAuth({
        sessions,
        jwtSecret: SECRET,
        allowedOrigins: [WEB, PLAIN_WEB],
        ...named,
        loadPrincipal: (userId): AppPrincipal => ({ userId, kind: "user" }),
      }),
    },
    http: named,
  });
  app.post("/legacy-login", async (_req, res) => {
    // A 4.x app route kept in 5.0 (quickdraw-chat's Discord Activity sign-in).
    const { token } = await issueSession({ sessions, jwtSecret: SECRET }, "user:legacy", {
      provider: "discord",
    });
    setSessionCookie(res, token);
    res.json({ token });
  });
  app.use(
    createAuthRoutes({
      providers: [guest({ createUser: () => "guest:1" })],
      sessions,
      jwtSecret: SECRET,
      onLogin: () => "user:1",
      allowedOrigins: [WEB, PLAIN_WEB],
      publicUrl: url,
      rateLimit: false,
      logger: routesLogger,
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
    }),
  );
  return { url, routesLogger };
}

/** The cookie a sign-in set: its name, its `name=value` pair and its attributes. */
async function signIn(url: string, path: string, headers: Record<string, string>) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/json", ...headers },
    body: "{}",
  });
  const [setCookie = ""] = response.headers.getSetCookie();
  const [pair = "", ...attributes] = setCookie.split(";").map((part) => part.trim());
  return {
    name: pair.slice(0, pair.indexOf("=")),
    pair,
    attributes: attributes.map((attribute) => attribute.toLowerCase()),
  };
}

/** Who the cookie signs in as, over the HTTP transport, over a socket and through `/auth/me`. */
async function signedInAs(url: string, headers: Record<string, string>) {
  const http = await fetch(`${url}/qd/whoService/whoami`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
  });
  const opened = servers.open(url, v5Auth(null), { extraHeaders: headers });
  let socket: unknown;
  try {
    await opened.connected;
    await opened.hello;
    socket = await call(opened.socket, { id: 1, s: "whoService", m: "whoami" });
  } catch (error) {
    socket = { refused: (error as { readonly data?: unknown }).data };
  }
  const me = await fetch(`${url}/auth/me`, { headers });
  return {
    http: (await http.json()) as unknown,
    socket,
    me: me.ok ? ((await me.json()) as { userId: unknown }).userId : me.status,
  };
}

function everywhere(userId: string) {
  return { http: { ok: true, d: userId }, socket: { ok: true, d: userId }, me: userId };
}

describe("the session cookie's name, set by the routes and read by the transports", () => {
  it("is `session` over plain HTTP in development, read everywhere", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { url } = await boot();
    const headers = { origin: PLAIN_WEB };
    const cookie = await signIn(url, "/auth/guest", headers);
    expect(cookie.name).toBe("session");
    expect(await signedInAs(url, { ...headers, cookie: cookie.pair })).toEqual(
      everywhere("guest:1"),
    );
  });

  it("S1: behind a proxy that ends TLS, without trust proxy, in development: __Host-session, read everywhere", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { url } = await boot();
    const headers = { "x-forwarded-proto": "https", origin: WEB };
    const cookie = await signIn(url, "/auth/guest", headers);
    expect(cookie.name).toBe("__Host-session");
    expect(cookie.attributes).toContain("secure");
    expect(await signedInAs(url, { ...headers, cookie: cookie.pair })).toEqual(
      everywhere("guest:1"),
    );
  });

  it("S2: cookie.secure false behind a TLS proxy with trust proxy, in production: __Host-session, Secure as its prefix requires", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { url } = await boot({ trustProxy: true, cookie: { secure: false } });
    const headers = { "x-forwarded-proto": "https", origin: WEB };
    const cookie = await signIn(url, "/auth/guest", headers);
    expect(cookie.name).toBe("__Host-session");
    expect(cookie.attributes).toContain("secure");
    expect(await signedInAs(url, { ...headers, cookie: cookie.pair })).toEqual(
      everywhere("guest:1"),
    );
  });

  it("S3: an https: page calling a plain HTTP loopback API in development: __Host-session, read everywhere", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const { url } = await boot();
    const headers = { origin: WEB };
    const cookie = await signIn(url, "/auth/guest", headers);
    expect(cookie.name).toBe("__Host-session");
    expect(await signedInAs(url, { ...headers, cookie: cookie.pair })).toEqual(
      everywhere("guest:1"),
    );
  });

  it("S4: COOKIE_DOMAIN in production: `session` with the domain, which the transports read too, with no warning", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("COOKIE_DOMAIN", ".example.com");
    const { url, routesLogger } = await boot({ trustProxy: true });
    const headers = { "x-forwarded-proto": "https", origin: WEB };
    const cookie = await signIn(url, "/auth/guest", headers);
    expect(cookie.name).toBe("session");
    expect(cookie.attributes).toContain("domain=.example.com");
    expect(await signedInAs(url, { ...headers, cookie: cookie.pair })).toEqual(
      everywhere("guest:1"),
    );
    expect(routesLogger.at("warn")).toEqual([]);
  });

  it("S4: cookie.domain without COOKIE_DOMAIN warns at startup, and works once the transports name the cookie", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const headers = { "x-forwarded-proto": "https", origin: WEB };
    const unnamed = await boot({ trustProxy: true, cookie: { domain: ".example.com" } });
    expect(unnamed.routesLogger.at("warn").map((entry) => entry.message)).toEqual([
      expect.stringContaining("cookie.domain is set and COOKIE_DOMAIN is not"),
    ]);
    const cookie = await signIn(unnamed.url, "/auth/guest", headers);
    expect(cookie.name).toBe("session");
    const named = await boot({
      trustProxy: true,
      cookie: { domain: ".example.com", name: "session" },
      cookieName: "session",
    });
    expect(named.routesLogger.at("warn")).toEqual([]);
    const namedCookie = await signIn(named.url, "/auth/guest", headers);
    expect(await signedInAs(named.url, { ...headers, cookie: namedCookie.pair })).toEqual(
      everywhere("guest:1"),
    );
  });

  it("S5: an app route on 4.x setSessionCookie, in production: the routes' name for its request, read everywhere", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { url } = await boot({ trustProxy: true });
    const overHttps = { "x-forwarded-proto": "https", origin: WEB };
    const secure = await signIn(url, "/legacy-login", overHttps);
    expect(secure.name).toBe("__Host-session");
    expect(await signedInAs(url, { ...overHttps, cookie: secure.pair })).toEqual(
      everywhere("user:legacy"),
    );
    // Over plain HTTP it sets `session`, which a plain request reads.
    const overHttp = { origin: PLAIN_WEB };
    const plain = await signIn(url, "/legacy-login", overHttp);
    expect(plain.name).toBe("session");
    expect(await signedInAs(url, { ...overHttp, cookie: plain.pair })).toEqual(
      everywhere("user:legacy"),
    );
  });

  it("never reads a planted plain `session` over HTTPS without a domain", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { url } = await boot({ trustProxy: true });
    const headers = { "x-forwarded-proto": "https", origin: WEB };
    const cookie = await signIn(url, "/auth/guest", headers);
    const planted = `session=${cookie.pair.slice(cookie.name.length + 1)}`;
    const reads = await signedInAs(url, { ...headers, cookie: planted });
    expect(reads.http).toEqual({
      ok: false,
      e: expect.objectContaining({ code: "UNAUTHENTICATED" }),
    });
    expect(reads.me).toBe(401);
  });
});
