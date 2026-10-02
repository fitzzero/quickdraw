// @vitest-environment node
import express from "express";
import type { Server } from "http";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  createMockOAuthProvider,
  isMockOAuthEnabled,
  registerMockOAuthProvider,
  type MockOAuthUser,
} from "./mock";
import { createOAuthURL, exchangeOAuthCode, type OAuthConfig } from "./oauth";

const USERS: MockOAuthUser[] = [
  { id: "u1", email: "admin@demo.local", name: "Demo Admin", picture: null },
  { id: "u2", email: "user@demo.local", name: "Demo User" },
];

describe("mock OAuth provider", () => {
  let server: Server;
  let baseUrl: string;
  let config: OAuthConfig;
  const originalNodeEnv = process.env.NODE_ENV;
  const originalFlag = process.env.ENABLE_MOCK_OAUTH;

  beforeAll(async () => {
    process.env.ENABLE_MOCK_OAUTH = "true";
    process.env.NODE_ENV = "test";

    const app = express();
    // Intentionally no urlencoded body parser: the /token handler must parse
    // the raw stream the way a json-only app would expose it.
    const mounted = registerMockOAuthProvider(app, { listUsers: async () => USERS });
    expect(mounted).toBe(true);

    await new Promise<void>((resolveListen) => {
      server = app.listen(0, "127.0.0.1", () => resolveListen());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No server address");
    baseUrl = `http://127.0.0.1:${address.port}`;
    config = {
      clientId: "mock",
      clientSecret: "mock",
      redirectUri: `${baseUrl}/auth/mock/callback`,
    };
  });

  afterAll(async () => {
    await new Promise<void>((resolveClose) => {
      server.close(() => resolveClose());
    });
  });

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv ?? "test";
    process.env.ENABLE_MOCK_OAUTH = originalFlag ?? "true";
    if (originalFlag === undefined) process.env.ENABLE_MOCK_OAUTH = "true";
  });

  function provider() {
    return createMockOAuthProvider(baseUrl);
  }

  async function getAuthCode(email: string): Promise<{ code: string; state: string | null }> {
    const url = new URL(provider().authorizationUrl);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("state", "state-123");
    url.searchParams.set("email", email);

    const response = await fetch(url, { redirect: "manual" });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    return {
      code: location.searchParams.get("code") ?? "",
      state: location.searchParams.get("state"),
    };
  }

  it("reports enablement from env flags", () => {
    expect(isMockOAuthEnabled()).toBe(true);
    process.env.NODE_ENV = "production";
    expect(isMockOAuthEnabled()).toBe(false);
  });

  it("builds standard OAuth URLs createOAuthURL understands", () => {
    const url = createOAuthURL(provider(), config, "abc");
    expect(url).toContain("/auth/mock/provider/authorize?");
    expect(url).toContain("state=abc");
    expect(url).toContain(encodeURIComponent(config.redirectUri));
  });

  it("renders a user picker when no email is given", async () => {
    const url = new URL(provider().authorizationUrl);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("state", "s");

    const response = await fetch(url);
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("admin@demo.local");
    expect(html).toContain("Demo User");
  });

  it("rejects disallowed redirect URIs", async () => {
    const url = new URL(provider().authorizationUrl);
    url.searchParams.set("redirect_uri", "https://evil.example.com/steal");

    const response = await fetch(url);
    expect(response.status).toBe(400);
  });

  it("completes the full code exchange round-trip", async () => {
    const { code, state } = await getAuthCode("admin@demo.local");
    expect(code).not.toBe("");
    expect(state).toBe("state-123");

    const { tokens, user } = await exchangeOAuthCode(provider(), config, code);
    expect(tokens.access_token).toBeTruthy();
    expect(tokens.token_type).toBe("Bearer");
    // providerAccountId stability: id is the email, not the row id.
    expect(user.id).toBe("admin@demo.local");
    expect(user.email).toBe("admin@demo.local");
    expect(user.name).toBe("Demo Admin");
    expect(user.verified_email).toBe(true);
  });

  it("rejects code reuse (single-use grants)", async () => {
    const { code } = await getAuthCode("user@demo.local");
    await exchangeOAuthCode(provider(), config, code);
    await expect(exchangeOAuthCode(provider(), config, code)).rejects.toThrow(
      /Token exchange failed/,
    );
  });

  it("rejects unknown users and bad userinfo tokens", async () => {
    const url = new URL(provider().authorizationUrl);
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("email", "nobody@demo.local");
    const response = await fetch(url, { redirect: "manual" });
    expect(response.status).toBe(400);

    const userinfo = await fetch(provider().userInfoUrl, {
      headers: { Authorization: "Bearer bogus" },
    });
    expect(userinfo.status).toBe(401);
  });

  it("completes the round-trip behind express.json() middleware", async () => {
    // Regression: express.json() sets req.body = {} even when it skips
    // urlencoded content — the token handler must still read the raw stream.
    const app = express();
    app.use(express.json());
    registerMockOAuthProvider(app, { listUsers: async () => USERS });

    const jsonServer: Server = await new Promise((resolveListen) => {
      const s = app.listen(0, "127.0.0.1", () => resolveListen(s));
    });
    try {
      const address = jsonServer.address();
      if (!address || typeof address === "string") throw new Error("No server address");
      const jsonBase = `http://127.0.0.1:${address.port}`;
      const jsonProvider = createMockOAuthProvider(jsonBase);
      const jsonConfig = { clientId: "mock", clientSecret: "mock", redirectUri: `${jsonBase}/cb` };

      const url = new URL(jsonProvider.authorizationUrl);
      url.searchParams.set("redirect_uri", jsonConfig.redirectUri);
      url.searchParams.set("email", "admin@demo.local");
      const response = await fetch(url, { redirect: "manual" });
      expect(response.status).toBe(302);
      const code = new URL(response.headers.get("location") ?? "").searchParams.get("code") ?? "";

      const { user } = await exchangeOAuthCode(jsonProvider, jsonConfig, code);
      expect(user.email).toBe("admin@demo.local");
    } finally {
      await new Promise<void>((resolveClose) => {
        jsonServer.close(() => resolveClose());
      });
    }
  });

  it("refuses to mount in production", () => {
    process.env.NODE_ENV = "production";
    const app = express();
    const mounted = registerMockOAuthProvider(app, { listUsers: async () => USERS });
    expect(mounted).toBe(false);
  });

  it("404s at request time if NODE_ENV flips to production after mount", async () => {
    process.env.NODE_ENV = "production";
    try {
      const url = new URL(provider().authorizationUrl);
      url.searchParams.set("redirect_uri", config.redirectUri);
      const response = await fetch(url);
      expect(response.status).toBe(404);
    } finally {
      process.env.NODE_ENV = "test";
    }
  });
});
