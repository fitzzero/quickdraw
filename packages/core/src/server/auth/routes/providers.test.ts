// The hosted providers' halves the routes drive (the mock provider runs end to
// end in createAuthRoutes.test.ts): the authorization URL each sends the
// browser to, and the profile each reads after the code exchange, with the
// provider's endpoints answered by a stubbed `fetch`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { guest } from "./guest";
import { discord, google, mock } from "./providers";

const REDIRECT = "https://api.test/auth/google/callback";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Answers the token request, then the userinfo request; records both. */
function stubProvider(userInfo: unknown): { readonly requests: [string, RequestInit][] } {
  const requests: [string, RequestInit][] = [];
  const answers = [
    { access_token: "at", token_type: "Bearer", expires_in: 3600, refresh_token: "rt" },
    userInfo,
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      requests.push([url, init]);
      return Promise.resolve(new Response(JSON.stringify(answers.shift()), { status: 200 }));
    }),
  );
  return { requests };
}

describe("google()", () => {
  it("sends the browser to Google with the state, the redirect URI and the app's parameters", () => {
    const provider = google({
      clientId: "cid",
      clientSecret: "secret",
      params: { access_type: "offline", prompt: "consent" },
    });
    expect(provider).toMatchObject({ kind: "oauth", id: "google" });
    const url = new URL(provider.authorizeUrl("st", REDIRECT));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: "cid",
      redirect_uri: REDIRECT,
      response_type: "code",
      scope: "openid email profile",
      state: "st",
      access_type: "offline",
      prompt: "consent",
    });
    expect(JSON.stringify(Object.fromEntries(url.searchParams))).not.toContain("secret");
  });

  it("exchanges the code and reads the profile", async () => {
    const { requests } = stubProvider({
      id: "g-1",
      email: "ada@gmail.test",
      name: "Ada",
      picture: "https://img.test/a.png",
      verified_email: true,
    });
    const profile = await google({ clientId: "cid", clientSecret: "secret" }).profile(
      "the-code",
      REDIRECT,
    );
    expect(profile).toEqual({
      providerAccountId: "g-1",
      email: "ada@gmail.test",
      emailVerified: true,
      name: "Ada",
      image: "https://img.test/a.png",
      tokens: expect.objectContaining({ access_token: "at", refresh_token: "rt" }),
      raw: expect.objectContaining({ id: "g-1" }),
    });
    const [token, userInfo] = requests;
    expect(token?.[0]).toBe("https://oauth2.googleapis.com/token");
    expect(Object.fromEntries(token?.[1].body as URLSearchParams)).toEqual({
      client_id: "cid",
      client_secret: "secret",
      code: "the-code",
      grant_type: "authorization_code",
      redirect_uri: REDIRECT,
    });
    expect(userInfo?.[0]).toBe("https://www.googleapis.com/oauth2/v2/userinfo");
  });
});

describe("discord()", () => {
  it("asks for the app's scopes, and maps the profile with its avatar URL", async () => {
    const provider = discord({ clientId: "cid", clientSecret: "secret", scopes: ["identify"] });
    const url = new URL(provider.authorizeUrl("st", "https://api.test/auth/discord/callback"));
    expect(url.origin + url.pathname).toBe("https://discord.com/api/oauth2/authorize");
    expect(url.searchParams.get("scope")).toBe("identify");
    stubProvider({
      id: "80351110224678912",
      username: "nelly",
      discriminator: "0",
      email: null,
      avatar: null,
      verified: false,
    });
    expect(await provider.profile("c", "https://api.test/auth/discord/callback")).toEqual({
      providerAccountId: "80351110224678912",
      email: null,
      emailVerified: false,
      name: "nelly",
      image: "https://cdn.discordapp.com/embed/avatars/5.png",
      tokens: expect.objectContaining({ access_token: "at" }),
      raw: expect.objectContaining({ username: "nelly" }),
    });
  });

  it("rejects when the code exchange fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("invalid_grant", { status: 400 }))),
    );
    await expect(
      discord({ clientId: "c", clientSecret: "s" }).profile("bad", REDIRECT),
    ).rejects.toThrow("Token exchange failed: invalid_grant");
  });
});

describe("the provider builders", () => {
  it("check what they are given", () => {
    expect(() => google({ clientId: "", clientSecret: "s" })).toThrow(
      "google(): clientId is required",
    );
    expect(() => discord({ clientId: "c", clientSecret: "" })).toThrow(
      "discord(): clientSecret is required",
    );
    expect(() => mock({} as never)).toThrow("mock(): listUsers is required");
    expect(() => guest({} as never)).toThrow("guest(): createUser is required");
  });
});
