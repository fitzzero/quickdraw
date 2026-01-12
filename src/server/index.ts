// Server exports for @quickdraw/core/server

// Types
export type {
  QuickdrawSocket,
  QuickdrawServerOptions,
  QuickdrawServerResult,
  BaseServiceInstance,
  ServiceRegistryInstance,
  BaseServiceOptions,
  InstallAdminMethodsOptions,
  PrismaDelegate,
  AdminListPayload,
  AdminListResponse,
  AdminSetACLPayload,
  AdminSubscribersResponse,
} from "./types";

// Core classes
export { BaseService } from "./BaseService";
export { ServiceRegistry, type ServiceRegistryOptions } from "./ServiceRegistry";
export { createQuickdrawServer } from "./createServer";

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

// Auth utilities
export * from "./auth";

// Environment validation utilities
export {
  validateEnv,
  checkEnv,
  requireEnv,
  type ValidateEnvOptions,
  type EnvValidationResult,
} from "./utils/env";

// Admin utilities
export {
  zodToAdminFields,
  getDefaultEntityFields,
  mergeWithDefaultFields,
  type ZodToAdminFieldsOptions,
} from "./utils/zodToAdminFields";
