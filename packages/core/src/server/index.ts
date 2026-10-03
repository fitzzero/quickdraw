// Server exports for @fitzzero/quickdraw-core/server
//
// The 5.0 method runtime (docs/rfcs/0003-v5.md sections 3, 4.1 and 9), then
// the 4.1 server modules 5.0 keeps unchanged. Auth helpers live in
// ./server/auth and Express rate limits in ./server/express (section 1).

// initQuickdraw, defineService and the in-process caller
export {
  initQuickdraw,
  type ContextFactory,
  type InitArgs,
  type InitOptions,
  type Quickdraw,
} from "./init";
export type {
  AccessMap,
  DefineService,
  MethodAccess,
  MethodImplementation,
  PrincipalFor,
  ServiceDefinition,
} from "./defineService";
export type { AnyService, Service, ServiceMethod, ShareMode } from "./service";
export type {
  ContextExtensionOf,
  DbOf,
  MaybePromise,
  McpContext,
  McpContextOf,
  Principal,
  PrincipalOf,
  QuickdrawTypes,
  Transport,
} from "./types";
export type {
  AnyContext,
  BaseContext,
  ContextRooms,
  ContextServices,
  HandlerArgs,
  HandlerContext,
  TouchOptions,
} from "./context";
export type { CallOptions, Caller, CallerFor, MethodCaller, ServiceCaller } from "./caller";

// The dispatcher and its pipeline
export {
  createDispatcher,
  type ContractOfServices,
  type DbOfServices,
  type Dispatcher,
  type DispatcherOptions,
  type PrincipalOfServices,
} from "./dispatcher";
export type { RegisteredMethod, Registry } from "./registry";
export { toCallReply, type DispatchRequest, type DispatchResult } from "./pipeline/request";
export { DEFAULT_LIMITS, type DispatcherLimits, type PipelineOptions } from "./pipeline/settings";

// Access forms, and the seams later cards implement: access policies,
// tracked writes, "not modified" versions and the completion record
export { custom } from "./access/forms";
export { createBasicAccessEngine, type BasicAccessEngineOptions } from "./access/basicEngine";
export { meetsLevel, serviceGrant } from "./access/levels";
export type {
  AccessEngine,
  AccessFor,
  AccessForm,
  AccessRequest,
  AuthenticatedAccess,
  CustomAccess,
  EntryAccess,
  IdKeyOf,
  IdSelector,
  PublicAccess,
  RowAccess,
  ScopeAccess,
  ServiceAccess,
} from "./access/types";
export {
  ANY_FIELD,
  type UnitOfWork,
  type UnitOfWorkFactory,
  type UnitOfWorkScope,
  type WriteRecord,
} from "./uow/types";
export type { FlushInfo, FlushSink } from "./uow/flushSink";
export type { StatementCount } from "./uow/unitOfWork";
export type { TrackingOptions } from "./pipeline/tracking";

// The storage adapter tracked database clients carry (RFC 0003 section 5.4);
// `trackPrisma` is on ./prisma
export {
  storageOf,
  type CountArgs,
  type FindManyArgs,
  type StorageAdapter,
  type StorageRow,
  type StorageWhere,
} from "./storage";
export type { VersionRequest, VersionSource } from "./pipeline/notModified";
export type { CallOutcome, CallRecord } from "./pipeline/metrics";

// The server factory and its transports (RFC 0003 sections 3, 8 and 10):
// Socket.IO, HTTP and the 4.x legacy shim. The in-process transport is the
// dispatcher's caller.
export {
  createServer,
  type HttpApp,
  type QuickdrawServer,
  type RotateOptions,
  type ServerOnlyOptions,
  type ServerOptions,
} from "./createServer";
export {
  createHttpRouter,
  type HttpRouter,
  type HttpRouterOptions,
  type HttpTransportOptions,
} from "./transports/http";
export type {
  AuthenticateRequest,
  AuthenticateResult,
  HttpAuthenticateRequest,
  ServerAuth,
  ServiceGrants,
  SocketAuthenticateRequest,
} from "./transports/auth";
export type { QuickdrawIo, QuickdrawServerSocket, QuickdrawSocketData } from "./transports/types";
export type { SocketCors, SocketOptions, SocketRateLimitOptions } from "./transports/socketServer";
export type { LegacyReply } from "./transports/legacy";

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
