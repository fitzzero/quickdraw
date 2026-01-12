import type { Socket, Server as SocketIOServer } from "socket.io";
import type { Server as HTTPServer } from "http";
import type {
  AccessLevel,
  ServiceMethodDefinition,
  Logger,
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
}

// ============================================================================
// Server Configuration Types
// ============================================================================

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
     * Return the userId if authenticated, or throw/return undefined to reject.
     */
    authenticate?: (
      socket: QuickdrawSocket,
      auth: Record<string, unknown>
    ) => Promise<string | undefined>;
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
    requiredLevel?: AccessLevel
  ) => Promise<Record<string, unknown> | null>;
  unsubscribe: (entryId: string, socket: QuickdrawSocket) => void;
  unsubscribeSocket: (socket: QuickdrawSocket) => void;
  ensureAccessForMethod: (
    requiredLevel: AccessLevel,
    socket: QuickdrawSocket,
    entryId?: string
  ) => Promise<void>;
  getPublicMethods: () => ServiceMethodDefinition<unknown, unknown>[];
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
  };
}

// ============================================================================
// Admin Method Payload/Response Types
// ============================================================================

export interface AdminListPayload {
  page?: number;
  pageSize?: number;
  where?: Record<string, unknown>;
  orderBy?: Record<string, "asc" | "desc">;
}

export interface AdminListResponse<TEntity> {
  items: TEntity[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

export interface AdminSetACLPayload {
  entryId: string;
  acl: Array<{ userId: string; level: AccessLevel }>;
}

export interface AdminSubscribersResponse {
  entryId: string;
  subscribers: Array<{
    socketId: string;
    userId: string | null;
  }>;
  count: number;
}

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
  TWhereUniqueInput = { id: string }
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
  update: (args: {
    where: TWhereUniqueInput;
    data: TUpdateInput;
  }) => Promise<TEntity>;
  delete: (args: { where: TWhereUniqueInput }) => Promise<TEntity>;
  count: (args?: { where?: Record<string, unknown> }) => Promise<number>;
}
