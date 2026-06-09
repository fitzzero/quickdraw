// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decrypt, decryptIfEncrypted, encrypt, isEncrypted, tryDecrypt } from "./encryption";

const TEST_KEY = "0123456789abcdef".repeat(4);

describe("encryption", () => {
  const originalKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = TEST_KEY;
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = originalKey;
  });

  it("round-trips plaintext", () => {
    const ciphertext = encrypt("hello secret");
    expect(ciphertext).not.toContain("hello secret");
    expect(decrypt(ciphertext)).toBe("hello secret");
  });

  it("produces unique ciphertexts per call (random IV)", () => {
    expect(encrypt("same")).not.toBe(encrypt("same"));
  });

  it("detects encrypted format", () => {
    expect(isEncrypted(encrypt("value"))).toBe(true);
    expect(isEncrypted("gho_plaintexttoken")).toBe(false);
    expect(isEncrypted("not:hex:zz")).toBe(false);
  });

  it("decryptIfEncrypted passes plaintext through", () => {
    expect(decryptIfEncrypted("gho_plaintexttoken")).toBe("gho_plaintexttoken");
    expect(decryptIfEncrypted(encrypt("wrapped"))).toBe("wrapped");
  });

  it("tryDecrypt returns null on stale/re-keyed ciphertext", () => {
    const ciphertext = encrypt("value");
    process.env.ENCRYPTION_KEY = "fedcba9876543210".repeat(4);
    expect(tryDecrypt(ciphertext)).toBeNull();
  });

  it("throws without a valid ENCRYPTION_KEY", () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encrypt("value")).toThrow(/ENCRYPTION_KEY/);
    process.env.ENCRYPTION_KEY = "tooshort";
    expect(() => encrypt("value")).toThrow(/ENCRYPTION_KEY/);
  });

  it("rejects malformed ciphertext", () => {
    expect(() => decrypt("not-valid")).toThrow(/Invalid ciphertext format/);
  });
});
