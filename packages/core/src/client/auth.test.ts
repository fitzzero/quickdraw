// The token helpers of `./client` outside a browser with working storage:
// on a server (no `window`), in React Native (`window` without
// `localStorage`), with storage turned off (it throws), and without
// `process` for the API's URL. Runs under Node, which has no `window`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { clearAuthToken, getAuthToken, getOAuthUrl, setAuthToken } from "./auth";

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

describe("getOAuthUrl", () => {
  it("takes the API's URL given, else NEXT_PUBLIC_API_URL, else localhost", () => {
    expect(getOAuthUrl("google", "https://api.example.com")).toBe(
      "https://api.example.com/auth/google",
    );
    vi.stubEnv("NEXT_PUBLIC_API_URL", "https://env.example.com");
    expect(getOAuthUrl("discord")).toBe("https://env.example.com/auth/discord");
  });

  it("falls back to localhost where there is no process, as in React Native", () => {
    const held = globalThis.process;
    let url: string;
    // Synchronous, so nothing else runs while `process` is gone.
    Reflect.deleteProperty(globalThis, "process");
    try {
      url = getOAuthUrl("google");
    } finally {
      globalThis.process = held;
    }
    expect(url).toBe("http://localhost:4000/auth/google");
  });
});
