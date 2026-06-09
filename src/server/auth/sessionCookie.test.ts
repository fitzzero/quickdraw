// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  SESSION_COOKIE,
  setSessionCookie,
  type CookieResponse,
  type CookieSettings,
} from "./sessionCookie";

interface RecordedCall {
  name: string;
  value?: string;
  options: CookieSettings;
}

function createFakeResponse(): { res: CookieResponse; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const res: CookieResponse = {
    cookie(name, value, options) {
      calls.push({ name, value, options });
      return res;
    },
    clearCookie(name, options) {
      calls.push({ name, options });
      return res;
    },
  };
  return { res, calls };
}

describe("session cookie", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalDomain = process.env.COOKIE_DOMAIN;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalDomain === undefined) delete process.env.COOKIE_DOMAIN;
    else process.env.COOKIE_DOMAIN = originalDomain;
  });

  it("sets a lax, non-secure cookie in dev", () => {
    process.env.NODE_ENV = "development";
    const { res, calls } = createFakeResponse();
    setSessionCookie(res, "jwt-value");

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe(SESSION_COOKIE);
    expect(calls[0].value).toBe("jwt-value");
    expect(calls[0].options).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
    });
    expect(calls[0].options.maxAge).toBeGreaterThan(0);
  });

  it("sets a none+secure cookie in production with COOKIE_DOMAIN", () => {
    process.env.NODE_ENV = "production";
    process.env.COOKIE_DOMAIN = ".example.com";
    const { res, calls } = createFakeResponse();
    setSessionCookie(res, "jwt-value");

    expect(calls[0].options).toMatchObject({
      secure: true,
      sameSite: "none",
      domain: ".example.com",
    });
  });

  it("supports custom cookie name and max age", () => {
    const { res, calls } = createFakeResponse();
    setSessionCookie(res, "jwt-value", { cookieName: "auth", maxAgeMs: 1000 });
    expect(calls[0].name).toBe("auth");
    expect(calls[0].options.maxAge).toBe(1000);
  });

  it("clears with matching options (no maxAge)", () => {
    process.env.NODE_ENV = "development";
    const { res, calls } = createFakeResponse();
    clearSessionCookie(res);
    expect(calls[0].name).toBe(SESSION_COOKIE);
    expect(calls[0].options.maxAge).toBeUndefined();
    expect(calls[0].options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });
});
