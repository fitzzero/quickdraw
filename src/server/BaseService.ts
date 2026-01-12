import type { Server as SocketIOServer } from "socket.io";
import type { z } from "zod";
import type {
  AccessLevel,
  ServiceMethodDefinition,
  ServiceMethodContext,
  Logger,
  ACL,
  AdminServiceMeta,
} from "../shared/types";
import { consoleLogger } from "../shared/types";
import type {
  QuickdrawSocket,
  BaseServiceOptions,
  InstallAdminMethodsOptions,
  PrismaDelegate,
  AdminListPayload,
  AdminListResponse,
  AdminSetACLPayload,
  AdminSubscribersResponse,
} from "./types";
import {
  zodToAdminFields,
  mergeWithDefaultFields,
} from "./utils/zodToAdminFields";

/**
 * Base class for all quickdraw services.
 *
 * Provides:
 * - Typed CRUD operations with auto-emit to subscribers
 * - Real-time subscription management
 * - ACL-based access control (service-level and entry-level)
 * - Public method definition with type inference
 * - Admin method scaffolding
 *
 * @typeParam TEntity - The entity type (e.g., Prisma model type)
 * @typeParam TCreateInput - The create input type
 * @typeParam TUpdateInput - The update input type
 * @typeParam TServiceMethods - Service method definitions map
 *
 * @example
 * ```typescript
 * class ChatService extends BaseService<
 *   Chat,
 *   Prisma.ChatCreateInput,
 *   Prisma.ChatUpdateInput,
 *   ChatServiceMethods
 * > {
 *   constructor(prisma: PrismaClient) {
 *     super({
 *       serviceName: 'chatService',
 *       hasEntryACL: true,
 *     });
 *     this.setDelegate(prisma.chat);
 *   }
 * }
 * ```
 */
export abstract class BaseService<
  TEntity extends { id: string },
  TCreateInput extends Record<string, unknown>,
  TUpdateInput extends Record<string, unknown>,
  TServiceMethods extends Record<
    string,
    { payload: unknown; response: unknown }
  > = Record<string, { payload: unknown; response: unknown }>
> {
  public readonly serviceName: string;
  protected readonly hasEntryACL: boolean;
  protected readonly defaultACL: ACL;
  protected readonly logger: Logger;

  // Subscription tracking: entryId -> Set of sockets
  protected readonly subscribers: Map<string, Set<QuickdrawSocket>> = new Map();

  // Prisma delegate for DB operations
  protected delegate:
    | PrismaDelegate<TEntity, TCreateInput, TUpdateInput>
    | undefined;

  // Socket.io server instance for room-based broadcasts
  protected io: SocketIOServer | null = null;

  // Collection of public methods for registry discovery
  private readonly publicMethods: Map<
    string,
    ServiceMethodDefinition<unknown, unknown>
  > = new Map();

  // Admin metadata configuration (set by installAdminMethods)
  private adminMeta: AdminServiceMeta | null = null;

  constructor(options: BaseServiceOptions) {
    this.serviceName = options.serviceName;
    this.hasEntryACL = options.hasEntryACL ?? false;
    this.defaultACL = options.defaultACL ?? [];
    this.logger =
      options.logger?.child({ service: this.serviceName }) ??
      consoleLogger.child({ service: this.serviceName });
  }

  /**
   * Set the Prisma delegate for this service.
   * Must be called in the constructor of derived classes.
   */
  protected setDelegate(
    delegate: PrismaDelegate<TEntity, TCreateInput, TUpdateInput>
  ): void {
    this.delegate = delegate;
  }

  /**
   * Set the Socket.io server instance for room-based broadcasts.
   * Called automatically by ServiceRegistry during registration.
   */
  public setIo(io: SocketIOServer): void {
    this.io = io;
  }

  /**
   * Get the delegate, throwing if not set.
   */
  protected getDelegate(): PrismaDelegate<TEntity, TCreateInput, TUpdateInput> {
    if (!this.delegate) {
      throw new Error(
        `Delegate not set for service ${this.serviceName}. Call setDelegate() in constructor.`
      );
    }
    return this.delegate;
  }

  // ===========================================================================
  // Subscription Management
  // ===========================================================================

  /**
   * Get the Socket.io room name for an entry.
   * Used for room-based broadcasting across services.
   */
  public getRoomName(entryId: string): string {
    return `${this.serviceName}:${entryId}`;
  }

  /**
   * Subscribe a socket to an entity's updates.
   * Returns the current entity data if access is granted, null otherwise.
   * Also joins the socket to the entity's Socket.io room for cross-service events.
   */
  public async subscribe(
    entryId: string,
    socket: QuickdrawSocket,
    requiredLevel: AccessLevel = "Read"
  ): Promise<TEntity | null> {
    if (!socket.userId) {
      return null;
    }

    // Check access
    const allowed = await this.checkSubscriptionAccess(
      socket.userId,
      entryId,
      requiredLevel,
      socket
    );

    if (!allowed) {
      return null;
    }

    // Add to subscribers
    if (!this.subscribers.has(entryId)) {
      this.subscribers.set(entryId, new Set());
    }
    this.subscribers.get(entryId)!.add(socket);

    // Join Socket.io room for room-based broadcasting
    const roomName = this.getRoomName(entryId);
    void socket.join(roomName);

    this.logger.debug(
      `User ${socket.userId} subscribed to ${entryId} (room: ${roomName})`
    );

    // Return current entity data, filtered based on subscriber's access level
    const entity = await this.findById(entryId);
    if (!entity) return null;

    return this.filterEntityForSubscriber(entity, socket, entryId) as TEntity;
  }

  /**
   * Unsubscribe a socket from an entity's updates.
   */
  public unsubscribe(entryId: string, socket: QuickdrawSocket): void {
    const subs = this.subscribers.get(entryId);
    if (subs) {
      subs.delete(socket);
      if (subs.size === 0) {
        this.subscribers.delete(entryId);
      }
    }

    // Leave Socket.io room
    const roomName = this.getRoomName(entryId);
    void socket.leave(roomName);
  }

  /**
   * Remove a socket from all subscriptions (called on disconnect).
   */
  public unsubscribeSocket(socket: QuickdrawSocket): void {
    for (const [entryId, sockets] of this.subscribers.entries()) {
      if (sockets.has(socket)) {
        sockets.delete(socket);
        // Leave Socket.io room
        const roomName = this.getRoomName(entryId);
        void socket.leave(roomName);
        if (sockets.size === 0) {
          this.subscribers.delete(entryId);
        }
      }
    }
  }

  /**
   * Emit a custom event to all subscribers of an entry via Socket.io rooms.
   * This is useful for cross-service events (e.g., message service notifying chat subscribers).
   *
   * @param roomName - The Socket.io room name (use getRoomName for service rooms)
   * @param eventName - The event name to emit
   * @param data - The data to emit
   *
   * @example
   * ```typescript
   * // In MessageService, notify chat subscribers of a new message
   * this.emitToRoom(
   *   `chatService:${message.chatId}`,
   *   'chat:message',
   *   messageDTO
   * );
   * ```
   */
  protected emitToRoom(
    roomName: string,
    eventName: string,
    data: unknown
  ): void {
    // Preferred: use io instance directly (sends to ALL in room including sender)
    if (this.io) {
      this.io.to(roomName).emit(eventName, data);
      this.logger.debug(`Emitted ${eventName} to room ${roomName}`);
      return;
    }

    // Fallback: use any subscriber socket (excludes that socket from broadcast)
    const anySocket = this.getAnySubscriberSocket();
    if (!anySocket) {
      this.logger.debug(`No sockets available to emit to room ${roomName}`);
      return;
    }

    anySocket.to(roomName).emit(eventName, data);
    this.logger.debug(
      `Emitted ${eventName} to room ${roomName} (via socket fallback)`
    );
  }

  /**
   * Get any active socket for room-based operations.
   */
  private getAnySubscriberSocket(): QuickdrawSocket | null {
    for (const sockets of this.subscribers.values()) {
      const first = sockets.values().next();
      if (!first.done) {
        return first.value;
      }
    }
    return null;
  }

  /**
   * Emit an update to all subscribers of an entity.
   * Uses tier-based pre-filtering: computes filtered versions once,
   * then selects the appropriate version per subscriber.
   */
  protected emitUpdate(entryId: string, data: Partial<TEntity>): void {
    const subs = this.subscribers.get(entryId);
    if (!subs || subs.size === 0) return;

    const eventName = `${this.serviceName}:update:${entryId}`;

    // Pre-compute filtered versions (O(1) regardless of subscriber count)
    const fullData = data;
    const publicData = this.stripProtectedFields(data);

    for (const socket of subs) {
      const payload = this.hasElevatedAccess(socket, entryId)
        ? fullData
        : publicData;
      socket.emit(eventName, payload);
    }
  }

  // ===========================================================================
  // Access Control
  // ===========================================================================

  /**
   * Check if a user has access to subscribe to an entity.
   * Override in derived classes for custom logic.
   */
  protected async checkSubscriptionAccess(
    userId: string,
    entryId: string,
    requiredLevel: AccessLevel,
    socket: QuickdrawSocket
  ): Promise<boolean> {
    // First check service-level access
    if (this.hasServiceAccess(socket, requiredLevel)) {
      return true;
    }

    // Then check via checkAccess (which derived classes can override)
    if (this.checkAccess(userId, entryId, requiredLevel, socket)) {
      return true;
    }

    // Finally check entry-level ACL if enabled
    if (this.hasEntryACL) {
      return await this.checkEntryACL(userId, entryId, requiredLevel);
    }

    return false;
  }

  /**
   * Check if a socket has service-level access.
   */
  protected hasServiceAccess(
    socket: QuickdrawSocket,
    requiredLevel: AccessLevel
  ): boolean {
    const userLevel = socket.serviceAccess?.[this.serviceName];
    if (!userLevel) return false;
    return this.isLevelSufficient(userLevel, requiredLevel);
  }

  /**
   * Check if a user has access to an entity.
   * Override in derived classes for custom logic (e.g., self-access).
   */
  protected checkAccess(
    _userId: string,
    _entryId: string,
    _requiredLevel: AccessLevel,
    _socket: QuickdrawSocket
  ): boolean {
    // Default: deny (override in derived classes)
    return false;
  }

  /**
   * Check entry-level ACL stored on the entity.
   */
  protected async checkEntryACL(
    userId: string,
    entryId: string,
    requiredLevel: AccessLevel
  ): Promise<boolean> {
    try {
      const entity = await this.getDelegate().findUnique({
        where: { id: entryId } as { id: string },
        select: { acl: true } as Record<string, boolean>,
      });

      const acl = (entity as unknown as { acl?: ACL })?.acl;
      if (!acl || !Array.isArray(acl)) return false;

      const ace = acl.find((a) => a.userId === userId);
      if (!ace) return false;

      return this.isLevelSufficient(ace.level, requiredLevel);
    } catch {
      return false;
    }
  }

  /**
   * Compare access levels.
   */
  protected isLevelSufficient(
    userLevel: AccessLevel,
    requiredLevel: AccessLevel
  ): boolean {
    const order: Record<AccessLevel, number> = {
      Public: 0,
      Read: 1,
      Moderate: 2,
      Admin: 3,
    };
    return (order[userLevel] ?? 0) >= (order[requiredLevel] ?? 0);
  }

  /**
   * Ensure access for a public method.
   * Throws if access is denied.
   */
  public async ensureAccessForMethod(
    requiredLevel: AccessLevel,
    socket: QuickdrawSocket,
    entryId?: string
  ): Promise<void> {
    if (requiredLevel === "Public") {
      return;
    }

    if (!socket.userId) {
      throw new Error("Authentication required");
    }

    // Service-level access is always sufficient
    if (this.hasServiceAccess(socket, requiredLevel)) {
      return;
    }

    // For entry-scoped methods, check entry access
    if (entryId) {
      if (this.checkAccess(socket.userId, entryId, requiredLevel, socket)) {
        return;
      }
      if (
        this.hasEntryACL &&
        (await this.checkEntryACL(socket.userId, entryId, requiredLevel))
      ) {
        return;
      }
      throw new Error("Insufficient permissions");
    }

    // Non-entry-scoped Read methods are allowed for authenticated users
    if (requiredLevel === "Read") {
      return;
    }

    throw new Error("Insufficient permissions");
  }

  // ===========================================================================
  // Protected Fields Filtering
  // ===========================================================================

  /**
   * Get the list of fields that should be stripped for non-elevated subscribers.
   * Override in derived classes to customize which fields are protected.
   *
   * @example
   * ```typescript
   * protected override getProtectedFields(): (keyof User)[] {
   *   return ['email', 'serviceAccess', 'discordId'];
   * }
   * ```
   */
  protected getProtectedFields(): (keyof TEntity)[] {
    return ["email", "serviceAccess"] as (keyof TEntity)[];
  }

  /**
   * Check if a socket has elevated access to an entity (receives full data).
   * Default: owner (socket.userId === entryId) or service-level Admin.
   * Override in derived classes for custom logic.
   *
   * @example
   * ```typescript
   * protected override hasElevatedAccess(socket: QuickdrawSocket, entryId: string): boolean {
   *   // Friends can see more data
   *   return super.hasElevatedAccess(socket, entryId) ||
   *          this.isFriend(socket.userId, entryId);
   * }
   * ```
   */
  protected hasElevatedAccess(
    socket: QuickdrawSocket,
    entryId: string
  ): boolean {
    return socket.userId === entryId || this.hasServiceAccess(socket, "Admin");
  }

  /**
   * Strip protected fields from an entity.
   * Used internally by filterEntityForSubscriber.
   */
  protected stripProtectedFields<T extends Partial<TEntity>>(entity: T): T {
    const protectedFields = this.getProtectedFields();
    const result = { ...entity };
    for (const field of protectedFields) {
      delete result[field as keyof T];
    }
    return result;
  }

  /**
   * Filter entity data based on subscriber's access level.
   * Override for complex filtering logic (e.g., multiple tiers).
   *
   * @example
   * ```typescript
   * protected override filterEntityForSubscriber(
   *   entity: Partial<TEntity>,
   *   socket: QuickdrawSocket,
   *   entryId: string
   * ): Partial<TEntity> {
   *   if (this.hasElevatedAccess(socket, entryId)) return entity;
   *   if (this.isFriend(socket.userId, entryId)) return this.stripForFriends(entity);
   *   return this.stripProtectedFields(entity);
   * }
   * ```
   */
  protected filterEntityForSubscriber(
    entity: Partial<TEntity>,
    socket: QuickdrawSocket,
    entryId: string
  ): Partial<TEntity> {
    return this.hasElevatedAccess(socket, entryId)
      ? entity
      : this.stripProtectedFields(entity);
  }

  // ===========================================================================
  // CRUD Operations
  // ===========================================================================

  /**
   * Find an entity by ID.
   */
  protected async findById(id: string): Promise<TEntity | null> {
    return await this.getDelegate().findUnique({
      where: { id } as { id: string },
    });
  }

  /**
   * Create an entity and emit to subscribers.
   */
  protected async create(data: TCreateInput): Promise<TEntity> {
    const entity = await this.getDelegate().create({ data });
    this.emitUpdate(entity.id, entity);
    this.logger.info(`Created entity ${entity.id}`);
    return entity;
  }

  /**
   * Update an entity and emit to subscribers.
   */
  protected async update(
    id: string,
    data: TUpdateInput
  ): Promise<TEntity | null> {
    try {
      const entity = await this.getDelegate().update({
        where: { id } as { id: string },
        data,
      });
      this.emitUpdate(id, entity);
      this.logger.info(`Updated entity ${id}`);
      return entity;
    } catch {
      return null;
    }
  }

  /**
   * Delete an entity and emit deletion event to subscribers.
   */
  protected async delete(id: string): Promise<boolean> {
    try {
      await this.getDelegate().delete({
        where: { id } as { id: string },
      });
      this.emitUpdate(id, { id, deleted: true } as unknown as Partial<TEntity>);
      this.logger.info(`Deleted entity ${id}`);
      return true;
    } catch {
      return false;
    }
  }

  // ===========================================================================
  // Public Method Definition
  // ===========================================================================

  /**
   * Define a public method that will be exposed via Socket.io.
   *
   * @typeParam K - Method name from the service methods map
   */
  protected defineMethod<K extends keyof TServiceMethods & string>(
    name: K,
    access: AccessLevel,
    handler: (
      payload: TServiceMethods[K]["payload"],
      context: ServiceMethodContext
    ) => Promise<TServiceMethods[K]["response"]>,
    options?: {
      schema?: z.ZodType<TServiceMethods[K]["payload"]>;
      resolveEntryId?: (
        payload: TServiceMethods[K]["payload"]
      ) => string | null;
    }
  ): ServiceMethodDefinition<
    TServiceMethods[K]["payload"],
    TServiceMethods[K]["response"]
  > {
    const definition: ServiceMethodDefinition<
      TServiceMethods[K]["payload"],
      TServiceMethods[K]["response"]
    > = {
      name,
      access,
      handler: handler as (
        payload: TServiceMethods[K]["payload"],
        context: ServiceMethodContext
      ) => Promise<TServiceMethods[K]["response"]>,
      schema: options?.schema,
      resolveEntryId: options?.resolveEntryId,
    };

    this.publicMethods.set(
      name,
      definition as ServiceMethodDefinition<unknown, unknown>
    );
    return definition;
  }

  /**
   * Get all public methods for registry discovery.
   */
  public getPublicMethods(): ServiceMethodDefinition<unknown, unknown>[] {
    return Array.from(this.publicMethods.values());
  }

  // ===========================================================================
  // Admin Methods
  // ===========================================================================

  /**
   * Install standard admin CRUD methods.
   * Call this in derived class constructor to expose admin endpoints.
   *
   * @example
   * ```typescript
   * this.installAdminMethods({
   *   expose: { list: true, get: true, create: true, update: true, delete: true },
   *   access: {
   *     list: "Admin",
   *     get: "Admin",
   *     create: "Admin",
   *     update: "Admin",
   *     delete: "Admin",
   *     setEntryACL: "Admin",
   *     getSubscribers: "Admin",
   *     reemit: "Admin",
   *     unsubscribeAll: "Admin",
   *   },
   *   schema: createEntitySchema,
   *   displayName: "Entities",
   * });
   * ```
   */
  protected installAdminMethods(options: InstallAdminMethodsOptions): void {
    const {
      expose,
      access,
      schema,
      displayName,
      tableColumns,
      hiddenFields,
      fieldOverrides,
    } = options;

    // Build admin metadata if schema is provided
    if (schema) {
      const schemaFields = zodToAdminFields(schema, {
        hiddenFields,
        tableColumns,
        fieldOverrides,
      });

      // Merge with default entity fields (id, createdAt, updatedAt)
      const fields = mergeWithDefaultFields(schemaFields);

      this.adminMeta = {
        serviceName: this.serviceName,
        displayName: displayName ?? this.toDisplayName(this.serviceName),
        fields,
      };
    } else {
      // Even without a schema, provide basic meta
      this.adminMeta = {
        serviceName: this.serviceName,
        displayName: displayName ?? this.toDisplayName(this.serviceName),
        fields: [],
      };
    }

    // Determine if adminMeta should be exposed (default: true if any CRUD method is exposed)
    const shouldExposeMeta =
      expose.meta ??
      (expose.list ||
        expose.get ||
        expose.create ||
        expose.update ||
        expose.delete);

    if (shouldExposeMeta) {
      this.publicMethods.set("adminMeta", {
        name: "adminMeta",
        access: access.meta ?? access.list,
        handler: async (
          _payload: unknown,
          _context: ServiceMethodContext
        ): Promise<AdminServiceMeta> => {
          return this.getAdminMeta();
        },
      } as ServiceMethodDefinition<unknown, unknown>);
    }

    if (expose.list) {
      this.publicMethods.set("adminList", {
        name: "adminList",
        access: access.list,
        handler: async (payload: unknown, _context: ServiceMethodContext) => {
          return await this.adminList(payload as AdminListPayload);
        },
      } as ServiceMethodDefinition<unknown, unknown>);
    }

    if (expose.get) {
      this.publicMethods.set("adminGet", {
        name: "adminGet",
        access: access.get,
        handler: async (payload: unknown, _context: ServiceMethodContext) => {
          return await this.adminGet((payload as { id: string }).id);
        },
        resolveEntryId: (payload: unknown) => (payload as { id: string }).id,
      } as ServiceMethodDefinition<unknown, unknown>);
    }

    if (expose.create) {
      this.publicMethods.set("adminCreate", {
        name: "adminCreate",
        access: access.create,
        handler: async (payload: unknown, _context: ServiceMethodContext) => {
          return await this.adminCreate(
            (payload as { data: TCreateInput }).data
          );
        },
      } as ServiceMethodDefinition<unknown, unknown>);
    }

    if (expose.update) {
      this.publicMethods.set("adminUpdate", {
        name: "adminUpdate",
        access: access.update,
        handler: async (payload: unknown, _context: ServiceMethodContext) => {
          const { id, data } = payload as { id: string; data: TUpdateInput };
          return await this.adminUpdate(id, data);
        },
        resolveEntryId: (payload: unknown) => (payload as { id: string }).id,
      } as ServiceMethodDefinition<unknown, unknown>);
    }

    if (expose.delete) {
      this.publicMethods.set("adminDelete", {
        name: "adminDelete",
        access: access.delete,
        handler: async (payload: unknown, _context: ServiceMethodContext) => {
          return await this.adminDelete((payload as { id: string }).id);
        },
        resolveEntryId: (payload: unknown) => (payload as { id: string }).id,
      } as ServiceMethodDefinition<unknown, unknown>);
    }

    if (expose.setEntryACL) {
      this.publicMethods.set("adminSetEntryACL", {
        name: "adminSetEntryACL",
        access: access.setEntryACL,
        handler: async (payload: unknown, _context: ServiceMethodContext) => {
          return await this.adminSetEntryACL(payload as AdminSetACLPayload);
        },
        resolveEntryId: (payload: unknown) =>
          (payload as { entryId: string }).entryId,
      } as ServiceMethodDefinition<unknown, unknown>);
    }

    if (expose.getSubscribers) {
      this.publicMethods.set("adminGetSubscribers", {
        name: "adminGetSubscribers",
        access: access.getSubscribers,
        handler: async (payload: unknown, _context: ServiceMethodContext) => {
          return this.adminGetSubscribers(
            (payload as { entryId: string }).entryId
          );
        },
        resolveEntryId: (payload: unknown) =>
          (payload as { entryId: string }).entryId,
      } as ServiceMethodDefinition<unknown, unknown>);
    }

    if (expose.reemit) {
      this.publicMethods.set("adminReemit", {
        name: "adminReemit",
        access: access.reemit,
        handler: async (payload: unknown, _context: ServiceMethodContext) => {
          return await this.adminReemit(
            (payload as { entryId: string }).entryId
          );
        },
        resolveEntryId: (payload: unknown) =>
          (payload as { entryId: string }).entryId,
      } as ServiceMethodDefinition<unknown, unknown>);
    }

    if (expose.unsubscribeAll) {
      this.publicMethods.set("adminUnsubscribeAll", {
        name: "adminUnsubscribeAll",
        access: access.unsubscribeAll,
        handler: async (payload: unknown, _context: ServiceMethodContext) => {
          return this.adminUnsubscribeAll(
            (payload as { entryId: string }).entryId
          );
        },
        resolveEntryId: (payload: unknown) =>
          (payload as { entryId: string }).entryId,
      } as ServiceMethodDefinition<unknown, unknown>);
    }

    const installedMethods = Object.keys(expose).filter(
      (k) => expose[k as keyof typeof expose]
    );
    if (shouldExposeMeta) installedMethods.push("meta");

    this.logger.info(`Installed admin methods: ${installedMethods.join(", ")}`);
  }

  /**
   * Convert service name to display name.
   * e.g., "chatService" -> "Chats", "userService" -> "Users"
   */
  private toDisplayName(serviceName: string): string {
    return (
      serviceName
        // Remove "Service" suffix
        .replace(/Service$/i, "")
        // Add space before capitals
        .replace(/([a-z])([A-Z])/g, "$1 $2")
        // Capitalize first letter
        .replace(/^./, (c) => c.toUpperCase()) + "s"
    );
  }

  /**
   * Get admin metadata for this service.
   * Returns the configured metadata or throws if not configured.
   */
  public getAdminMeta(): AdminServiceMeta {
    if (!this.adminMeta) {
      throw new Error(
        `Admin methods not installed for ${this.serviceName}. Call installAdminMethods() first.`
      );
    }
    return this.adminMeta;
  }

  /**
   * Admin method: List entities with pagination and filters.
   */
  protected async adminList(
    payload: AdminListPayload
  ): Promise<AdminListResponse<TEntity>> {
    const { page = 1, pageSize = 20, where, orderBy } = payload;
    const skip = (page - 1) * pageSize;

    const [items, total] = await Promise.all([
      this.getDelegate().findMany({
        where,
        orderBy,
        skip,
        take: pageSize,
      }),
      this.getDelegate().count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * Admin method: Get a single entity by ID.
   */
  protected async adminGet(id: string): Promise<TEntity | null> {
    return await this.findById(id);
  }

  /**
   * Admin method: Create an entity.
   */
  protected async adminCreate(data: TCreateInput): Promise<TEntity> {
    return await this.create(data);
  }

  /**
   * Admin method: Update an entity.
   */
  protected async adminUpdate(
    id: string,
    data: TUpdateInput
  ): Promise<TEntity | null> {
    return await this.update(id, data);
  }

  /**
   * Admin method: Delete an entity.
   */
  protected async adminDelete(
    id: string
  ): Promise<{ success: boolean; id: string }> {
    const deleted = await this.delete(id);
    return { success: deleted, id };
  }

  /**
   * Admin method: Set entry-level ACL.
   */
  protected async adminSetEntryACL(
    payload: AdminSetACLPayload
  ): Promise<TEntity | null> {
    const { entryId, acl } = payload;

    try {
      // Update the ACL field on the entity
      const entity = await this.getDelegate().update({
        where: { id: entryId } as { id: string },
        data: { acl } as unknown as TUpdateInput,
      });

      // Emit update to subscribers so they receive the new ACL
      this.emitUpdate(entryId, entity);

      this.logger.info(`Updated ACL for entity ${entryId}`);
      return entity;
    } catch (error) {
      this.logger.error(`Failed to set ACL for ${entryId}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Admin method: Get active subscribers for an entity.
   */
  protected adminGetSubscribers(entryId: string): AdminSubscribersResponse {
    const subs = this.subscribers.get(entryId);
    if (!subs) {
      return { entryId, subscribers: [], count: 0 };
    }

    const subscribers = Array.from(subs).map((socket) => ({
      socketId: socket.id,
      userId: socket.userId ?? null,
    }));

    return {
      entryId,
      subscribers,
      count: subscribers.length,
    };
  }

  /**
   * Admin method: Re-emit current entity state to all subscribers.
   * Useful when you've made direct DB changes or need to force-refresh clients.
   */
  protected async adminReemit(
    entryId: string
  ): Promise<{ success: boolean; subscriberCount: number }> {
    const entity = await this.findById(entryId);
    if (!entity) {
      return { success: false, subscriberCount: 0 };
    }

    const subs = this.subscribers.get(entryId);
    const count = subs?.size ?? 0;

    this.emitUpdate(entryId, entity);

    this.logger.info(`Re-emitted entity ${entryId} to ${count} subscribers`);
    return { success: true, subscriberCount: count };
  }

  /**
   * Admin method: Unsubscribe all sockets from an entity.
   */
  protected adminUnsubscribeAll(entryId: string): {
    success: boolean;
    unsubscribedCount: number;
  } {
    const subs = this.subscribers.get(entryId);
    const count = subs?.size ?? 0;

    if (subs) {
      // Notify subscribers they're being unsubscribed
      const eventName = `${this.serviceName}:unsubscribed:${entryId}`;
      for (const socket of subs) {
        socket.emit(eventName, { reason: "admin_action" });
      }

      this.subscribers.delete(entryId);
    }

    this.logger.info(`Unsubscribed ${count} sockets from entity ${entryId}`);
    return { success: true, unsubscribedCount: count };
  }

  // ===========================================================================
  // Utility Methods
  // ===========================================================================

  /**
   * Fields that should never be exposed or editable via admin methods.
   */
  protected getDefaultDeniedFields(): string[] {
    return ["id", "createdAt", "updatedAt", "acl", "serviceAccess"];
  }
}
