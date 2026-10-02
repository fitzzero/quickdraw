// Server exports for @fitzzero/quickdraw-core/server
//
// For now this entry carries only the 4.1 server modules 5.0 keeps unchanged.
// Auth helpers live in ./server/auth and Express rate limits in
// ./server/express (docs/rfcs/0003-v5.md section 1).

// Redis adapter for horizontal scaling
export {
  setupRedisAdapter,
  isRedisAdapterAvailable,
  type RedisAdapterOptions,
  type RedisAdapterResult,
} from "./redis";

// Rate limiting
export {
  createRateLimiter,
  applyRateLimitMiddleware,
  createTieredRateLimiter,
  type RateLimitOptions,
  type RateLimiter,
} from "./rateLimit";

// Environment validation utilities
export {
  validateEnv,
  checkEnv,
  requireEnv,
  type ValidateEnvOptions,
  type EnvValidationResult,
} from "./utils/env";

// Encryption utilities (AES-256-GCM, requires ENCRYPTION_KEY)
export { encrypt, decrypt, isEncrypted, decryptIfEncrypted, tryDecrypt } from "./utils/encryption";
