import * as jose from "jose";
import { describe, expect, it } from "vitest";
import { createJWT, verifyJWT } from "./jwt";

// Pins createJWT/verifyJWT to their 4.1 behavior on jose 6.
const SECRET = "test-secret";

describe("createJWT / verifyJWT", () => {
  it("signs HS256 tokens that verify back to the payload and expire in 7 days by default", async () => {
    const token = await createJWT({ userId: "user-1", email: "user@example.com" }, SECRET);
    expect(jose.decodeProtectedHeader(token).alg).toBe("HS256");

    const payload = await verifyJWT(token, SECRET);
    expect(payload).toMatchObject({ userId: "user-1", email: "user@example.com" });
    expect(typeof payload?.iat).toBe("number");
    expect((payload?.exp ?? 0) - (payload?.iat ?? 0)).toBe(7 * 24 * 60 * 60);
  });

  it("carries the session id as sid, and leaves it out when the token has none", async () => {
    const withSid = await verifyJWT(
      await createJWT({ userId: "user-1", sid: "s-1" }, SECRET),
      SECRET,
    );
    expect(withSid).toMatchObject({ userId: "user-1", sid: "s-1" });
    const without = await verifyJWT(await createJWT({ userId: "user-1" }, SECRET), SECRET);
    expect(without).not.toHaveProperty("sid");
  });

  it("honours a custom expiry", async () => {
    const payload = await verifyJWT(await createJWT({ userId: "user-1" }, SECRET, "1h"), SECRET);
    expect((payload?.exp ?? 0) - (payload?.iat ?? 0)).toBe(60 * 60);
  });

  it("returns null for a wrong secret, an expired token and a malformed token", async () => {
    const token = await createJWT({ userId: "user-1" }, SECRET);
    expect(await verifyJWT(token, "another-secret")).toBeNull();

    const now = Math.floor(Date.now() / 1000);
    const expired = await new jose.SignJWT({ userId: "user-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(now - 120)
      .setExpirationTime(now - 60)
      .sign(new TextEncoder().encode(SECRET));
    expect(await verifyJWT(expired, SECRET)).toBeNull();

    expect(await verifyJWT("not-a-jwt", SECRET)).toBeNull();
  });
});
