// The auth routes kit (RFC 0003 section 12.6) over real requests to an
// Express app in the test process, signing in through the mock provider: the
// state and return-origin refusals first, then the sign-in, the session
// routes, the guest route, the rate limits and the options.

import { createRequire } from "node:module";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { INTERNAL_MESSAGE, QuickdrawError } from "../../../protocol/errors";
import { createAuthLimiter } from "../../express/rateLimit";
import { createJWT } from "../jwt";
import {
  APP_ORIGIN,
  authHarness,
  consent,
  cookiesSet,
  cookieValue,
  get,
  listen,
  locationOf,
  post,
  SECRET,
  signIn,
  start,
  userIdOf,
} from "./__tests__/harness";
import { createAuthRoutes } from "./createAuthRoutes";
import { guest } from "./guest";
import { discord, google, mock } from "./providers";
import { createMemorySessionStore } from "./sessions";
import { encodePending, OAUTH_STATE_TTL_MS } from "./state";

/** Express 5, installed as the `express5` alias; its API matches Express 4's types here. */
const express5 = createRequire(import.meta.url)("express5") as typeof express;

const harness = authHarness();

describe("the OAuth state", () => {
  it("refuses a callback without the state cookie, so a sign-in cannot be finished in another browser", async () => {
    const { url, logins, sessions } = await harness.boot();
    const started = await start(url);
    const callbackUrl = await consent(started, "ada@demo.local");
    // No origin was remembered here: it lands on the first exact allowed origin.
    const response = await get(callbackUrl.href);
    expect(locationOf(response)).toBe(`${APP_ORIGIN}/?error=state`);
    expect(cookiesSet(response).has("session")).toBe(false);

    const patternsOnly = await harness.boot({ allowedOrigins: [/^http:\/\/[a-z]+\.app\.test$/] });
    const elsewhere = await start(patternsOnly.url, "http://www.app.test");
    const refused = await get((await consent(elsewhere, "ada@demo.local")).href);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({
      error: "FORBIDDEN",
      message: "This sign-in has no state in this browser; start it again",
    });
    expect(logins).toEqual([]);
    expect([sessions.size, patternsOnly.sessions.size]).toEqual([0, 0]);
  });

  it("refuses a missing or wrong state, or another sign-in's, and clears the state cookie", async () => {
    const { url, logins, sessions } = await harness.boot();
    const first = await start(url);
    const second = await start(url);
    const callbackUrl = await consent(first, "ada@demo.local");
    const wrong = new URL(callbackUrl);
    wrong.searchParams.set("state", "forged");
    const missing = new URL(callbackUrl);
    missing.searchParams.delete("state");
    for (const [target, cookie] of [
      [wrong, first.stateCookie],
      [missing, first.stateCookie],
      // The callback names the first sign-in's state; the cookie is the second's.
      [callbackUrl, second.stateCookie],
    ] as const) {
      const response = await get(target.href, cookie);
      expect(locationOf(response)).toBe(`${APP_ORIGIN}/?error=state`);
      expect(cookiesSet(response).get("qd_oauth")).toMatchObject({ value: "" });
      expect(cookiesSet(response).has("session")).toBe(false);
    }
    expect(logins).toEqual([]);
    expect(sessions.size).toBe(0);
  });

  it("redeems a state once: a replayed callback is refused even with its cookie", async () => {
    const { url, logins } = await harness.boot();
    const started = await start(url);
    const callbackUrl = await consent(started, "ada@demo.local");
    const first = await get(callbackUrl.href, started.stateCookie);
    expect(locationOf(first)).toBe(`${APP_ORIGIN}/`);
    const replayed = await get(callbackUrl.href, started.stateCookie);
    expect(locationOf(replayed)).toBe(`${APP_ORIGIN}/?error=state`);
    expect(cookiesSet(replayed).has("session")).toBe(false);
    expect(logins).toHaveLength(1);
  });

  it("refuses a state older than ten minutes, or one issued for another provider", async () => {
    const { url } = await harness.boot();
    const callback = (state: string, cookie: Parameters<typeof encodePending>[0]) =>
      get(`${url}/auth/mock/callback?code=c&state=${state}`, `qd_oauth=${encodePending(cookie)}`);
    const pending = { state: "s1", provider: "mock", origin: APP_ORIGIN, issuedAt: Date.now() };
    const expired = await callback("s1", {
      ...pending,
      issuedAt: Date.now() - OAUTH_STATE_TTL_MS - 1000,
    });
    expect(locationOf(expired)).toBe(`${APP_ORIGIN}/?error=state`);
    const otherProvider = await callback("s1", { ...pending, provider: "google" });
    expect(locationOf(otherProvider)).toBe(`${APP_ORIGIN}/?error=state`);
  });

  it("sets the state cookie HttpOnly, Lax and short-lived on the routes' path only", async () => {
    const { url } = await harness.boot();
    const response = await get(`${url}/auth/mock/start`);
    const cookie = cookiesSet(response).get("qd_oauth");
    expect(cookie?.attributes).toEqual(
      expect.arrayContaining(["path=/auth", "httponly", "samesite=lax", "max-age=600"]),
    );
    expect(cookie?.attributes).not.toContain("secure");
    expect(cookie?.attributes.some((attribute) => attribute.startsWith("domain="))).toBe(false);
  });
});

describe("the return origin", () => {
  it("refuses a returnTo whose origin is not allowed, before anything is stored", async () => {
    const { url } = await harness.boot();
    for (const returnTo of [
      "https://evil.test",
      "http://app.test.evil.test",
      "http://app.test@evil.test",
      "//evil.test",
      "javascript:alert(1)",
      "http://sub.app.test",
      "https://app.test",
    ]) {
      const response = await get(`${url}/auth/mock/start?returnTo=${encodeURIComponent(returnTo)}`);
      expect(response.status, returnTo).toBe(422);
      expect(await response.json()).toEqual({
        error: "VALIDATION",
        message: "returnTo is not one of the allowed origins",
      });
      expect(cookiesSet(response).size).toBe(0);
    }
  });

  it("keeps only the origin of an allowed returnTo, and falls back to the first exact origin", async () => {
    const { url } = await harness.boot();
    const deep = await signIn(url, "ada@demo.local", `${APP_ORIGIN}/boards/7?tab=x`);
    expect(locationOf(deep.callback)).toBe(`${APP_ORIGIN}/`);
    const byPattern = await signIn(url, "ada@demo.local", "http://pr.preview.test");
    expect(locationOf(byPattern.callback)).toBe("http://pr.preview.test/");
    const fallback = await signIn(url, "ada@demo.local");
    expect(locationOf(fallback.callback)).toBe(`${APP_ORIGIN}/`);
  });

  it("validates the remembered origin again before redirecting to it", async () => {
    const { url, logins } = await harness.boot();
    const tampered = encodePending({
      state: "s1",
      provider: "mock",
      origin: "https://evil.test",
      issuedAt: Date.now(),
    });
    const response = await get(`${url}/auth/mock/callback?code=c&state=s1`, `qd_oauth=${tampered}`);
    expect(response.status).toBe(422);
    expect(response.headers.get("location")).toBeNull();
    expect(await response.json()).toMatchObject({ error: "VALIDATION" });
    expect(logins).toEqual([]);
  });
});

describe("signing in", () => {
  it("starts at the provider, and the callback sets the session cookie and returns to the origin", async () => {
    const { url, logins, sessions, logger } = await harness.boot();
    const started = await start(url, APP_ORIGIN);
    expect(started.authorizeUrl.origin + started.authorizeUrl.pathname).toBe(
      `${url}/auth/mock/provider/authorize`,
    );
    expect(started.authorizeUrl.searchParams.get("redirect_uri")).toBe(`${url}/auth/mock/callback`);
    const callbackUrl = await consent(started, "ada@demo.local");
    const callback = await get(callbackUrl.href, started.stateCookie);

    expect(callback.status).toBe(302);
    expect(locationOf(callback)).toBe(`${APP_ORIGIN}/`);
    expect(callback.headers.get("cache-control")).toBe("no-store");
    const set = cookiesSet(callback);
    expect(set.get("qd_oauth")?.value).toBe("");
    expect(set.get("session")?.attributes).toEqual(
      expect.arrayContaining(["path=/", "httponly", "samesite=lax", "max-age=604800"]),
    );
    expect(set.get("session")?.attributes).not.toContain("secure");

    expect(logins).toEqual([
      [
        {
          providerAccountId: "ada@demo.local",
          email: "ada@demo.local",
          emailVerified: true,
          name: "Ada",
          image: "https://img.test/ada.png",
          tokens: expect.objectContaining({ token_type: "Bearer" }),
          raw: expect.objectContaining({ email: "ada@demo.local" }),
        },
        "mock",
      ],
    ]);
    expect(sessions.size).toBe(1);
    expect(logger.at("info").map((entry) => entry.message)).toContain("Signed in");

    const me = await get(`${url}/auth/me`, `session=${cookieValue(callback, "session")}`);
    expect(await me.json()).toEqual({ userId: userIdOf("ada@demo.local") });
  });

  it("lands on successPath, and a failure on errorPath with its reason", async () => {
    const onLogin = vi.fn((profile: { email: string | null }) => {
      if (profile.email === "bob@demo.local") {
        return null;
      }
      throw new Error("the user table is down");
    });
    const { url, logger, sessions } = await harness.boot({
      onLogin,
      successPath: "/auth/done",
      errorPath: "/signin?from=oauth",
    });
    const started = await start(url);
    const denied = await get((await consent(started, "bob@demo.local")).href, started.stateCookie);
    expect(locationOf(denied)).toBe(`${APP_ORIGIN}/signin?from=oauth&error=denied`);
    const again = await start(url);
    const failed = await get((await consent(again, "ada@demo.local")).href, again.stateCookie);
    expect(locationOf(failed)).toBe(`${APP_ORIGIN}/signin?from=oauth&error=failed`);
    expect(logger.at("error").map((entry) => entry.message)).toEqual(["onLogin failed"]);
    expect(sessions.size).toBe(0);

    const fine = await harness.boot({ successPath: "/auth/done" });
    expect(locationOf((await signIn(fine.url, "ada@demo.local")).callback)).toBe(
      `${APP_ORIGIN}/auth/done`,
    );
  });

  it("lands with ?error=denied when the provider sends an error instead of a code", async () => {
    const { url } = await harness.boot();
    const started = await start(url);
    const state = started.authorizeUrl.searchParams.get("state") ?? "";
    const response = await get(
      `${url}/auth/mock/callback?error=access_denied&state=${state}`,
      started.stateCookie,
    );
    expect(locationOf(response)).toBe(`${APP_ORIGIN}/?error=denied`);
  });

  it("lands with ?error=failed when the code exchange fails", async () => {
    const { url, logger } = await harness.boot();
    const started = await start(url);
    const state = started.authorizeUrl.searchParams.get("state") ?? "";
    const response = await get(
      `${url}/auth/mock/callback?code=never-issued&state=${state}`,
      started.stateCookie,
    );
    expect(locationOf(response)).toBe(`${APP_ORIGIN}/?error=failed`);
    expect(logger.at("warn").map((entry) => entry.message)).toEqual([
      "A sign-in's code exchange failed",
    ]);
  });

  it("works the same on Express 5", async () => {
    const { url } = await harness.boot({}, express5);
    const { callback, session } = await signIn(url, "bob@demo.local");
    expect(locationOf(callback)).toBe(`${APP_ORIGIN}/`);
    expect(await (await get(`${url}/auth/me`, session)).json()).toEqual({
      userId: userIdOf("bob@demo.local"),
    });
  });

  it("sets a Secure __Host- cookie in production and over HTTPS, and a SameSite=None one when asked", async () => {
    const production = await harness.boot();
    vi.stubEnv("NODE_ENV", "production");
    const secure = await post(`${production.url}/auth/guest`, { body: {} });
    const hostCookie = cookiesSet(secure).get("__Host-session");
    expect(hostCookie?.attributes).toEqual(
      expect.arrayContaining(["secure", "samesite=lax", "httponly", "path=/"]),
    );
    expect(hostCookie?.attributes.some((attribute) => attribute.startsWith("domain="))).toBe(false);
    expect(cookiesSet(secure).has("session")).toBe(false);
    vi.stubEnv("NODE_ENV", "test");

    const proxied = await harness.boot();
    proxied.app.set("trust proxy", true);
    const overHttps = await post(`${proxied.url}/auth/guest`, {
      body: {},
      headers: { "x-forwarded-proto": "https" },
    });
    expect(cookiesSet(overHttps).get("__Host-session")?.attributes).toContain("secure");

    // A cookie for a domain cannot be __Host-: it keeps the plain name.
    const crossSite = await harness.boot({ cookie: { sameSite: "none", domain: "app.test" } });
    const none = await post(`${crossSite.url}/auth/guest`, { body: {} });
    expect(cookiesSet(none).get("session")?.attributes).toEqual(
      expect.arrayContaining(["samesite=none", "secure", "domain=app.test"]),
    );
    vi.stubEnv("COOKIE_DOMAIN", "env.test");
    const fromEnv = await harness.boot({ cookie: { secure: true } });
    const envCookie = cookiesSet(await post(`${fromEnv.url}/auth/guest`, { body: {} }));
    expect(envCookie.get("session")?.attributes).toContain("domain=env.test");
  });

  it("signs in with __Host- state and session cookies on a secure request, and reads only those back", async () => {
    const { url } = await harness.boot({ cookie: { secure: true } });
    const started = await get(`${url}/auth/mock/start`);
    const state = cookiesSet(started).get("__Host-qd_oauth");
    expect(state?.attributes).toEqual(expect.arrayContaining(["secure", "httponly", "path=/"]));
    expect(cookiesSet(started).has("qd_oauth")).toBe(false);
    const stateCookie = `__Host-qd_oauth=${state?.value ?? ""}`;
    const callbackUrl = await consent(
      { stateCookie, authorizeUrl: new URL(locationOf(started)) },
      "ada@demo.local",
    );
    // The plain state name is not read on a secure request.
    const plain = await get(callbackUrl.href, `qd_oauth=${state?.value ?? ""}`);
    expect(new URL(locationOf(plain)).searchParams.get("error")).toBe("state");
    const callback = await get(callbackUrl.href, stateCookie);
    expect(cookiesSet(callback).get("__Host-qd_oauth")?.value).toBe("");
    const token = cookieValue(callback, "__Host-session");
    expect(cookiesSet(callback).get("__Host-session")?.attributes).toEqual(
      expect.arrayContaining(["secure", "httponly", "path=/"]),
    );
    expect(await (await get(`${url}/auth/me`, `__Host-session=${token}`)).json()).toEqual({
      userId: userIdOf("ada@demo.local"),
    });
    expect((await get(`${url}/auth/me`, `session=${token}`)).status).toBe(401);
    const out = await post(`${url}/auth/logout`, { cookie: `__Host-session=${token}` });
    expect(cookiesSet(out).get("__Host-session")?.value).toBe("");
    // A name the app gives is used as it is.
    const named = await harness.boot({ cookie: { secure: true, name: "sid" } });
    const guestSignIn = await post(`${named.url}/auth/guest`, { body: {} });
    expect(cookiesSet(guestSignIn).has("sid")).toBe(true);
  });

  it("counts a repeated session or state cookie name as no credential", async () => {
    const { url } = await harness.boot();
    const { session } = await signIn(url, "ada@demo.local");
    expect((await get(`${url}/auth/me`, session)).status).toBe(200);
    // A sibling site can plant a second cookie of the same name: neither is trusted.
    expect((await get(`${url}/auth/me`, `${session}; session=planted`)).status).toBe(401);
    const started = await start(url);
    const callbackUrl = await consent(started, "ada@demo.local");
    const twice = await get(callbackUrl.href, `${started.stateCookie}; ${started.stateCookie}`);
    expect(new URL(locationOf(twice)).searchParams.get("error")).toBe("state");
    expect(cookiesSet(twice).get("session")).toBeUndefined();
  });
});

describe("me, logout and logout-all", () => {
  it("answers me with the user id for a live session, and the same 401 for anything else", async () => {
    const { url, sessions } = await harness.boot();
    const { session } = await signIn(url, "ada@demo.local");
    const bearer = session.slice("session=".length);
    expect(await (await get(`${url}/auth/me`, session)).json()).toEqual({
      userId: userIdOf("ada@demo.local"),
    });
    const viaBearer = await fetch(`${url}/auth/me`, {
      headers: { authorization: `Bearer ${bearer}` },
    });
    expect(await viaBearer.json()).toEqual({ userId: userIdOf("ada@demo.local") });

    const sessionless = await createJWT({ userId: userIdOf("ada@demo.local") }, SECRET);
    const unknownSession = await createJWT({ userId: "u", sid: "no-such-session" }, SECRET);
    const otherSecret = await createJWT(
      { userId: userIdOf("ada@demo.local"), sid: "x" },
      "another-secret-of-at-least-thirty-two-chars",
    );
    const revoked = await signIn(url, "bob@demo.local");
    await post(`${url}/auth/logout`, { cookie: revoked.session });
    const answers = [];
    for (const cookie of [
      undefined,
      "session=garbage",
      `session=${sessionless}`,
      `session=${unknownSession}`,
      `session=${otherSecret}`,
      revoked.session,
    ]) {
      const response = await get(`${url}/auth/me`, cookie);
      answers.push([response.status, await response.json(), response.headers.get("cache-control")]);
    }
    expect(new Set(answers.map((answer) => JSON.stringify(answer)))).toEqual(
      new Set([
        JSON.stringify([401, { error: "UNAUTHENTICATED", message: "Not signed in" }, "no-store"]),
      ]),
    );
    expect(sessions.size).toBe(1);
  });

  it("refuses a session the store holds for another user, or past its expiry", async () => {
    const { url, sessions } = await harness.boot();
    const { session: other } = await signIn(url, "ada@demo.local");
    const stored = await sessions.create("someone-else", {
      provider: "mock",
      expiresAt: new Date(Date.now() + 60_000),
    });
    const mismatched = await createJWT(
      { userId: userIdOf("ada@demo.local"), sid: stored.id },
      SECRET,
    );
    expect((await get(`${url}/auth/me`, `session=${mismatched}`)).status).toBe(401);
    const past = await sessions.create("u-past", {
      provider: "mock",
      expiresAt: new Date(Date.now() - 1),
    });
    const expired = await createJWT({ userId: "u-past", sid: past.id }, SECRET);
    expect((await get(`${url}/auth/me`, `session=${expired}`)).status).toBe(401);
    expect((await get(`${url}/auth/me`, other)).status).toBe(200);
  });

  it("logs out: revokes the session, clears the cookie, and the session no longer authenticates", async () => {
    const { url, sessions } = await harness.boot();
    const { session } = await signIn(url, "ada@demo.local");
    const response = await post(`${url}/auth/logout`, { cookie: session });
    expect(response.status).toBe(204);
    expect(cookiesSet(response).get("session")).toMatchObject({ value: "" });
    expect(cookiesSet(response).get("session")?.attributes).toEqual(
      expect.arrayContaining(["path=/", "httponly", "samesite=lax"]),
    );
    expect(sessions.size).toBe(0);
    expect((await get(`${url}/auth/me`, session)).status).toBe(401);
    // Logging out again, or without a session, still clears the cookie.
    for (const cookie of [session, undefined]) {
      const again = await post(`${url}/auth/logout`, { cookie });
      expect(again.status).toBe(204);
      expect(cookiesSet(again).get("session")).toMatchObject({ value: "" });
    }
  });

  it("logs out everywhere: revokes every session of the user, and only theirs", async () => {
    const { url, sessions } = await harness.boot();
    const laptop = await signIn(url, "ada@demo.local");
    const phone = await signIn(url, "ada@demo.local");
    const bob = await signIn(url, "bob@demo.local");
    expect(sessions.size).toBe(3);
    const response = await post(`${url}/auth/logout-all`, { cookie: phone.session });
    expect(response.status).toBe(204);
    expect(cookiesSet(response).get("session")).toMatchObject({ value: "" });
    expect((await get(`${url}/auth/me`, laptop.session)).status).toBe(401);
    expect((await get(`${url}/auth/me`, phone.session)).status).toBe(401);
    expect((await get(`${url}/auth/me`, bob.session)).status).toBe(200);
    expect(sessions.size).toBe(1);
    // A revoked session cannot log anyone out everywhere.
    const refused = await post(`${url}/auth/logout-all`, { cookie: laptop.session });
    expect(refused.status).toBe(401);
    expect((await get(`${url}/auth/me`, bob.session)).status).toBe(200);
  });

  it("needs a JSON content type on its POST routes, which a cross-site form cannot send", async () => {
    const { url, sessions } = await harness.boot();
    const { session } = await signIn(url, "ada@demo.local");
    for (const path of ["/auth/logout", "/auth/logout-all", "/auth/guest"]) {
      const response = await fetch(`${url}${path}`, {
        method: "POST",
        headers: { cookie: session, "content-type": "application/x-www-form-urlencoded" },
        body: "name=x",
      });
      expect(response.status, path).toBe(422);
      expect(cookiesSet(response).size).toBe(0);
    }
    expect(sessions.size).toBe(1);
  });
});

describe("the guest route", () => {
  it("creates a user through createUser and signs it in", async () => {
    const { url, guests } = await harness.boot();
    const response = await post(`${url}/auth/guest`, { body: { name: "Zed" } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ userId: "guest:1" });
    expect(guests).toEqual([{ name: "Zed" }]);
    const session = `session=${cookieValue(response, "session")}`;
    expect(await (await get(`${url}/auth/me`, session)).json()).toEqual({ userId: "guest:1" });
    const empty = await post(`${url}/auth/guest`);
    expect(await empty.json()).toEqual({ userId: "guest:2" });
    expect(guests).toEqual([{ name: "Zed" }, undefined]);
  });

  it("reads a body the app's own JSON parser already read", async () => {
    const app = express();
    app.use(express.json());
    const { url, guests } = await harness.boot({}, () => app);
    await post(`${url}/auth/guest`, { body: { name: "Parsed" } });
    expect(guests).toEqual([{ name: "Parsed" }]);
  });

  it("answers createUser's QuickdrawError with its code, and anything else as INTERNAL", async () => {
    const createUser = vi
      .fn<(input: unknown) => string>()
      .mockImplementationOnce(() => {
        throw new QuickdrawError("CONFLICT", "That name is taken");
      })
      .mockImplementationOnce(() => {
        throw new Error("the user table is down");
      })
      .mockImplementationOnce(() => "" as string);
    const { url, sessions, logger } = await harness.boot({ providers: [guest({ createUser })] });
    const taken = await post(`${url}/auth/guest`, { body: { name: "Ada" } });
    expect(taken.status).toBe(409);
    expect(await taken.json()).toEqual({ error: "CONFLICT", message: "That name is taken" });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await post(`${url}/auth/guest`, { body: {} });
      expect(failed.status).toBe(500);
      expect(await failed.json()).toEqual({ error: "INTERNAL", message: INTERNAL_MESSAGE });
    }
    expect(logger.at("error").map((entry) => entry.message)).toEqual([
      "Creating a guest user failed",
      "Creating a guest user failed",
    ]);
    const invalid = await fetch(`${url}/auth/guest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(invalid.status).toBe(422);
    expect(sessions.size).toBe(0);
  });
});

describe("rate limits", () => {
  it("limits the sign-in routes with createAuthLimiter by default: 20 per 15 minutes per IP", async () => {
    const { url } = await harness.boot({ rateLimit: undefined });
    for (let attempt = 0; attempt < 20; attempt += 1) {
      expect((await get(`${url}/auth/mock/start`)).status).toBe(302);
    }
    const limited = await get(`${url}/auth/mock/callback`);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ error: "Rate limit exceeded" });
    expect(limited.headers.get("retry-after")).not.toBeNull();
    // The session routes count separately, and the mock provider's endpoints not at all.
    expect((await get(`${url}/auth/me`)).status).toBe(401);
  });

  it("limits the session routes with createAuthStatusLimiter by default: 120 per 15 minutes", async () => {
    const { url } = await harness.boot({ rateLimit: undefined });
    const answers = await Promise.all(
      Array.from({ length: 121 }, async () => (await get(`${url}/auth/me`)).status),
    );
    expect(answers.filter((status) => status === 401)).toHaveLength(120);
    expect(answers.filter((status) => status === 429)).toHaveLength(1);
  });

  it("takes the app's own limiters", async () => {
    const { url } = await harness.boot({
      rateLimit: { signIn: createAuthLimiter({ max: 1 }), session: createAuthLimiter({ max: 2 }) },
    });
    expect((await get(`${url}/auth/mock/start`)).status).toBe(302);
    expect((await get(`${url}/auth/mock/start`)).status).toBe(429);
    expect((await get(`${url}/auth/me`)).status).toBe(401);
    expect((await get(`${url}/auth/me`)).status).toBe(401);
    expect((await get(`${url}/auth/me`)).status).toBe(429);
  });
});

describe("the mock provider", () => {
  it("is left out unless isMockOAuthEnabled(), and refuses again at request time in production", async () => {
    const off = await harness.boot({}, () => {
      vi.stubEnv("ENABLE_MOCK_OAUTH", "false");
      return express();
    });
    // Nothing is mounted: the requests fall through to Express's own 404.
    for (const path of ["/auth/mock/start", "/auth/mock/provider/authorize"]) {
      expect((await get(`${off.url}${path}`)).status).toBe(404);
    }
    expect(off.logger.entries).toEqual([]);

    const on = await harness.boot();
    vi.stubEnv("NODE_ENV", "production");
    for (const path of ["/auth/mock/start", "/auth/mock/callback"]) {
      expect(await (await get(`${on.url}${path}`)).json()).toEqual({
        error: "NOT_FOUND",
        message: "Not found",
      });
    }
  });

  it("passes other requests on to the app", async () => {
    const app = express();
    const { url } = await harness.boot({}, () => app);
    app.get("/auth/discord-activity/token", (_req, res) => {
      res.json({ mine: true });
    });
    expect(await (await get(`${url}/auth/discord-activity/token`)).json()).toEqual({ mine: true });
    expect((await get(`${url}/auth/google/start`)).status).toBe(404);
    expect((await post(`${url}/auth/me`)).status).toBe(404);
  });

  it("serves the routes under basePath, whatever the app mounts them at", async () => {
    const app = express();
    const { url } = await harness.boot({ basePath: "/api/auth/" }, () => app);
    const response = await get(`${url}/api/auth/mock/start`);
    expect(new URL(locationOf(response)).searchParams.get("redirect_uri")).toBe(
      `${url}/api/auth/mock/callback`,
    );
    expect(cookiesSet(response).get("qd_oauth")?.attributes).toContain("path=/api/auth");
    expect((await get(`${url}/auth/mock/start`)).status).toBe(404);
  });
});

describe("the options", () => {
  const sessions = createMemorySessionStore();
  const base = {
    providers: [mock({ listUsers: () => Promise.resolve([]) })],
    sessions,
    jwtSecret: SECRET,
    onLogin: () => "u",
    allowedOrigins: [APP_ORIGIN],
    publicUrl: "https://api.test",
    rateLimit: false as const,
  };

  it.each([
    [
      { jwtSecret: "short" },
      "createAuthRoutes: jwtSecret must be a secret of at least 32 characters",
    ],
    [
      { sessions: {} },
      "createAuthRoutes: sessions must be a SessionStore (create, get, revoke, revokeAll)",
    ],
    [{ onLogin: undefined }, "createAuthRoutes: onLogin is required"],
    [
      { onRevoke: "disconnect" },
      "createAuthRoutes: onRevoke must be a function of (userId, sessionId)",
    ],
    [{ allowedOrigins: [] }, "createAuthRoutes: allowedOrigins must list the web app's origins"],
    [{ allowedOrigins: ["*"] }, "allowedOrigins entries are origins such as"],
    [{ allowedOrigins: ["https://app.test/path"] }, "allowedOrigins entries are origins such as"],
    [{ allowedOrigins: [/app\.test/] }, "an allowedOrigins pattern must match whole origins"],
    [
      { allowedOrigins: [/^https:\/\/app\.test$/g] },
      "an allowedOrigins pattern must match whole origins",
    ],
    [{ publicUrl: "api.test" }, "createAuthRoutes: publicUrl must be the API's public URL"],
    [{ successPath: "//evil.test" }, "createAuthRoutes: successPath must be a path on the web app"],
    [{ errorPath: "/\\evil.test" }, "createAuthRoutes: errorPath must be a path on the web app"],
    [
      { successPath: "https://evil.test" },
      "createAuthRoutes: successPath must be a path on the web app",
    ],
    [{ cookie: { maxAgeMs: 10 } }, "createAuthRoutes: cookie.maxAgeMs must be a whole number"],
    [{ cookie: { name: "bad name" } }, "createAuthRoutes: cookie.name must be a cookie name"],
    [
      { rateLimit: { signIn: 3 } },
      "createAuthRoutes: rateLimit.signIn must be an Express middleware",
    ],
    [{ providers: [] }, "createAuthRoutes: providers must list at least one provider"],
    [
      {
        providers: [
          google({ clientId: "a", clientSecret: "b" }),
          google({ clientId: "c", clientSecret: "d" }),
        ],
      },
      'createAuthRoutes: two providers have the id "google"',
    ],
    [
      { providers: [{ ...discord({ clientId: "a", clientSecret: "b" }), id: "Discord!" }] },
      "createAuthRoutes: a provider id is lowercase letters, digits and hyphens",
    ],
  ])("refuses %j", (overrides, message) => {
    expect(() => createAuthRoutes({ ...base, ...(overrides as object) } as never)).toThrow(message);
  });

  it("normalizes allowed origins and publicUrl", async () => {
    vi.stubEnv("ENABLE_MOCK_OAUTH", "true");
    const app = express();
    app.use(
      createAuthRoutes({
        ...base,
        allowedOrigins: ["HTTP://App.Test/"],
        publicUrl: "https://api.test/v1/",
      }),
    );
    const { server, url } = await listen(app);
    harness.servers.push(server);
    const response = await get(`${url}/auth/mock/start?returnTo=http://app.test/x`);
    expect(new URL(locationOf(response)).searchParams.get("redirect_uri")).toBe(
      "https://api.test/v1/auth/mock/callback",
    );
  });
});
