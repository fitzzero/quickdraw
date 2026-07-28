// Server exports for @quickdraw/core/server

// Types
export type {
  QuickdrawSocket,
  QuickdrawIdentity,
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
export { BaseRpcService } from "./BaseRpcService";
export { ServiceRegistry, type ServiceRegistryOptions } from "./ServiceRegistry";
export { createQuickdrawServer } from "./createServer";

// Collections (scope-keyed list subscriptions)
export {
  CollectionManager,
  type CollectionDefinition,
  type CollectionWriteEvent,
} from "./collections";

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

// Encryption utilities (AES-256-GCM, requires ENCRYPTION_KEY)
export { encrypt, decrypt, isEncrypted, decryptIfEncrypted, tryDecrypt } from "./utils/encryption";

// Admin utilities
export {
  zodToAdminFields,
  getDefaultEntityFields,
  mergeWithDefaultFields,
  type ZodToAdminFieldsOptions,
} from "./utils/zodToAdminFields";

// MCP (Model Context Protocol) bridge
export {
  McpRegistry,
  createMcpStdioServer,
  bootstrapMcpServer,
  createMcpRoutes,
  generateToolMetadata,
  type McpRegistryOptions,
  type McpStdioServerOptions,
  type McpHttpRoutesOptions,
  type McpRegistryInstance,
  type McpServiceInstance,
  type McpMethodDefinition,
  type McpMethodContext,
  type McpToolDefinition,
  type ServiceToolSpec,
  type MethodSpec,
  type GenerateToolMetadataOptions,
  type ServiceInfo,
  type ServiceMethodInfo,
} from "./mcp";
