// @vitest-environment node
import { afterEach, describe, expect, it } from "vitest";
import { validateRedirectOrigin } from "./validateOrigin";

describe("validateRedirectOrigin", () => {
  const originalEnv = {
    CLIENT_URL: process.env.CLIENT_URL,
    EXTRA_ALLOWED_ORIGINS: process.env.EXTRA_ALLOWED_ORIGINS,
    NODE_ENV: process.env.NODE_ENV,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it("allows the configured client URL", () => {
    expect(
      validateRedirectOrigin("https://app.example.com", { clientUrl: "https://app.example.com" }),
    ).toBe("https://app.example.com");
  });

  it("falls back to CLIENT_URL env", () => {
    process.env.CLIENT_URL = "https://env.example.com";
    expect(validateRedirectOrigin("https://env.example.com")).toBe("https://env.example.com");
  });

  it("strips paths to prevent path injection", () => {
    expect(
      validateRedirectOrigin("https://app.example.com/evil/path", {
        clientUrl: "https://app.example.com",
      }),
    ).toBe("https://app.example.com");
  });

  it("rejects unknown origins", () => {
    expect(
      validateRedirectOrigin("https://evil.example.com", { clientUrl: "https://app.example.com" }),
    ).toBeNull();
  });

  it("rejects unparseable origins and empty strings", () => {
    expect(validateRedirectOrigin("not a url")).toBeNull();
    expect(validateRedirectOrigin("")).toBeNull();
  });

  it("allows extraAllowedOrigins option and env", () => {
    expect(
      validateRedirectOrigin("https://staging.example.com", {
        extraAllowedOrigins: ["https://staging.example.com"],
      }),
    ).toBe("https://staging.example.com");

    process.env.EXTRA_ALLOWED_ORIGINS = "https://a.example.com, https://b.example.com";
    expect(validateRedirectOrigin("https://b.example.com")).toBe("https://b.example.com");
  });

  it("allows app-specific patterns", () => {
    const allowedPatterns = [/^https:\/\/[^.]+\.preview\.example\.com$/];
    expect(validateRedirectOrigin("https://pr-42.preview.example.com", { allowedPatterns })).toBe(
      "https://pr-42.preview.example.com",
    );
    expect(validateRedirectOrigin("https://evil.com", { allowedPatterns })).toBeNull();
  });

  it("allows GitHub Codespace origins unless disabled", () => {
    const origin = "https://my-workspace-octocat-3000.app.github.dev";
    expect(validateRedirectOrigin(origin)).toBe(origin);
    expect(validateRedirectOrigin(origin, { allowCodespaces: false })).toBeNull();
  });

  it("allows localhost in dev but not production", () => {
    process.env.NODE_ENV = "development";
    expect(validateRedirectOrigin("http://localhost:3000")).toBe("http://localhost:3000");
    expect(
      validateRedirectOrigin("http://localhost:3000", { allowLocalhostInDev: false }),
    ).toBeNull();

    process.env.NODE_ENV = "production";
    expect(validateRedirectOrigin("http://localhost:3000")).toBeNull();
  });
});
