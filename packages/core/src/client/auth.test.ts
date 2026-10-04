// The token helpers of `./client` outside a browser with working storage:
// on a server (no `window`), in React Native (`window` without
// `localStorage`), with storage turned off (it throws), and without
// `process` for the API's URL; and the auth routes kit's browser helpers
// against the kit itself (`createAuthRoutes`, signing in through the mock
// provider), with the session as a stored bearer token, since Node's fetch
// keeps no cookies. Runs under Node, which has no `window`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_ORIGIN, authHarness, get, signIn } from "../server/auth/routes/__tests__/harness";
import {
  clearAuthToken,
  getAuthToken,
  setAuthToken,
  signInUrl,
  signOut,
  signOutEverywhere,
} from "./auth";

/** A `window` with an event target, as React Native's global object is. */
function stubWindow() {
  const dispatched: string[] = [];
  vi.stubGlobal("window", {
    dispatchEvent: (event: { readonly type: string }) => dispatched.push(event.type),
  });
  return dispatched;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("the token helpers", () => {
  it("keep nothing on a server, where there is no window", () => {
    expect(typeof window).toBe("undefined");
    setAuthToken("server-token");
    expect(getAuthToken()).toBeNull();
    clearAuthToken();
  });

  it("keep the token in memory where window exists without localStorage, as in React Native", () => {
    const dispatched = stubWindow();
    vi.stubGlobal("localStorage", undefined);
    expect(getAuthToken()).toBeNull();
    setAuthToken("native-token");
    expect(getAuthToken()).toBe("native-token");
    clearAuthToken();
    expect(getAuthToken()).toBeNull();
    expect(dispatched).toEqual(["auth-token-changed", "auth-token-changed"]);
  });

  it("keep the token in memory when using localStorage throws, as with storage turned off", () => {
    stubWindow();
    const refuse = (): never => {
      throw new Error("SecurityError: storage is disabled");
    };
    vi.stubGlobal("localStorage", { getItem: refuse, setItem: refuse, removeItem: refuse });
    setAuthToken("private-token");
    expect(getAuthToken()).toBe("private-token");
    clearAuthToken();
    expect(getAuthToken()).toBeNull();
  });

  it("keep the token in localStorage where it works", () => {
    stubWindow();
    const stored = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
    });
    setAuthToken("browser-token");
    expect(stored.get("auth_token")).toBe("browser-token");
    stored.set("auth_token", "set elsewhere");
    expect(getAuthToken()).toBe("set elsewhere");
    clearAuthToken();
    expect(stored.has("auth_token")).toBe(false);
  });
});

const harness = authHarness();

/** A `window` with working storage, as a browser's. */
function stubBrowser(): void {
  stubWindow();
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
  });
}

/** The session token a mock sign-in as `email` set as its cookie. */
async function sessionToken(url: string, email: string): Promise<string> {
  const { session } = await signIn(url, email);
  return session.slice("session=".length);
}

/** `GET /auth/me` with `token` as a bearer token. */
function me(url: string, token: string): Promise<Response> {
  return fetch(`${url}/auth/me`, { headers: { Authorization: `Bearer ${token}` } });
}

describe("signInUrl", () => {
  it("names the kit's start route, which redirects to the provider", async () => {
    const { url } = await harness.boot();
    const started = signInUrl("mock", { apiUrl: url, returnTo: `${APP_ORIGIN}/board` });
    expect(started).toBe(
      `${url}/auth/mock/start?returnTo=${encodeURIComponent(`${APP_ORIGIN}/board`)}`,
    );
    const response = await get(started);
    expect(response.status).toBe(302);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe(
      "/auth/mock/provider/authorize",
    );
  });

  it("returns to the current page's origin by default, and takes the API's URL and base path", () => {
    vi.stubGlobal("location", { origin: "https://app.example.com" });
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://api.example.com/");
    expect(signInUrl("google")).toBe(
      "https://api.example.com/auth/google/start?returnTo=https%3A%2F%2Fapp.example.com",
    );
    vi.unstubAllGlobals();
    expect(signInUrl("discord", { apiUrl: "https://api.example.com", basePath: "/v1/auth/" })).toBe(
      "https://api.example.com/v1/auth/discord/start",
    );
  });

  it("falls back to localhost where there is no process, as in React Native", () => {
    const held = globalThis.process;
    let url: string;
    // Synchronous, so nothing else runs while `process` is gone.
    Reflect.deleteProperty(globalThis, "process");
    try {
      url = signInUrl("google");
    } finally {
      globalThis.process = held;
    }
    expect(url).toBe("http://localhost:4000/auth/google/start");
  });

  it("refuses a provider id or a base path the routes cannot have", () => {
    expect(() => signInUrl("Google")).toThrow(
      "signInUrl: a provider id is lowercase letters, digits and hyphens; got Google",
    );
    expect(() => signInUrl("../me")).toThrow(TypeError);
    expect(() => signInUrl("google", { basePath: "auth" })).toThrow(
      'signInUrl: basePath must start with "/", as createAuthRoutes takes it',
    );
  });
});

describe("signOut and signOutEverywhere", () => {
  it("signs out through the kit's logout: the session is revoked and the stored token forgotten", async () => {
    const { url } = await harness.boot();
    const token = await sessionToken(url, "ada@demo.local");
    expect((await me(url, token)).status).toBe(200);
    stubBrowser();
    setAuthToken(token);
    await signOut({ apiUrl: url });
    expect((await me(url, token)).status).toBe(401);
    expect(getAuthToken()).toBeNull();
  });

  it("signs the user out of every session, and refuses without a live one", async () => {
    const { url } = await harness.boot();
    const here = await sessionToken(url, "ada@demo.local");
    const elsewhere = await sessionToken(url, "ada@demo.local");
    stubBrowser();
    setAuthToken(here);
    await signOutEverywhere({ apiUrl: url });
    expect([(await me(url, here)).status, (await me(url, elsewhere)).status]).toEqual([401, 401]);
    expect(getAuthToken()).toBeNull();
    await expect(signOutEverywhere({ apiUrl: url })).rejects.toMatchObject({
      name: "QuickdrawError",
      code: "UNAUTHENTICATED",
    });
  });

  it("posts JSON with the cookie and the stored token, and rejects when the server refuses or cannot be reached", async () => {
    stubBrowser();
    setAuthToken("stored-token");
    const requests: [string, RequestInit][] = [];
    vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
      requests.push([url, init]);
      return Promise.resolve(
        new Response(JSON.stringify({ error: "RATE_LIMITED", message: "Slow down" }), {
          status: 429,
        }),
      );
    });
    await expect(signOut({ apiUrl: "https://api.example.com" })).rejects.toMatchObject({
      code: "RATE_LIMITED",
      message: "Slow down",
    });
    expect(requests).toEqual([
      [
        "https://api.example.com/auth/logout",
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json", Authorization: "Bearer stored-token" },
          body: "{}",
        },
      ],
    ]);
    // Refused or not, the stored token is gone, and nothing is sent as a token after it.
    expect(getAuthToken()).toBeNull();
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    await expect(signOutEverywhere({ apiUrl: "https://api.example.com" })).rejects.toMatchObject({
      code: "INTERNAL",
      message: "signOutEverywhere: https://api.example.com/auth/logout-all could not be reached",
    });
  });
});
