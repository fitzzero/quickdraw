/**
 * AES-256-GCM encryption helpers for at-rest secrets (e.g. stored OAuth tokens).
 *
 * Requires ENCRYPTION_KEY: a 64-character hex string (32 bytes).
 * Ciphertext format: "iv:authTag:ciphertext" (all hex).
 */

import { createCipheriv, createDecipheriv, randomBytes } from "crypto";
import { consoleLogger, type Logger } from "../../shared/types";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

function getKey(): Buffer {
  const hex = process.env.ENCRYPTION_KEY;
  if (!hex || hex.length !== 64) {
    throw new Error(
      "ENCRYPTION_KEY must be set as a 64-character hex string (32 bytes). Check your environment configuration.",
    );
  }
  return Buffer.from(hex, "hex");
}

export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${authTag.toString("hex")}:${encrypted.toString("hex")}`;
}

export function decrypt(ciphertext: string): string {
  const key = getKey();
  const [ivHex, authTagHex, encryptedHex] = ciphertext.split(":");
  if (!ivHex || !authTagHex || !encryptedHex) {
    throw new Error("Invalid ciphertext format");
  }
  const iv = Buffer.from(ivHex, "hex");
  const authTag = Buffer.from(authTagHex, "hex");
  const encrypted = Buffer.from(encryptedHex, "hex");
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);
  return decipher.update(encrypted) + decipher.final("utf8");
}

/**
 * Returns true when the value looks like AES-256-GCM ciphertext
 * (iv:authTag:data, all hex). Plaintext OAuth tokens (e.g. gho_xxx) will not match.
 */
export function isEncrypted(value: string): boolean {
  const parts = value.split(":");
  return parts.length === 3 && parts.every((p) => /^[0-9a-f]+$/.test(p));
}

/**
 * Decrypt if the value is in encrypted format, otherwise return as-is.
 * Allows graceful handling of pre-migration plaintext tokens.
 */
export function decryptIfEncrypted(value: string): string {
  return isEncrypted(value) ? decrypt(value) : value;
}

/** Safe wrapper that returns `null` instead of throwing on invalid/stale ciphertext. */
export function tryDecrypt(ciphertext: string, logger: Logger = consoleLogger): string | null {
  try {
    return decryptIfEncrypted(ciphertext);
  } catch {
    logger.warn("Failed to decrypt stored token — likely stale or re-keyed");
    return null;
  }
}
