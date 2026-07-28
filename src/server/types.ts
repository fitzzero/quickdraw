import type { Socket, Server as SocketIOServer } from "socket.io";
import type { Server as HTTPServer } from "http";
import type { z } from "zod";
import type {
  AccessLevel,
  ServiceMethodDefinition,
  ServiceChannelDefinition,
  Logger,
  AdminFieldConfig,
  CollectionSubscribePayload,
  CollectionSnapshotResponse,
  CollectionUnsubscribePayload,
} from "../shared/types";

// ============================================================================
// Socket Types
// ============================================================================

/**
 * Extended Socket type with authentication properties
 */
export interface QuickdrawSocket extends Socket {
  userId?: string;
  serviceAccess?: Record<string, AccessLevel>;
  /** Principal type from the structured identity (e.g. "user", "taskToken"). */
  principalType?: string;
  /** Arbitrary verified claims stamped by `authenticate`. */
  claims?: Record<string, unknown>;
}

// ============================================================================
// Server Configuration Types
// ============================================================================

/**
 * Structured result of socket authentication. Lets `authenticate` express
 * multiple principal types (user JWT, task token, deployment-runner token…)
 * instead of only a userId.
 *
 * Everything is stamped onto the socket: `userId`, `principalType`, `claims`,
 * and `serviceAccess` (when omitted, `loadServiceAccess(userId)` is consulted).
 */
export interface QuickdrawIdentity {
  userId?: string;
  principalType?: string;
  claims?: Record<string, unknown>;
  serviceAccess?: Record<string, AccessLevel>;
}

export interface QuickdrawServerOptions {
  port: number;
  cors?: {
    origin: string | string[];
    methods?: string[];
    credentials?: boolean;
  };
  services: Record<string, BaseServiceInstance>;
  auth?: {
    /**
     * Custom authentication function.
     * Return a userId string or a structured {@link QuickdrawIdentity} if
     * authenticated; throw or return undefined to reject.
     */
    authenticate?: (
      socket: QuickdrawSocket,
      auth: Record<string, unknown>,
    ) => Promise<string | QuickdrawIdentity | undefined>;
    /**
     * Load service-level access for an authenticated user (e.g. from the
     * user record). Used when the identity result does not carry
     * `serviceAccess` itself. Defaults to empty access.
     */
    loadServiceAccess?: (
      userId: string,
    ) => Promise<Record<string, AccessLevel> | null | undefined>;
  };
  logger?: Logger;
  /**
   * Automatic method logging configuration.
   * Logs all service method calls, success/failure, timing, and errors.
   * @default { enabled: true, logPayloads: false }
   */
  methodLogging?: {
    /** Enable automatic method logging. Default: true */
    enabled?: boolean;
    /** Log request payloads (may contain sensitive data). Default: false */
    logPayloads?: boolean;
    /** Log response data (may contain sensitive data). Default: false */
    logResponses?: boolean;
  };
}

export interface QuickdrawServerResult {
  io: SocketIOServer;
  httpServer: HTTPServer;
  registry: ServiceRegistryInstance;
}

// ============================================================================
// Service Types
// ============================================================================

/**
 * Interface for BaseService instances (used for type-safe registration)
 */
export interface BaseServiceInstance {
  serviceName: string;
  subscribe: (
    entryId: string,
    socket: QuickdrawSocket,
    requiredLevel?: AccessLevel,
  ) => Promise<Record<string, unknown> | null>;
  batchSubscribe: (
    entryIds: string[],
    socket: QuickdrawSocket,
    requiredLevel?: AccessLevel,
  ) => Promise<Record<string, Record<string, unknown> | null>>;
  unsubscribe: (entryId: string, socket: QuickdrawSocket) => void;
  unsubscribeSocket: (socket: QuickdrawSocket) => void;
  ensureAccessForMethod: (
    requiredLevel: AccessLevel,
    socket: QuickdrawSocket,
    entryId?: string,
  ) => Promise<void>;
  getPublicMethods: () => ServiceMethodDefinition<unknown, unknown>[];
  /** Get channels for registry discovery (services without channels may omit) */
  getPublicChannels?: () => ServiceChannelDefinition<unknown>[];
  /** Synchronous in-memory access check for channel messages */
  checkChannelAccess?: (
    channel: ServiceChannelDefinition<unknown>,
    socket: QuickdrawSocket,
    payload: unknown,
  ) => boolean;
  /** Handle a collection subscribe (services without collections may omit) */
  subscribeCollection?: (
    payload: CollectionSubscribePayload,
    socket: QuickdrawSocket,
  ) => Promise<CollectionSnapshotResponse<{ id: string }> | null>;
  /** Handle a collection unsubscribe (services without collections may omit) */
  unsubscribeCollection?: (payload: CollectionUnsubscribePayload, socket: QuickdrawSocket) => void;
  /** Set Socket.io server instance for room-based broadcasts */
  setIo?: (io: SocketIOServer) => void;
}

/**
 * Interface for ServiceRegistry instances
 */
export interface ServiceRegistryInstance {
  registerService: (serviceName: string, service: BaseServiceInstance) => void;
  getServices: () => string[];
  getServiceInstances: () => BaseServiceInstance[];
}

// ============================================================================
// BaseService Configuration Types
// ============================================================================

export interface BaseServiceOptions {
  serviceName: string;
  hasEntryACL?: boolean;
  defaultACL?: Array<{ userId: string; level: AccessLevel }>;
  logger?: Logger;
}

export interface InstallAdminMethodsOptions {
  expose: {
    list?: boolean;
    get?: boolean;
    create?: boolean;
    update?: boolean;
    delete?: boolean;
    setEntryACL?: boolean;
    getSubscribers?: boolean;
    reemit?: boolean;
    unsubscribeAll?: boolean;
    /** Enable adminMeta method for UI generation. Default: true if any other admin method is exposed */
    meta?: boolean;
  };
  access: {
    list: AccessLevel;
    get: AccessLevel;
    create: AccessLevel;
    update: AccessLevel;
    delete: AccessLevel;
    setEntryACL: AccessLevel;
    getSubscribers: AccessLevel;
    reemit: AccessLevel;
    unsubscribeAll: AccessLevel;
    /** Access level for adminMeta. Default: same as list */
    meta?: AccessLevel;
  };
  /** Zod schema for deriving field metadata (typically the create schema) */
  schema?: z.ZodTypeAny;
  /** Human-readable display name for the service (e.g., "Chats") */
  displayName?: string;
  /** Override which fields appear in table (by default all non-json fields) */
  tableColumns?: string[];
  /** Fields to hide from admin UI entirely */
  hiddenFields?: string[];
  /** Override specific field configurations */
  fieldOverrides?: Partial<Record<string, Partial<AdminFieldConfig>>>;
}

// ============================================================================
// Admin Method Payload/Response Types
// ============================================================================
// Canonical shapes live in shared/types.ts (used by both client and server);
// re-exported here so `.../server` import sites keep working.

export type {
  AdminListPayload,
  AdminListResponse,
  AdminSetACLPayload,
  AdminSubscribersResponse,
} from "../shared/types";

// ============================================================================
// Prisma Integration Types
// ============================================================================

/**
 * Generic Prisma delegate type for CRUD operations.
 * This allows BaseService to work with any Prisma model without tight coupling.
 */
export interface PrismaDelegate<
  TEntity,
  TCreateInput,
  TUpdateInput,
  TWhereUniqueInput = { id: string },
> {
  findUnique: (args: {
    where: TWhereUniqueInput;
    select?: Record<string, boolean>;
  }) => Promise<TEntity | null>;
  findMany: (args?: {
    where?: Record<string, unknown>;
    orderBy?: Record<string, "asc" | "desc">;
    skip?: number;
    take?: number;
  }) => Promise<TEntity[]>;
  create: (args: { data: TCreateInput }) => Promise<TEntity>;
  update: (args: { where: TWhereUniqueInput; data: TUpdateInput }) => Promise<TEntity>;
  delete: (args: { where: TWhereUniqueInput }) => Promise<TEntity>;
  count: (args?: { where?: Record<string, unknown> }) => Promise<number>;
}
