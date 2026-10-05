// The auth routes kit (RFC 0003 section 12.6) over real requests to an
// Express app in the test process, signing in through the mock provider: the
// state and return-origin refusals first, then the sign-in, the session
// routes, the guest route, the rate limits and the options.

import { createRequire } from "node:module";
import express from "express";
import { describe, expect, it, vi } from "vitest";
import { INTERNAL_MESSAGE, QuickdrawError } from "../../../protocol/errors";
import { captureLogger } from "../../__tests__/fixtures";
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

  it("sets a Secure __Host- cookie over HTTPS, a Secure plain one in production over plain HTTP, and a SameSite=None one when asked", async () => {
    const production = await harness.boot();
    vi.stubEnv("NODE_ENV", "production");
    const https = { "x-forwarded-proto": "https" };
    const secure = await post(`${production.url}/auth/guest`, { body: {}, headers: https });
    const hostCookie = cookiesSet(secure).get("__Host-session");
    expect(hostCookie?.attributes).toEqual(
      expect.arrayContaining(["secure", "samesite=lax", "httponly", "path=/"]),
    );
    expect(hostCookie?.attributes.some((attribute) => attribute.startsWith("domain="))).toBe(false);
    expect(cookiesSet(secure).has("session")).toBe(false);
    // A request that came over plain HTTP gets the name the transports read there, Secure in
    // production all the same.
    const plain = cookiesSet(await post(`${production.url}/auth/guest`, { body: {} }));
    expect(plain.has("__Host-session")).toBe(false);
    expect(plain.get("session")?.attributes).toContain("secure");
    vi.stubEnv("NODE_ENV", "test");

    const proxied = await harness.boot();
    proxied.app.set("trust proxy", true);
    const overHttps = await post(`${proxied.url}/auth/guest`, { body: {}, headers: https });
    expect(cookiesSet(overHttps).get("__Host-session")?.attributes).toContain("secure");

    // A cookie for a domain cannot be __Host-: it keeps the plain name, over HTTPS too.
    const crossSite = await harness.boot({ cookie: { sameSite: "none", domain: "app.test" } });
    const none = await post(`${crossSite.url}/auth/guest`, { body: {}, headers: https });
    expect(cookiesSet(none).get("session")?.attributes).toEqual(
      expect.arrayContaining(["samesite=none", "secure", "domain=app.test"]),
    );
    vi.stubEnv("COOKIE_DOMAIN", "env.test");
    const fromEnv = await harness.boot({ cookie: { secure: true } });
    const envCookie = cookiesSet(await post(`${fromEnv.url}/auth/guest`, { body: {} }));
    expect(envCookie.get("session")?.attributes).toContain("domain=env.test");
  });

  it("signs in with __Host- state and session cookies on a secure request, and reads only those back", async () => {
    const { url } = await harness.boot();
    const https = { "x-forwarded-proto": "https" };
    const started = await get(`${url}/auth/mock/start`, undefined, https);
    const state = cookiesSet(started).get("__Host-qd_oauth");
    expect(state?.attributes).toEqual(expect.arrayContaining(["secure", "httponly", "path=/"]));
    expect(cookiesSet(started).has("qd_oauth")).toBe(false);
    const stateCookie = `__Host-qd_oauth=${state?.value ?? ""}`;
    const callbackUrl = await consent(
      { stateCookie, authorizeUrl: new URL(locationOf(started)) },
      "ada@demo.local",
    );
    // The plain state name is not read on a secure request.
    const plain = await get(callbackUrl.href, `qd_oauth=${state?.value ?? ""}`, https);
    expect(new URL(locationOf(plain)).searchParams.get("error")).toBe("state");
    const callback = await get(callbackUrl.href, stateCookie, https);
    expect(cookiesSet(callback).get("__Host-qd_oauth")?.value).toBe("");
    const token = cookieValue(callback, "__Host-session");
    expect(cookiesSet(callback).get("__Host-session")?.attributes).toEqual(
      expect.arrayContaining(["secure", "httponly", "path=/"]),
    );
    expect(await (await get(`${url}/auth/me`, `__Host-session=${token}`, https)).json()).toEqual({
      userId: userIdOf("ada@demo.local"),
    });
    expect((await get(`${url}/auth/me`, `session=${token}`, https)).status).toBe(401);
    const out = await post(`${url}/auth/logout`, {
      cookie: `__Host-session=${token}`,
      headers: https,
    });
    expect(cookiesSet(out).get("__Host-session")?.value).toBe("");
    // A name the app gives is used as it is.
    const named = await harness.boot({ cookie: { secure: true, name: "sid" } });
    const guestSignIn = await post(`${named.url}/auth/guest`, { body: {}, headers: https });
    expect(cookiesSet(guestSignIn).has("sid")).toBe(true);
    // `secure: true` makes the cookie Secure; its name still follows the request, as the
    // transports' reads do, so a plain HTTP request gets a Secure `session`.
    const forced = await harness.boot({ cookie: { secure: true } });
    const forcedPlain = cookiesSet(await post(`${forced.url}/auth/guest`, { body: {} }));
    expect(forcedPlain.get("session")?.attributes).toContain("secure");
  });

  it("names the callback's cookie for the page it returns to, which an OAuth callback has no Origin of its own for", async () => {
    // An https: web app on a plain HTTP loopback API (a development setup): its requests carry
    // an https: Origin, so the transports read __Host-session; the callback sets that name.
    const secureApp = "https://app.test";
    const { url } = await harness.boot({ allowedOrigins: [secureApp] });
    const started = await start(url);
    const callbackUrl = await consent(started, "ada@demo.local");
    const callback = await get(callbackUrl.href, started.stateCookie);
    expect(locationOf(callback)).toBe(`${secureApp}/`);
    const token = cookieValue(callback, "__Host-session");
    expect(cookiesSet(callback).get("__Host-session")?.attributes).toContain("secure");
    expect(
      await (await get(`${url}/auth/me`, `__Host-session=${token}`, { origin: secureApp })).json(),
    ).toEqual({ userId: userIdOf("ada@demo.local") });
  });

  it("refuses a __Host- cookie name with a domain, and warns when the transports cannot see the cookie's domain", async () => {
    await expect(
      harness.boot({ cookie: { name: "__Host-sid", domain: "app.test" } }),
    ).rejects.toThrow('cookie.name cannot start with "__Host-"');
    const optionOnly = await harness.boot({ cookie: { domain: "app.test" } });
    expect(optionOnly.logger.at("warn").map((entry) => entry.message)).toEqual([
      expect.stringContaining("cookie.domain is set and COOKIE_DOMAIN is not"),
    ]);
    const named = await harness.boot({ cookie: { domain: "app.test", name: "session" } });
    expect(named.logger.at("warn")).toEqual([]);
    vi.stubEnv("COOKIE_DOMAIN", "app.test");
    const both = await harness.boot({ cookie: { domain: "app.test" } });
    expect(both.logger.at("warn")).toEqual([]);
    const cleared = await harness.boot({ cookie: { domain: "" } });
    expect(cleared.logger.at("warn").map((entry) => entry.message)).toEqual([
      expect.stringContaining('cookie.domain is "" while COOKIE_DOMAIN is set'),
    ]);
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

  it("answers the name createUser gave, and the token for cookie-less clients when asked", async () => {
    const { url } = await harness.boot({
      providers: [
        guest({ createUser: () => ({ userId: "guest:ada", name: "Ada#4821" }), token: true }),
      ],
    });
    const response = await post(`${url}/auth/guest`, { body: { name: "Ada" } });
    const answer = (await response.json()) as { userId: string; name: string; token: string };
    expect(answer).toEqual({ userId: "guest:ada", name: "Ada#4821", token: expect.any(String) });
    // The token is the cookie's: a bearer token signs the guest in too.
    expect(answer.token).toBe(cookieValue(response, "session"));
    const me = await get(`${url}/auth/me`, undefined, { authorization: `Bearer ${answer.token}` });
    expect(await me.json()).toEqual({ userId: "guest:ada" });
    expect(() => guest({ createUser: () => "u", token: "yes" as never })).toThrow(
      "guest(): token must be true or false",
    );
  });

  it("refuses a createUser answer that is neither an id nor { userId, name? }", async () => {
    const { url } = await harness.boot({
      providers: [guest({ createUser: () => ({ userId: "u", name: 3 }) as never })],
    });
    const failed = await post(`${url}/auth/guest`, { body: {} });
    expect(failed.status).toBe(500);
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
  it("limits the sign-in routes with createAuthLimiter by default: 60 per 15 minutes per IP", async () => {
    const { url } = await harness.boot({ rateLimit: undefined });
    for (let attempt = 0; attempt < 60; attempt += 1) {
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

  it("limits the provider list on its own, 60 per minute by default, so login pages cannot use up sign-outs (finding F11.3)", async () => {
    const { url } = await harness.boot({ rateLimit: undefined });
    const answers = await Promise.all(
      Array.from({ length: 121 }, async () => (await get(`${url}/auth/providers`)).status),
    );
    expect((await get(`${url}/auth/me`)).status).toBe(401);
    expect((await post(`${url}/auth/logout`)).status).toBe(204);
    expect(answers.filter((status) => status === 200)).toHaveLength(60);
    expect(answers.filter((status) => status === 429)).toHaveLength(61);
  });

  it("takes the app's own limiters", async () => {
    const { url } = await harness.boot({
      rateLimit: {
        signIn: createAuthLimiter({ max: 1 }),
        session: createAuthLimiter({ max: 2 }),
        providers: createAuthLimiter({ max: 1 }),
      },
    });
    expect((await get(`${url}/auth/mock/start`)).status).toBe(302);
    expect((await get(`${url}/auth/mock/start`)).status).toBe(429);
    expect((await get(`${url}/auth/providers`)).status).toBe(200);
    expect((await get(`${url}/auth/providers`)).status).toBe(429);
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
      { providers: [undefined, google.optional({ clientId: undefined, clientSecret: undefined })] },
      "createAuthRoutes: providers must list at least one provider",
    ],
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

  it("skips the providers left out in place", async () => {
    vi.stubEnv("ENABLE_MOCK_OAUTH", "true");
    const app = express();
    app.use(
      createAuthRoutes({
        ...base,
        providers: [
          google.optional({ clientId: undefined, clientSecret: undefined }),
          false,
          null,
          ...base.providers,
        ],
      }),
    );
    const { server, url } = await listen(app);
    harness.servers.push(server);
    expect((await get(`${url}/auth/google/start`)).status).toBe(404);
    expect((await get(`${url}/auth/mock/start?returnTo=http://app.test/x`)).status).toBe(302);
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

describe("the providers it serves (findings F9.1, F10.1 and F10.3)", () => {
  const sessions = createMemorySessionStore();
  const base = {
    sessions,
    jwtSecret: SECRET,
    onLogin: () => "u",
    allowedOrigins: [APP_ORIGIN],
    publicUrl: "https://api.test",
    rateLimit: false as const,
  };

  /** Mounts the routes made with `providers`, and answers their list as served over HTTP. */
  async function served(providers: Parameters<typeof createAuthRoutes>[0]["providers"]) {
    const logger = captureLogger();
    const routes = createAuthRoutes({ ...base, providers, logger });
    const app = express();
    app.use(routes);
    const { server, url } = await listen(app);
    harness.servers.push(server);
    const answer = async () => {
      const response = await get(`${url}/auth/providers`);
      expect(response.headers.get("cache-control")).toBe("no-store");
      return (await response.json()) as unknown;
    };
    return { routes, answer, logger };
  }

  it("lists every sign-in it serves, in order, with a name and a kind, the mock while it is enabled", async () => {
    vi.stubEnv("ENABLE_MOCK_OAUTH", "true");
    const all = [
      { id: "google", name: "Google", kind: "oauth" },
      { id: "discord", name: "Discord", kind: "oauth" },
      { id: "mock", name: "Mock", kind: "mock" },
      { id: "guest", name: "Guest", kind: "guest" },
      { id: "acme", name: "Acme ID", kind: "oauth" },
      { id: "plain", name: "plain", kind: "oauth" },
    ];
    const own = (id: string, name?: string) => ({
      kind: "oauth" as const,
      id,
      ...(name === undefined ? {} : { name }),
      authorizeUrl: () => "https://id.test/authorize",
      profile: () => Promise.reject(new Error("unused")),
    });
    const { routes, answer, logger } = await served([
      google({ clientId: "a", clientSecret: "b" }),
      discord({ clientId: "c", clientSecret: "d" }),
      mock({ listUsers: () => Promise.resolve([]) }),
      guest({ createUser: () => "g" }),
      own("acme", "Acme ID"),
      own("plain"),
    ]);
    expect(await answer()).toEqual({ providers: all });
    expect(routes.providers()).toEqual(all);
    // The mock's routes refuse once it is off, and the list says so.
    vi.stubEnv("ENABLE_MOCK_OAUTH", "false");
    expect(await answer()).toEqual({ providers: all.filter((entry) => entry.id !== "mock") });
    expect(logger.at("warn")).toEqual([]);
  });

  it("lists none where nothing can sign in, and says so when it is made; one where one can", async () => {
    vi.stubEnv("ENABLE_MOCK_OAUTH", "false");
    const none = await served([
      google.optional({ clientId: undefined, clientSecret: undefined }),
      mock({ listUsers: () => Promise.resolve([]) }),
    ]);
    expect(await none.answer()).toEqual({ providers: [] });
    expect(none.logger.at("warn").map((entry) => entry.message)).toEqual([
      expect.stringContaining("createAuthRoutes: no provider can sign anyone in"),
    ]);
    const one = await served([guest({ createUser: () => "g" })]);
    expect(await one.answer()).toEqual({
      providers: [{ id: "guest", name: "Guest", kind: "guest" }],
    });
  });
});

describe("a loopback publicUrl (findings F9.2 and F10.2)", () => {
  const sessions = createMemorySessionStore();
  const options = {
    providers: [guest({ createUser: () => "g" })],
    sessions,
    jwtSecret: SECRET,
    onLogin: () => "u",
    publicUrl: "http://localhost:5016",
    rateLimit: false as const,
  };

  it("warns when it is made for public pages, and logs one error when a request arrives for another host", async () => {
    const logger = captureLogger();
    const app = express();
    app.use(createAuthRoutes({ ...options, allowedOrigins: ["https://chat.acme.dev"], logger }));
    expect(logger.at("warn").map((entry) => entry.message)).toEqual([
      "createAuthRoutes: publicUrl is http://localhost:5016, but allowedOrigins lists only public pages (https://chat.acme.dev): a sign-in started from them redirects to an address only this machine reaches. Set publicUrl to the API's public URL.",
    ]);
    const { server, url } = await listen(app);
    harness.servers.push(server);
    // Requests for this machine are fine; the first for a public host is logged, once.
    await get(`${url}/auth/me`);
    expect(logger.at("error")).toEqual([]);
    for (let round = 0; round < 2; round += 1) {
      await get(`${url}/auth/me`, undefined, { "x-forwarded-host": "chat-api.acme.dev" });
    }
    expect(logger.at("error")).toEqual([
      {
        level: "error",
        message:
          "createAuthRoutes: publicUrl is http://localhost:5016, but requests arrive for chat-api.acme.dev: set publicUrl to the API's public URL (sign-in redirects are built from it)",
        meta: {
          category: "quickdraw.auth",
          publicUrl: "http://localhost:5016",
          host: "chat-api.acme.dev",
        },
      },
    ]);
  });

  it("says nothing for a development setup on this machine, or a public publicUrl", async () => {
    const local = captureLogger();
    createAuthRoutes({ ...options, allowedOrigins: ["http://localhost:3000"], logger: local });
    const deployed = captureLogger();
    const app = express();
    app.use(
      createAuthRoutes({
        ...options,
        publicUrl: "https://chat-api.acme.dev",
        allowedOrigins: ["https://chat.acme.dev"],
        logger: deployed,
      }),
    );
    const { server, url } = await listen(app);
    harness.servers.push(server);
    await get(`${url}/auth/me`, undefined, { "x-forwarded-host": "chat-api.acme.dev" });
    expect([local.entries, deployed.entries]).toEqual([[], []]);
  });
});
