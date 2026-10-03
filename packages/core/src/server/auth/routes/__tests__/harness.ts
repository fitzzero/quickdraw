// The auth routes on a real Express app on port 0, closed after each test, and
// a browser's part of a sign-in: requests that do not follow redirects, and
// the cookies the responses set.

import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, vi } from "vitest";
import { captureLogger, type CapturingLogger } from "../../../__tests__/fixtures";
import type { MockOAuthUser } from "../../mock";
import { createAuthRoutes } from "../createAuthRoutes";
import { guest } from "../guest";
import type { AuthProfile } from "../providers";
import { mock } from "../providers";
import { createMemorySessionStore, type MemorySessionStore } from "../sessions";
import type { AuthRoutesOptions } from "../types";

export const APP_ORIGIN = "http://app.test";
export const SECRET = "a-test-secret-of-at-least-thirty-two-characters";

export const USERS: MockOAuthUser[] = [
  { id: "u1", email: "ada@demo.local", name: "Ada", picture: "https://img.test/ada.png" },
  { id: "u2", email: "bob@demo.local", name: "Bob" },
];

/** The user id `onLogin` gives a mock profile: `user:{email}`. */
export function userIdOf(email: string): string {
  return `user:${email}`;
}

export interface Booted {
  readonly app: express.Express;
  readonly server: Server;
  /** The API's base URL: `http://127.0.0.1:{port}`. */
  readonly url: string;
  readonly sessions: MemorySessionStore;
  readonly logger: CapturingLogger;
  /** What `onLogin` was called with. */
  readonly logins: (readonly [AuthProfile, string])[];
  /** What the guest provider's `createUser` was called with. */
  readonly guests: unknown[];
}

/** Starts an empty app on a free port. */
export async function listen(app: express.Express): Promise<{ server: Server; url: string }> {
  const server = createHttpServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${port}` };
}

/** The options a test's routes start from: the mock and guest providers, no rate limits. */
export function baseOptions(
  url: string,
  logger: CapturingLogger,
  sessions: MemorySessionStore,
  record: Pick<Booted, "logins" | "guests">,
): AuthRoutesOptions {
  return {
    providers: [
      mock({ listUsers: () => Promise.resolve(USERS) }),
      guest({
        createUser: (input) => {
          record.guests.push(input);
          return `guest:${record.guests.length}`;
        },
      }),
    ],
    sessions,
    jwtSecret: SECRET,
    onLogin: (profile, provider) => {
      record.logins.push([profile, provider]);
      return userIdOf(profile.email ?? "");
    },
    allowedOrigins: [APP_ORIGIN, /^http:\/\/[a-z]+\.preview\.test$/],
    publicUrl: url,
    rateLimit: false,
    logger,
  };
}

/** Registers the cleanup (servers, env stubs) and returns `boot`. Call it once per test file. */
export function authHarness(): {
  boot(overrides?: Partial<AuthRoutesOptions>, makeApp?: () => express.Express): Promise<Booted>;
  readonly servers: Server[];
} {
  const servers: Server[] = [];
  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => {
              resolve();
            });
          }),
      ),
    );
  });
  return {
    servers,
    async boot(overrides = {}, makeApp = express) {
      vi.stubEnv("ENABLE_MOCK_OAUTH", "true");
      const app = makeApp();
      const { server, url } = await listen(app);
      servers.push(server);
      const logger = captureLogger();
      const sessions = createMemorySessionStore();
      const record = { logins: [], guests: [] };
      app.use(createAuthRoutes({ ...baseOptions(url, logger, sessions, record), ...overrides }));
      return { app, server, url, sessions, logger, ...record };
    },
  };
}

/** A cookie a response set: its value (empty when it clears it) and its attributes, lowercased. */
export interface SetCookie {
  readonly value: string;
  readonly attributes: readonly string[];
}

/** The cookies a response sets, by name. */
export function cookiesSet(response: Response): Map<string, SetCookie> {
  const cookies = new Map<string, SetCookie>();
  for (const header of response.headers.getSetCookie()) {
    const [pair = "", ...attributes] = header.split(";").map((part) => part.trim());
    const equals = pair.indexOf("=");
    cookies.set(pair.slice(0, equals), {
      value: decodeURIComponent(pair.slice(equals + 1)),
      attributes: attributes.map((attribute) => attribute.toLowerCase()),
    });
  }
  return cookies;
}

/** The value of a cookie the response sets; throws when it sets none of that name. */
export function cookieValue(response: Response, name: string): string {
  const cookie = cookiesSet(response).get(name);
  if (cookie === undefined) {
    throw new Error(`The response set no ${name} cookie`);
  }
  return cookie.value;
}

/** A GET that does not follow redirects, with the cookies given. */
export function get(url: string, cookie?: string): Promise<Response> {
  return fetch(url, { redirect: "manual", headers: cookie === undefined ? {} : { cookie } });
}

/** A JSON POST with the cookies given. */
export function post(
  url: string,
  options: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
}

/** Where a redirect points. */
export function locationOf(response: Response): string {
  const location = response.headers.get("location");
  if (location === null) {
    throw new Error(`Expected a redirect, got HTTP ${response.status}`);
  }
  return location;
}

/** A sign-in started: the state cookie and the provider's authorization URL. */
export interface Started {
  readonly stateCookie: string;
  readonly authorizeUrl: URL;
}

/** `GET /auth/mock/start`, as a browser would. */
export async function start(url: string, returnTo?: string): Promise<Started> {
  const query = returnTo === undefined ? "" : `?returnTo=${encodeURIComponent(returnTo)}`;
  const response = await get(`${url}/auth/mock/start${query}`);
  if (response.status !== 302) {
    throw new Error(`start answered HTTP ${response.status}: ${await response.text()}`);
  }
  return {
    stateCookie: `qd_oauth=${cookieValue(response, "qd_oauth")}`,
    authorizeUrl: new URL(locationOf(response)),
  };
}

/** The mock provider's consent as `email`: the callback URL it redirects to. */
export async function consent(started: Started, email: string): Promise<URL> {
  const authorize = new URL(started.authorizeUrl);
  authorize.searchParams.set("email", email);
  const response = await get(authorize.href);
  return new URL(locationOf(response));
}

/** A whole mock sign-in as `email`: the callback's response, and the session cookie it set. */
export async function signIn(
  url: string,
  email: string,
  returnTo?: string,
): Promise<{ readonly callback: Response; readonly session: string }> {
  const started = await start(url, returnTo);
  const callbackUrl = await consent(started, email);
  const callback = await get(callbackUrl.href, started.stateCookie);
  return { callback, session: `session=${cookieValue(callback, "session")}` };
}
