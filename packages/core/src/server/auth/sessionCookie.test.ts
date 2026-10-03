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

// The first recorded call. Throws when nothing was recorded, so an assertion
// on it can never pass against a missing call.
function firstCall(calls: RecordedCall[]): RecordedCall {
  const call = calls[0];
  if (!call) throw new Error("No cookie call was recorded");
  return call;
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
    expect(firstCall(calls).name).toBe(SESSION_COOKIE);
    expect(firstCall(calls).value).toBe("jwt-value");
    expect(firstCall(calls).options).toMatchObject({
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      path: "/",
    });
    // Default lifetime matches the default JWT expiry (7 days)
    expect(firstCall(calls).options.maxAge).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it("sets a none+secure cookie in production with COOKIE_DOMAIN", () => {
    process.env.NODE_ENV = "production";
    process.env.COOKIE_DOMAIN = ".example.com";
    const { res, calls } = createFakeResponse();
    setSessionCookie(res, "jwt-value");

    expect(firstCall(calls).options).toMatchObject({
      secure: true,
      sameSite: "none",
      domain: ".example.com",
    });
  });

  it("supports custom cookie name and max age", () => {
    const { res, calls } = createFakeResponse();
    setSessionCookie(res, "jwt-value", { cookieName: "auth", maxAgeMs: 1000 });
    expect(firstCall(calls).name).toBe("auth");
    expect(firstCall(calls).options.maxAge).toBe(1000);
  });

  it("takes SameSite and Secure from the options, and keeps a SameSite=None cookie Secure", () => {
    process.env.NODE_ENV = "production";
    const lax = createFakeResponse();
    setSessionCookie(lax.res, "jwt-value", { sameSite: "lax" });
    expect(firstCall(lax.calls).options).toMatchObject({ sameSite: "lax", secure: true });

    process.env.NODE_ENV = "development";
    const secureDev = createFakeResponse();
    setSessionCookie(secureDev.res, "jwt-value", { secure: true });
    expect(firstCall(secureDev.calls).options).toMatchObject({ sameSite: "lax", secure: true });
    const none = createFakeResponse();
    clearSessionCookie(none.res, { sameSite: "none", secure: false });
    expect(firstCall(none.calls).options).toMatchObject({ sameSite: "none", secure: true });
  });

  it("clears with matching options (no maxAge)", () => {
    process.env.NODE_ENV = "development";
    const { res, calls } = createFakeResponse();
    clearSessionCookie(res);
    expect(firstCall(calls).name).toBe(SESSION_COOKIE);
    expect(firstCall(calls).options.maxAge).toBeUndefined();
    expect(firstCall(calls).options).toMatchObject({ httpOnly: true, sameSite: "lax", path: "/" });
  });
});
