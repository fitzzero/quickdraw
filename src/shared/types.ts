import type { z } from "zod";

// ============================================================================
// Access Control Types
// ============================================================================

export type AccessLevel = "Public" | "Read" | "Moderate" | "Admin";

export type ACE = {
  userId: string;
  level: AccessLevel;
};

export type ACL = ACE[];

// ============================================================================
// Service Response Types
// ============================================================================

export type ServiceResponse<T = unknown> =
  | { success: true; data: T }
  | { success: false; error: string; code?: number };

// ============================================================================
// Service Method Definition Types
// ============================================================================

/**
 * Defines the shape of a service method including its payload and response types.
 * Used to create a type-safe contract between server and client.
 */
export interface ServiceMethodDefinition<
  TPayload = unknown,
  TResponse = unknown,
> {
  name: string;
  access: AccessLevel;
  handler: (
    payload: TPayload,
    context: ServiceMethodContext
  ) => Promise<TResponse>;
  schema?: z.ZodType<TPayload>;
  resolveEntryId?: (payload: TPayload) => string | null;
}

/**
 * Context provided to service method handlers
 */
export interface ServiceMethodContext {
  userId: string | undefined;
  socketId: string;
  serviceAccess: Record<string, AccessLevel>;
}

/**
 * Type helper for defining service method maps.
 * Each service should define its methods using this structure.
 *
 * @example
 * ```typescript
 * type ChatServiceMethods = ServiceMethodMap<{
 *   createChat: {
 *     payload: { title: string };
 *     response: { id: string };
 *   };
 *   updateTitle: {
 *     payload: { id: string; title: string };
 *     response: { id: string; title: string };
 *   };
 * }>;
 * ```
 */
export type ServiceMethodMap<
  T extends Record<string, { payload: unknown; response: unknown }>,
> = T;

// ============================================================================
// Admin Method Types (Generic shapes for all services)
// ============================================================================

export type AdminListPayload = {
  page?: number;
  pageSize?: number;
  sort?: {
    field?: string;
    direction?: "asc" | "desc";
  };
  filter?: {
    id?: string;
    ids?: string[];
    createdAfter?: string;
    createdBefore?: string;
    updatedAfter?: string;
    updatedBefore?: string;
  } & Record<string, unknown>;
};

export type AdminListResponse<T> = {
  rows: T[];
  page: number;
  pageSize: number;
  total: number;
};

export type AdminGetPayload = { id: string };

export type AdminCreatePayload<TInsert> = { data: Partial<TInsert> };

export type AdminUpdatePayload<TInsert> = {
  id: string;
  data: Partial<TInsert>;
};

export type AdminDeletePayload = { id: string };
export type AdminDeleteResponse = { id: string; deleted: true };

export type AdminSetEntryACLPayload = {
  id: string;
  acl: ACL;
};

export type AdminGetSubscribersPayload = { id: string };
export type AdminGetSubscribersResponse = {
  id: string;
  subscribers: Array<{ socketId: string; userId?: string }>;
};

export type AdminReemitPayload = { id: string };
export type AdminReemitResponse = { emitted: boolean };

export type AdminUnsubscribeAllPayload = { id: string };
export type AdminUnsubscribeAllResponse = { id: string; unsubscribed: number };

// ============================================================================
// Subscription Types
// ============================================================================

export type SubscribePayload = {
  entryId: string;
  requiredLevel?: AccessLevel;
};

export type UnsubscribePayload = {
  entryId: string;
};

// ============================================================================
// Utility Types
// ============================================================================

/**
 * Extracts payload type from a service method definition
 */
export type ExtractPayload<T> = T extends { payload: infer P } ? P : never;

/**
 * Extracts response type from a service method definition
 */
export type ExtractResponse<T> = T extends { response: infer R } ? R : never;

/**
 * Logger interface compatible with Winston and other loggers
 */
export interface Logger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
  child(options: Record<string, unknown>): Logger;
}

/**
 * Default console logger implementation
 */
export const consoleLogger: Logger = {
  info: (message, meta) => console.log(`[INFO] ${message}`, meta ?? ""),
  warn: (message, meta) => console.warn(`[WARN] ${message}`, meta ?? ""),
  error: (message, meta) => console.error(`[ERROR] ${message}`, meta ?? ""),
  debug: (message, meta) => console.debug(`[DEBUG] ${message}`, meta ?? ""),
  child: () => consoleLogger,
};
