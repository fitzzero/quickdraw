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
// Entity and User Interfaces for ACL
// ============================================================================

/**
 * Interface for entities that support entry-level ACL stored as JSON.
 *
 * Use this pattern when:
 * - You want simple ACL without a separate membership table
 * - Access patterns are straightforward (read/write permissions)
 * - You don't need to query "all entities user X can access" efficiently
 *
 * The default `checkEntryACL` in BaseService expects entities to have this shape.
 *
 * @example
 * ```prisma
 * model Document {
 *   id    String @id @default(cuid())
 *   title String
 *   acl   Json?  // Stores ACL array
 * }
 * ```
 *
 * @example
 * ```typescript
 * class DocumentService extends BaseService<Document & ACLEntity, ...> {
 *   constructor(prisma: PrismaClient) {
 *     super({ serviceName: 'documentService', hasEntryACL: true });
 *     this.setDelegate(prisma.document);
 *     // Default checkEntryACL will work automatically
 *   }
 * }
 * ```
 */
export interface ACLEntity {
  id: string;
  acl?: ACL | null;
}

/**
 * Interface for users with service-level access control.
 *
 * The `serviceAccess` field maps service names to access levels, granting
 * blanket permissions across all entries in that service.
 *
 * @example
 * ```prisma
 * model User {
 *   id            String @id @default(cuid())
 *   serviceAccess Json?  // { "chatService": "Admin", "documentService": "Read" }
 * }
 * ```
 *
 * @example
 * ```typescript
 * // User with Admin access to chatService can perform any operation
 * // on any chat, regardless of entry-level ACL
 * const user: QuickdrawUser = {
 *   id: "user-123",
 *   serviceAccess: { chatService: "Admin" }
 * };
 * ```
 */
export interface QuickdrawUser {
  id: string;
  serviceAccess?: Record<string, AccessLevel> | null;
}

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
export interface ServiceMethodDefinition<TPayload = unknown, TResponse = unknown> {
  name: string;
  access: AccessLevel;
  handler: (payload: TPayload, context: ServiceMethodContext) => Promise<TResponse>;
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
export type ServiceMethodMap<T extends Record<string, { payload: unknown; response: unknown }>> = T;

// ============================================================================
// Service Channel Types (high-frequency, fire-and-forget events)
// ============================================================================

/**
 * Channels are the high-frequency counterpart to service methods.
 *
 * Where methods are request/response (ack'd, ACL-checked against the database,
 * counted by the global rate limiter), channels are fire-and-forget: no ack,
 * no response, validated and access-checked entirely in memory, and governed
 * by a per-channel token bucket instead of the global limiter. Use them for
 * traffic where per-message overhead matters and losing a message is fine —
 * game input, cursor positions, typing indicators, telemetry.
 *
 * Wire format: channels route as the Socket.io event
 * `channel:<serviceName>:<channelName>` (see {@link channelEventName}).
 * Clients should emit them volatile; servers broadcast tick data back with
 * `emitToRoomVolatile` so backpressured clients drop frames instead of
 * queueing them.
 *
 * Access model (all checks synchronous, zero DB reads):
 * - Authentication is always required — anonymous sockets are dropped silently.
 * - `"Public"` / `"Read"` access: any authenticated user passes the service gate.
 * - `"Moderate"` / `"Admin"`: requires that level in the socket's in-memory
 *   `serviceAccess`.
 * - Entry-level access is expressed via `requireRoom`: the payload resolves to
 *   a room name and the socket must already be in that room. Room membership
 *   was ACL-checked at subscribe time, so this inherits full entry ACL
 *   semantics without touching the database on the hot path.
 */
export interface ServiceChannelDefinition<TPayload = unknown> {
  name: string;
  access: AccessLevel;
  handler: (payload: TPayload, context: ServiceChannelContext) => void;
  /** Required — channel payloads are untrusted high-frequency input. */
  schema: z.ZodType<TPayload>;
  /** Sustained messages per second allowed per socket. */
  ratePerSecond: number;
  /** Bucket capacity — short bursts above ratePerSecond up to this size. */
  burst: number;
  /**
   * Resolve a room the socket must already be a member of (typically the
   * service room joined via subscribe). Return null to skip the check.
   */
  requireRoom?: (payload: TPayload) => string | null;
}

/**
 * Context provided to channel handlers. Unlike ServiceMethodContext,
 * userId is always present — unauthenticated channel messages are dropped
 * before the handler runs.
 */
export interface ServiceChannelContext {
  userId: string;
  socketId: string;
  serviceAccess: Record<string, AccessLevel>;
}

/**
 * Type helper for defining service channel maps (payload-only — channels
 * have no response).
 *
 * @example
 * ```typescript
 * type GameServiceChannels = ServiceChannelMap<{
 *   input: { seq: number; dx: number; dy: number; boost: boolean };
 * }>;
 * ```
 */
export type ServiceChannelMap<T extends Record<string, unknown>> = T;

/**
 * The Socket.io event name a channel routes as.
 * Shared by the server registry, the React client, and non-JS clients
 * (e.g. the Godot addon) so the wire contract lives in one place.
 */
export function channelEventName(serviceName: string, channelName: string): string {
  return `channel:${serviceName}:${channelName}`;
}

/**
 * Prefix for all channel events — pass to the rate limiter's
 * `excludePrefixes` so channel traffic bypasses the global request limiter
 * (channels enforce their own per-socket token buckets).
 */
export const CHANNEL_EVENT_PREFIX = "channel:";

// ============================================================================
// Admin Method Types (Generic shapes for all services)
// ============================================================================
// One canonical shape per admin method, matching what BaseService actually
// sends and receives on the wire. (Before 4.0 these were declared twice —
// here and in server/types.ts — with different shapes; the server shapes won.)

export type AdminListPayload = {
  page?: number;
  pageSize?: number;
  where?: Record<string, unknown>;
  orderBy?: Record<string, "asc" | "desc">;
};

export type AdminListResponse<T> = {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
};

export type AdminGetPayload = { id: string };

export type AdminCreatePayload<TCreate> = { data: TCreate };

export type AdminUpdatePayload<TUpdate> = {
  id: string;
  data: TUpdate;
};

export type AdminDeletePayload = { id: string };
export type AdminDeleteResponse = { success: boolean; id: string };

export type AdminSetACLPayload = {
  entryId: string;
  acl: ACL;
};

export type AdminGetSubscribersPayload = { entryId: string };
export type AdminSubscribersResponse = {
  entryId: string;
  subscribers: Array<{ socketId: string; userId: string | null }>;
  count: number;
};

export type AdminReemitPayload = { entryId: string };
export type AdminReemitResponse = { success: boolean; subscriberCount: number };

export type AdminUnsubscribeAllPayload = { entryId: string };
export type AdminUnsubscribeAllResponse = { success: boolean; unsubscribedCount: number };

// ============================================================================
// Admin Field Configuration Types
// ============================================================================

/**
 * Supported field types for admin UI generation.
 */
export type AdminFieldType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "enum"
  | "json"
  | "relation";

/**
 * Configuration for a single field in the admin UI.
 * Derived from Zod schemas with optional overrides.
 */
export interface AdminFieldConfig {
  /** Field name (property key on the entity) */
  name: string;
  /** Field type for rendering appropriate input */
  type: AdminFieldType;
  /** Human-readable label */
  label: string;
  /** Whether the field is required for creation */
  required: boolean;
  /** Whether the field can be edited (false for id, createdAt, etc.) */
  editable: boolean;
  /** Whether to show this field as a table column */
  showInTable: boolean;
  /** Whether the table can be sorted by this field */
  sortable: boolean;
  /** For enum fields, the allowed values */
  enumValues?: string[];
  /** For relation fields, the related service name */
  relationService?: string;
}

/**
 * Service metadata for admin UI generation.
 * Returned by the adminMeta method.
 */
export interface AdminServiceMeta {
  /** Internal service name (e.g., "chatService") */
  serviceName: string;
  /** Human-readable display name (e.g., "Chats") */
  displayName: string;
  /** Field configurations derived from schema */
  fields: AdminFieldConfig[];
}

/**
 * Payload for adminMeta method (no parameters needed)
 */
export type AdminMetaPayload = Record<string, never>;

/**
 * Response type for adminMeta method
 */
export type AdminMetaResponse = AdminServiceMeta;

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
// Room Naming (shared between server emitters and client listeners)
// ============================================================================

/**
 * The Socket.io room for an entity subscription: `{serviceName}:{entryId}`.
 *
 * Static counterpart to `BaseService.getRoomName` — usable from shared
 * modules and when emitting into *another* service's room without holding
 * its instance.
 */
export function serviceRoom(serviceName: string, entryId: string): string {
  return `${serviceName}:${entryId}`;
}

/**
 * The room subscribers of an elevated (unfiltered) entity tier join in
 * addition to {@link serviceRoom}. Emission targets it via
 * `io.to(fullRoom)` + `io.to(room).except(fullRoom)`.
 */
export function serviceFullRoom(serviceName: string, entryId: string): string {
  return `${serviceRoom(serviceName, entryId)}:full`;
}

/**
 * The room for a collection scope:
 * `{serviceName}:collection:{collection}:{scopeId}`.
 * Entity ids are cuids, so this never collides with {@link serviceRoom}.
 */
export function collectionRoom(serviceName: string, collection: string, scopeId: string): string {
  return `${serviceName}:collection:${collection}:${scopeId}`;
}

/**
 * The event name collection deltas are emitted as. Identical to the room
 * name by design — one event per scope room, no id parsing client-side.
 */
export function collectionEventName(
  serviceName: string,
  collection: string,
  scopeId: string,
): string {
  return collectionRoom(serviceName, collection, scopeId);
}

/**
 * The per-user room every authenticated socket joins on connection:
 * `user:{userId}`. Used for targeted notifications and adapter-safe
 * revocation (`kickFromCollection`).
 */
export function userRoom(userId: string): string {
  return `user:${userId}`;
}

// ============================================================================
// Typed Room Events
// ============================================================================

/**
 * Augmentable map of custom room event names to their payload types.
 * Empty by default — `emitToRoom` and `useRoomEvents` degrade gracefully to
 * `string` names and `unknown` payloads until an app augments it:
 *
 * @example
 * ```typescript
 * // In your app's shared types
 * declare module "@fitzzero/quickdraw-core" {
 *   interface QuickdrawEventMap {
 *     "chat:memberUpdate": { chatId: string; userId: string };
 *     "presence:changed": { userId: string; online: boolean };
 *   }
 * }
 * ```
 *
 * Collection deltas and `{service}:update:{id}` events need no entries here —
 * they are framework-generated and typed end-to-end by the service generics.
 */
// oxlint-disable-next-line typescript/no-empty-interface, typescript/no-empty-object-type
export interface QuickdrawEventMap {}

/**
 * Event names accepted by `emitToRoom`/`useRoomEvents`: keys of the
 * augmented {@link QuickdrawEventMap} (with autocomplete) plus any string.
 */
export type QuickdrawEventName =
  | (keyof QuickdrawEventMap & string)
  | (string & Record<never, never>);

/**
 * Payload type for a room event: the mapped type when the name is in
 * {@link QuickdrawEventMap}, `unknown` otherwise.
 */
export type QuickdrawEventData<E extends string> = E extends keyof QuickdrawEventMap
  ? QuickdrawEventMap[E]
  : unknown;

// ============================================================================
// Collection Subscription Types (wire protocol)
// ============================================================================

/**
 * One page of a collection snapshot, returned by a collection's `snapshot`
 * query and by the `{service}:collection:subscribe` ack.
 */
export interface CollectionSnapshotPage<TItem> {
  items: TItem[];
  nextCursor: string | null;
  totalCount: number;
  /**
   * Full membership id list for the scope (ids only, cheap select).
   * Returned on cursor-less (first-page / re-snapshot) requests so clients
   * can prune rows deleted while disconnected. Omit for unbounded scopes
   * (e.g. long chat histories) — the client then merges without pruning.
   */
  ids?: string[];
  /**
   * Set by the server when the scope's id list exceeded the cap (5,000) and
   * `ids` was dropped — the client degrades to no-prune merges.
   */
  idsTruncated?: boolean;
}

/** Snapshot page plus the revision captured before the query ran. */
export type CollectionSnapshotResponse<TItem> = CollectionSnapshotPage<TItem> & { rev: number };

/**
 * Payload for `{service}:collection:subscribe`. Cursor-less calls join the
 * scope room and may include `ids`; cursor-bearing calls are pure paging —
 * no room join, no `ids`.
 */
export type CollectionSubscribePayload = {
  collection: string;
  scopeId: string;
  cursor?: string | null;
  limit?: number;
};

/** Payload for `{service}:collection:unsubscribe`. */
export type CollectionUnsubscribePayload = {
  collection: string;
  scopeId: string;
};

/**
 * A collection change, emitted to the scope room under the event name
 * {@link collectionEventName}.
 *
 * `rev` is per-item last-writer-wins: clients ignore an `added`/`updated`
 * older than what they hold for that id, and snapshot items only overwrite
 * cached items whose rev predates the snapshot rev. Revisions are epoch
 * milliseconds (`Date.now()` at emit, or the collection's `revOf`).
 */
export type CollectionDelta<TItem extends { id: string }> =
  | { type: "added"; item: TItem; rev: number }
  | { type: "updated"; item: TItem; rev: number }
  | { type: "removed"; id: string; rev: number }
  | { type: "reset"; rev: number };

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
