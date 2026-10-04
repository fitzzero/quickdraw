// The OAuth state cookie's contents and the record of redeemed states, and
// the origin allowlist, below the routes that use them.

import { describe, expect, it, vi } from "vitest";
import { originAllowlist } from "./origins";
import {
  decodePending,
  encodePending,
  newState,
  OAUTH_STATE_TTL_MS,
  redeemedStates,
  stateMatches,
} from "./state";

describe("the state cookie", () => {
  it("round-trips a pending sign-in and reads anything else as none", () => {
    const pending = { state: newState(), provider: "mock", origin: "http://app.test", issuedAt: 1 };
    expect(pending.state).toMatch(/^[\w-]{43}$/);
    expect(decodePending(encodePending(pending))).toEqual(pending);
    const encoded = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const raw of [
      undefined,
      "",
      "%%%",
      encoded(null),
      encoded("text"),
      encoded({ ...pending, issuedAt: "1" }),
      encoded({ ...pending, state: undefined }),
    ]) {
      expect(decodePending(raw)).toBeNull();
    }
  });

  it("matches only its own state, for its provider, within its lifetime", () => {
    const now = 1_000_000_000;
    const pending = { state: "abc", provider: "mock", origin: "http://app.test", issuedAt: now };
    expect(stateMatches(pending, "mock", "abc", now)).toBe(true);
    expect(stateMatches(pending, "mock", "abc", now + OAUTH_STATE_TTL_MS)).toBe(true);
    expect(stateMatches(pending, "mock", "abc", now + OAUTH_STATE_TTL_MS + 1)).toBe(false);
    expect(stateMatches(pending, "mock", "abc", now - 1)).toBe(false);
    expect(stateMatches(pending, "google", "abc", now)).toBe(false);
    expect(stateMatches(pending, "mock", "abd", now)).toBe(false);
    expect(stateMatches(pending, "mock", "ab", now)).toBe(false);
    expect(stateMatches(pending, "mock", null, now)).toBe(false);
  });

  it("redeems a state once, and forgets it after its lifetime or past the cap", () => {
    const redeemed = redeemedStates();
    expect(redeemed.redeem("a", 0)).toBe(true);
    expect(redeemed.redeem("a", 1)).toBe(false);
    expect(redeemed.redeem("a", OAUTH_STATE_TTL_MS + 1)).toBe(true);
    const capped = redeemedStates();
    for (let index = 0; index < 10_001; index += 1) {
      capped.redeem(`s${index}`, 0);
    }
    expect(capped.redeem("s0", 0)).toBe(true);
    expect(capped.redeem("s10000", 0)).toBe(false);
  });
});

describe("originAllowlist", () => {
  it("allows the origin of a URL on a listed origin or a matching pattern, and nothing from the environment", () => {
    vi.stubEnv("CLIENT_URL", "https://from-env.test");
    vi.stubEnv("EXTRA_ALLOWED_ORIGINS", "https://extra.test");
    vi.stubEnv("NODE_ENV", "development");
    try {
      const list = originAllowlist(
        ["https://app.test", "http://LOCALHOST:3000/", /^https:\/\/[a-z]+\.preview\.test$/],
        "test",
      );
      expect(list.fallback).toBe("https://app.test");
      expect(list.allowed("https://app.test/a/b?c")).toBe("https://app.test");
      expect(list.allowed("http://localhost:3000")).toBe("http://localhost:3000");
      expect(list.allowed("https://pr.preview.test")).toBe("https://pr.preview.test");
      for (const denied of [
        "https://from-env.test",
        "https://extra.test",
        "http://localhost:3001",
        "https://a-b-3000.app.github.dev",
        "https://x.pr.preview.test",
        "null",
        "",
        undefined,
      ]) {
        expect(list.allowed(denied), String(denied)).toBeNull();
      }
      expect(originAllowlist([/^https:\/\/a\.test$/], "test").fallback).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("matches a pattern against the whole origin, whatever alternatives it holds", () => {
    // Meant: ^https://(app|staging).example.com$, written without the group.
    const loose = originAllowlist([/^https:\/\/app|staging\.example\.com$/], "test");
    expect(loose.allowed("https://app.attacker.net/x")).toBeNull();
    expect(loose.allowed("https://staging.example.com")).toBeNull();
    const grouped = originAllowlist([/^https:\/\/(app|staging)\.example\.com$/i], "test");
    expect(grouped.allowed("https://app.example.com/x")).toBe("https://app.example.com");
    expect(grouped.allowed("https://STAGING.example.com")).toBe("https://staging.example.com");
    expect(grouped.allowed("https://app.attacker.net")).toBeNull();
    expect(grouped.allowed("https://app.example.com.attacker.net")).toBeNull();
  });

  it("refuses entries that are not origins or anchored patterns", () => {
    for (const entry of [
      "*",
      "app.test",
      "ftp://app.test",
      "https://user@app.test",
      "https://app.test/path",
      "https://app.test?x",
      /^https:\/\/app\.test/,
      /https:\/\/app\.test$/,
      /^https:\/\/app\.test\$/,
      /^https:\/\/app\.test$/y,
    ]) {
      expect(() => originAllowlist([entry], "owner"), String(entry)).toThrow(/^owner: /);
    }
    expect(() => originAllowlist([], "owner")).toThrow("owner: allowedOrigins must list");
    expect(originAllowlist([], "owner", true).allowed("https://app.test")).toBeNull();
  });
});
