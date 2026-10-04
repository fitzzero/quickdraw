// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSessionCookie,
  HOST_SESSION_COOKIE,
  SESSION_COOKIE,
  sessionCookieNameFor,
  sessionCookieNamesFor,
  setSessionCookie,
  type CookieResponse,
  type CookieSettings,
  type SessionCookieNaming,
  type SessionCookieRequest,
} from "./sessionCookie";

interface RecordedCall {
  name: string;
  value?: string;
  options: CookieSettings;
}

function createFakeResponse(req?: SessionCookieRequest): {
  res: CookieResponse;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const res: CookieResponse & { req?: SessionCookieRequest } = {
    ...(req === undefined ? {} : { req }),
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

describe("the session cookie's name", () => {
  const requests: Record<string, SessionCookieRequest> = {
    "plain HTTP": { headers: {} },
    "plain HTTP from an http: page": { headers: { origin: "http://app.test" } },
    "Express's req.secure": { headers: {}, secure: true },
    "a TLS connection": { headers: {}, socket: { encrypted: true } },
    "X-Forwarded-Proto: https": { headers: { "x-forwarded-proto": "https" } },
    "X-Forwarded-Proto: https, http": { headers: { "x-forwarded-proto": "https, http" } },
    "X-Forwarded-Proto: http": { headers: { "x-forwarded-proto": "http" } },
    "an https: page": { headers: { origin: "https://app.test" } },
  };
  const namings: Record<string, SessionCookieNaming> = {
    "no name, no domain": {},
    "an empty domain": { domain: "" },
    "a domain": { domain: ".example.com" },
    "a name": { cookieName: "sid" },
    "a name and a domain": { cookieName: "sid", domain: ".example.com" },
  };

  it("written for a request is the first name read for the same request", () => {
    for (const [requestName, req] of Object.entries(requests)) {
      for (const [namingName, naming] of Object.entries(namings)) {
        const written = sessionCookieNameFor(req, naming);
        const read = sessionCookieNamesFor(req, naming);
        expect(read[0], `${requestName}, ${namingName}`).toBe(written);
        // A configured name wins everywhere; __Host- is never used with a domain.
        if (naming.cookieName !== undefined) {
          expect(read, `${requestName}, ${namingName}`).toEqual([naming.cookieName]);
        } else if (naming.domain !== undefined && naming.domain !== "") {
          expect(written, `${requestName}, ${namingName}`).toBe(SESSION_COOKIE);
        }
      }
    }
  });

  it("is __Host-session on a secure request without a domain, which then never reads the plain name", () => {
    const secure = Object.entries(requests).filter(
      ([name]) => !name.startsWith("plain") && name !== "X-Forwarded-Proto: http",
    );
    for (const [name, req] of secure) {
      expect(sessionCookieNameFor(req), name).toBe(HOST_SESSION_COOKIE);
      expect(sessionCookieNamesFor(req), name).toEqual([HOST_SESSION_COOKIE]);
    }
    for (const name of ["plain HTTP", "plain HTTP from an http: page", "X-Forwarded-Proto: http"]) {
      const req = requests[name] ?? { headers: {} };
      expect(sessionCookieNameFor(req), name).toBe(SESSION_COOKIE);
      expect(sessionCookieNamesFor(req), name).toEqual([SESSION_COOKIE, HOST_SESSION_COOKIE]);
    }
  });

  it("is what setSessionCookie and clearSessionCookie use for the response's request", () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalDomain = process.env.COOKIE_DOMAIN;
    try {
      process.env.NODE_ENV = "production";
      delete process.env.COOKIE_DOMAIN;
      const overHttps = { headers: { "x-forwarded-proto": "https" } };
      const secure = createFakeResponse(overHttps);
      setSessionCookie(secure.res, "jwt-value", { domain: "" });
      clearSessionCookie(secure.res);
      expect(secure.calls.map((call) => call.name)).toEqual([
        HOST_SESSION_COOKIE,
        HOST_SESSION_COOKIE,
      ]);
      expect(firstCall(secure.calls).options).toMatchObject({ secure: true, path: "/" });
      expect(firstCall(secure.calls).options.domain).toBeUndefined();
      // `secure: false` cannot make a __Host- cookie plain: browsers drop it.
      const forced = createFakeResponse(overHttps);
      setSessionCookie(forced.res, "jwt-value", { secure: false, sameSite: "lax" });
      expect(firstCall(forced.calls)).toMatchObject({
        name: HOST_SESSION_COOKIE,
        options: { secure: true },
      });

      process.env.COOKIE_DOMAIN = ".example.com";
      const domain = createFakeResponse(overHttps);
      setSessionCookie(domain.res, "jwt-value");
      expect(firstCall(domain.calls)).toMatchObject({
        name: SESSION_COOKIE,
        options: { domain: ".example.com", secure: true },
      });

      process.env.NODE_ENV = "development";
      delete process.env.COOKIE_DOMAIN;
      const plain = createFakeResponse({ headers: { origin: "http://localhost:3000" } });
      setSessionCookie(plain.res, "jwt-value");
      expect(firstCall(plain.calls)).toMatchObject({
        name: SESSION_COOKIE,
        options: { secure: false },
      });
    } finally {
      process.env.NODE_ENV = originalNodeEnv;
      if (originalDomain === undefined) delete process.env.COOKIE_DOMAIN;
      else process.env.COOKIE_DOMAIN = originalDomain;
    }
  });
});
