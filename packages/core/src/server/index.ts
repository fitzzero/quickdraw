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
  RowFormsOf,
  ServiceDefinition,
} from "./defineService";
export type {
  AffectsOption,
  CollectionOption,
  CollectionOptions,
  CollectionsRequired,
  HandlerOutputOf,
  HandlerRow,
  ProjectCheck,
  ProjectionOption,
  RowFor,
} from "./serviceTypes";
export type { AffectsLink, AnyService, Service, ServiceMethod, ShareMode } from "./service";

// Projections, field tiers and entity subscriptions (RFC 0003 section 6)
export type { ProjectedOutput, Projection } from "./emit/projection";
export type { TierGroup, Tiers } from "./emit/tiers";
export type { ChangeLogOptions } from "./emit/changeLog";
export type { EntitySubscription, EntitySubscriptions } from "./emit/subscriptions";

// Collections: scopes, deltas, snapshots and resume, the index and items by
// id (RFC 0003 section 7); change topics (section 11.3)
export {
  DEFAULT_BULK_THRESHOLD,
  type CollectionScope,
  type ServiceCollection,
} from "./collections/define";
export type { ScopeSubscription, ScopeSubscriptions } from "./collections/scopes";
export { RESUME_MAX_AGE_MS, RESUME_MAX_DELTAS } from "./collections/buffer";
export { INDEX_MAX_ROWS } from "./collections/index";
export { MAX_ITEM_IDS } from "./collections/items";
export type { TopicWatch, TopicWatches } from "./topicIndex";
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
  type DispatcherCollections,
  type DispatcherOptions,
  type PrincipalOfServices,
} from "./dispatcher";
export type { RegisteredMethod, Registry } from "./registry";
export { toCallReply, type DispatchRequest, type DispatchResult } from "./pipeline/request";
export { DEFAULT_LIMITS, type DispatcherLimits, type PipelineOptions } from "./pipeline/settings";

// Access control (RFC 0003 section 4): the method access forms, the access
// policies a service declares, and the engine that decides both
export { custom } from "./access/forms";
export { owner } from "./access/policies/owner";
export { jsonAcl, type JsonAclOptions } from "./access/policies/jsonAcl";
export { members, type MembersOptions } from "./access/policies/members";
export { inherit, type InheritOptions } from "./access/policies/inherit";
export { anyOf } from "./access/policies/anyOf";
export { resolver, type ResolverOptions } from "./access/policies/resolver";
export type {
  AccessFilter,
  AccessPolicy,
  AnyAccessPolicy,
  ForeignColumns,
  ForeignColumnsOf,
  MembershipRead,
  ModelColumn,
  ModelName,
  ParentLink,
  PolicyFor,
  PolicyKind,
  PolicyReads,
  PolicyTools,
  RowLevel,
  RowLevels,
} from "./access/policy";
export type { DispatcherAccess } from "./access/api";
export type { AccessOptions } from "./access/engine";
export type { AccessChange, AccessChangeListener } from "./access/changes";
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
  RowForms,
  ScopeAccess,
  ServiceAccess,
  WatchAccess,
} from "./access/types";

// The seams later cards implement: tracked writes, "not modified" versions
// and the completion record
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
  ServiceAccessSource,
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
