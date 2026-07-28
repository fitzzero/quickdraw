import type { Server as SocketIOServer } from "socket.io";
import type { z } from "zod";
import type {
  AccessLevel,
  ServiceMethodDefinition,
  ServiceMethodContext,
  ServiceChannelDefinition,
  ServiceChannelContext,
  Logger,
  ACL,
  AdminServiceMeta,
  AdminListPayload,
  AdminListResponse,
  AdminSetACLPayload,
  AdminSubscribersResponse,
  QuickdrawEventName,
  QuickdrawEventData,
  CollectionSubscribePayload,
  CollectionSnapshotResponse,
  CollectionUnsubscribePayload,
} from "../shared/types";
import { consoleLogger, serviceRoom, serviceFullRoom, userRoom } from "../shared/types";
import type {
  QuickdrawSocket,
  BaseServiceOptions,
  InstallAdminMethodsOptions,
  PrismaDelegate,
} from "./types";
import { CollectionManager, type CollectionDefinition } from "./collections";
import { zodToAdminFields, mergeWithDefaultFields } from "./utils/zodToAdminFields";

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
 * @typeParam TChannels - Service channel payload map (high-frequency fire-and-forget events)
 * @typeParam TDto - The wire shape emitted to subscribers (defaults to TEntity; see `toDto`)
 * @typeParam TCollections - Collection map: name -> { item } (see `defineCollection`)
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
  TServiceMethods extends {
    [K in keyof TServiceMethods]: { payload: unknown; response: unknown };
  } = Record<string, { payload: unknown; response: unknown }>,
  TChannels extends { [K in keyof TChannels]: unknown } = Record<string, unknown>,
  TDto extends { id: string } = TEntity,
  TCollections extends {
    [K in keyof TCollections]: { item: { id: string } };
  } = Record<string, { item: { id: string } }>,
> {
  public readonly serviceName: string;
  protected readonly hasEntryACL: boolean;
  protected readonly defaultACL: ACL;
  protected readonly logger: Logger;

  // Subscription tracking: entryId -> Set of sockets.
  // Retained for admin introspection (adminGetSubscribers) only — emission
  // is room-based and never reads this map.
  protected readonly subscribers: Map<string, Set<QuickdrawSocket>> = new Map();

  // Prisma delegate for DB operations
  protected delegate: PrismaDelegate<TEntity, TCreateInput, TUpdateInput> | undefined;

  // Socket.io server instance for room-based broadcasts
  protected io: SocketIOServer | null = null;

  // Collection of public methods for registry discovery
  private readonly publicMethods: Map<string, ServiceMethodDefinition<unknown, unknown>> =
    new Map();

  // Collection of channels for registry discovery
  private readonly publicChannels: Map<string, ServiceChannelDefinition<unknown>> = new Map();

  // Scope-keyed collections (definitions, snapshot dispatch, delta emission)
  private readonly collections: CollectionManager<TEntity>;

  // Admin metadata configuration (set by installAdminMethods)
  private adminMeta: AdminServiceMeta | null = null;

  constructor(options: BaseServiceOptions) {
    this.serviceName = options.serviceName;
    this.hasEntryACL = options.hasEntryACL ?? false;
    this.defaultACL = options.defaultACL ?? [];
    this.logger =
      options.logger?.child({ service: this.serviceName }) ??
      consoleLogger.child({ service: this.serviceName });
    this.collections = new CollectionManager<TEntity>({
      serviceName: this.serviceName,
      getIo: () => this.io,
      logger: this.logger,
      defaultToItem: (entity) => this.toDto(entity),
    });
  }

  /**
   * Set the Prisma delegate for this service.
   * Must be called in the constructor of derived classes.
   */
  protected setDelegate(delegate: PrismaDelegate<TEntity, TCreateInput, TUpdateInput>): void {
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
        `Delegate not set for service ${this.serviceName}. Call setDelegate() in constructor.`,
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
   * Static counterpart: `serviceRoom(serviceName, entryId)` from the root export.
   */
  public getRoomName(entryId: string): string {
    return serviceRoom(this.serviceName, entryId);
  }

  /**
   * Subscribe a socket to an entity's updates.
   * Returns the current entity data (as the wire DTO, filtered for the
   * subscriber's tier) if access is granted, null otherwise.
   *
   * Joins the entity's Socket.io room; subscribers with elevated access
   * additionally join `{room}:full` so `emitUpdate` can address the two
   * tiers as rooms (adapter-safe). The tier is fixed here, at subscribe
   * time — an access change takes effect on re-subscribe.
   */
  public async subscribe(
    entryId: string,
    socket: QuickdrawSocket,
    requiredLevel: AccessLevel = "Read",
  ): Promise<Partial<TDto> | null> {
    if (!socket.userId) {
      return null;
    }

    // Check access
    const allowed = await this.checkSubscriptionAccess(
      socket.userId,
      entryId,
      requiredLevel,
      socket,
    );

    if (!allowed) {
      return null;
    }

    // Add to subscribers (admin introspection only)
    if (!this.subscribers.has(entryId)) {
      this.subscribers.set(entryId, new Set());
    }
    this.subscribers.get(entryId)!.add(socket);

    // Join Socket.io room(s) for room-based broadcasting
    const roomName = this.getRoomName(entryId);
    void socket.join(roomName);
    if (this.hasElevatedAccess(socket, entryId)) {
      void socket.join(serviceFullRoom(this.serviceName, entryId));
    }

    this.logger.debug(`User ${socket.userId} subscribed to ${entryId} (room: ${roomName})`);

    // Return current entity data, filtered based on subscriber's access level
    const entity = await this.findById(entryId);
    if (!entity) return null;

    return this.filterEntityForSubscriber(await this.toDto(entity), socket, entryId);
  }

  /**
   * Subscribe a socket to multiple entities at once.
   * Batches ACL checks and entity fetches for efficiency.
   * Override `checkBatchSubscriptionAccess` and `findByIds` in derived classes
   * for optimized batch queries (e.g., single findMany instead of N findUnique).
   *
   * Default implementation runs individual checks/fetches in parallel via Promise.all.
   */
  public async batchSubscribe(
    entryIds: string[],
    socket: QuickdrawSocket,
    requiredLevel: AccessLevel = "Read",
  ): Promise<Record<string, Partial<TDto> | null>> {
    if (!socket.userId || entryIds.length === 0) {
      return {};
    }

    const accessMap = await this.checkBatchSubscriptionAccess(
      socket.userId,
      entryIds,
      requiredLevel,
      socket,
    );

    const allowedIds = entryIds.filter((id) => accessMap.get(id) === true);

    const entities = allowedIds.length > 0 ? await this.findByIds(allowedIds) : [];

    const dtoMap = new Map<string, TDto>();
    for (const entity of entities) {
      dtoMap.set(entity.id, await this.toDto(entity));
    }

    // Join rooms for all ACL-allowed IDs, matching subscribe()'s behavior
    // of joining before entity resolution so clients receive future updates
    // even for entities that don't exist yet at subscription time.
    for (const entryId of allowedIds) {
      if (!this.subscribers.has(entryId)) {
        this.subscribers.set(entryId, new Set());
      }
      this.subscribers.get(entryId)!.add(socket);
      void socket.join(this.getRoomName(entryId));
      if (this.hasElevatedAccess(socket, entryId)) {
        void socket.join(serviceFullRoom(this.serviceName, entryId));
      }
    }

    const results: Record<string, Partial<TDto> | null> = {};

    for (const entryId of entryIds) {
      const dto = dtoMap.get(entryId);
      if (!dto || !accessMap.get(entryId)) {
        results[entryId] = null;
        continue;
      }

      results[entryId] = this.filterEntityForSubscriber(dto, socket, entryId);
    }

    this.logger.debug(
      `User ${socket.userId} batch-subscribed to ${allowedIds.length}/${entryIds.length} entities`,
    );

    return results;
  }

  /**
   * Batch ACL check for multiple entities.
   * Override in derived classes for efficient batch queries
   * (e.g., one findMany + one membership check per project instead of per entity).
   *
   * Default: checks each entity individually in parallel.
   */
  protected async checkBatchSubscriptionAccess(
    userId: string,
    entryIds: string[],
    requiredLevel: AccessLevel,
    socket: QuickdrawSocket,
  ): Promise<Map<string, boolean>> {
    const results = new Map<string, boolean>();
    await Promise.all(
      entryIds.map(async (id) => {
        const allowed = await this.checkSubscriptionAccess(userId, id, requiredLevel, socket);
        results.set(id, allowed);
      }),
    );
    return results;
  }

  /**
   * Batch entity fetch by IDs.
   * Override in derived classes for efficient batch queries
   * (e.g., one findMany with includes instead of N findUnique).
   *
   * Default: fetches each entity individually in parallel.
   */
  protected async findByIds(ids: string[]): Promise<TEntity[]> {
    const results = await Promise.all(ids.map((id) => this.findById(id)));
    return results.filter((e) => e !== null) as TEntity[];
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

    // Leave Socket.io rooms (base + elevated tier)
    void socket.leave(this.getRoomName(entryId));
    void socket.leave(serviceFullRoom(this.serviceName, entryId));
  }

  /**
   * Remove a socket from all subscriptions (called on disconnect).
   */
  public unsubscribeSocket(socket: QuickdrawSocket): void {
    for (const [entryId, sockets] of this.subscribers.entries()) {
      if (sockets.has(socket)) {
        sockets.delete(socket);
        // Leave Socket.io rooms
        void socket.leave(this.getRoomName(entryId));
        void socket.leave(serviceFullRoom(this.serviceName, entryId));
        if (sockets.size === 0) {
          this.subscribers.delete(entryId);
        }
      }
    }
  }

  /**
   * Emit a custom event to all subscribers of an entry via Socket.io rooms.
   * Useful for cross-service events (e.g., message service notifying chat subscribers).
   *
   * Can be called from external method composition files.
   *
   * @param roomName - The Socket.io room name (use getRoomName for service rooms)
   * @param eventName - The event name to emit
   * @param data - The data to emit
   *
   * Event names and payloads are typed via the augmentable
   * `QuickdrawEventMap` — with no augmentation this degrades to
   * `string`/`unknown` exactly as before.
   *
   * @example
   * ```typescript
   * // In MessageService, notify chat subscribers of a new message
   * this.emitToRoom(
   *   serviceRoom('chatService', message.chatId),
   *   'chat:message',
   *   messageDTO
   * );
   * ```
   */
  public emitToRoom<E extends QuickdrawEventName>(
    roomName: string,
    eventName: E,
    data: QuickdrawEventData<E & string>,
  ): void {
    if (!this.io) {
      this.logger.debug(
        `No io instance (service not registered); dropping ${eventName} to room ${roomName}`,
      );
      return;
    }
    this.io.to(roomName).emit(eventName, data);
    this.logger.debug(`Emitted ${eventName} to room ${roomName}`);
  }

  /**
   * Emit a custom event to a room using Socket.io's volatile flag.
   *
   * Volatile events are dropped for clients whose connection is backpressured
   * instead of being buffered — exactly what you want for high-frequency state
   * that is superseded by the next emit (game snapshots, cursor positions).
   * Never use this for events a client must not miss.
   *
   * Intentionally does no per-call logging: this is a hot path, typically
   * called at tick rate (10–60Hz).
   *
   * @example
   * ```typescript
   * // In a 20Hz game loop
   * this.emitToRoomVolatile(
   *   this.getRoomName(worldId),
   *   'game:snapshot',
   *   snapshot
   * );
   * ```
   */
  public emitToRoomVolatile<E extends QuickdrawEventName>(
    roomName: string,
    eventName: E,
    data: QuickdrawEventData<E & string>,
  ): void {
    if (!this.io) return;
    this.io.to(roomName).volatile.emit(eventName, data);
  }

  /**
   * Emit a custom event to a specific user's room.
   * Users join `user:{userId}` on connection (set up in auth middleware).
   * Useful for targeted notifications like permission changes or direct messages.
   *
   * Can be called from external method composition files.
   *
   * @example
   * ```typescript
   * this.emitToUserRoom(userId, "budget:shared", { budgetId, sharedBy });
   * ```
   */
  public emitToUserRoom<E extends QuickdrawEventName>(
    userId: string,
    eventName: E,
    data: QuickdrawEventData<E & string>,
  ): void {
    this.emitToRoom(userRoom(userId), eventName, data);
  }

  /**
   * Emit an update to all subscribers of an entity.
   *
   * Room-based and therefore Redis-adapter-safe: elevated subscribers (in
   * `{room}:full`, joined at subscribe time) receive the payload unfiltered;
   * everyone else in the entity room receives it with protected fields
   * stripped. Wire format and audience match the pre-4.0 per-socket path,
   * but updates now cross nodes.
   *
   * Can be called from external method composition files.
   */
  public emitUpdate(entryId: string, data: Partial<TDto>): void {
    if (!this.io) {
      this.logger.debug(`No io instance (service not registered); dropping update for ${entryId}`);
      return;
    }

    const eventName = `${this.serviceName}:update:${entryId}`;
    const room = this.getRoomName(entryId);
    const fullRoom = serviceFullRoom(this.serviceName, entryId);

    this.io.to(fullRoom).emit(eventName, data);
    this.io.to(room).except(fullRoom).emit(eventName, this.stripProtectedFields(data));
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
    socket: QuickdrawSocket,
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
  protected hasServiceAccess(socket: QuickdrawSocket, requiredLevel: AccessLevel): boolean {
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
    _socket: QuickdrawSocket,
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
    requiredLevel: AccessLevel,
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
   *
   * Can be called from external method composition files for custom access checks.
   */
  public isLevelSufficient(userLevel: AccessLevel, requiredLevel: AccessLevel): boolean {
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
    entryId?: string,
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
      if (this.hasEntryACL && (await this.checkEntryACL(socket.userId, entryId, requiredLevel))) {
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
  // DTO Mapping & Protected Fields Filtering
  // ===========================================================================

  /**
   * Map a raw row to the wire DTO. Default: identity.
   * May fetch (e.g. Prisma includes). Used by the CRUD trio's auto-emission,
   * by `subscribe`/`batchSubscribe` initial payloads, and as the default
   * `toItem` for collections.
   */
  protected toDto(entity: TEntity): TDto | Promise<TDto> {
    return entity as unknown as TDto;
  }

  /**
   * Get the list of fields that should be stripped for non-elevated subscribers.
   * Override in derived classes to customize which fields are protected.
   *
   * @example
   * ```typescript
   * protected override getProtectedFields(): (keyof UserDto)[] {
   *   return ['email', 'serviceAccess', 'discordId'];
   * }
   * ```
   */
  protected getProtectedFields(): (keyof TDto)[] {
    return ["email", "serviceAccess"] as (keyof TDto)[];
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
  protected hasElevatedAccess(socket: QuickdrawSocket, entryId: string): boolean {
    return socket.userId === entryId || this.hasServiceAccess(socket, "Admin");
  }

  /**
   * Strip protected fields from a DTO.
   * Used internally by filterEntityForSubscriber and emitUpdate.
   */
  protected stripProtectedFields<T extends Partial<TDto>>(entity: T): T {
    const protectedFields = this.getProtectedFields();
    const result = { ...entity };
    for (const field of protectedFields) {
      delete result[field as keyof T];
    }
    return result;
  }

  /**
   * Filter DTO data based on subscriber's access level.
   * Override for complex filtering logic (e.g., multiple tiers).
   *
   * Note: this shapes the *initial* subscribe payload only. Live emits are
   * two-tier by room (`emitUpdate`) — full for elevated subscribers,
   * protected-fields-stripped for everyone else.
   *
   * @example
   * ```typescript
   * protected override filterEntityForSubscriber(
   *   entity: Partial<UserDto>,
   *   socket: QuickdrawSocket,
   *   entryId: string
   * ): Partial<UserDto> {
   *   if (this.hasElevatedAccess(socket, entryId)) return entity;
   *   if (this.isFriend(socket.userId, entryId)) return this.stripForFriends(entity);
   *   return this.stripProtectedFields(entity);
   * }
   * ```
   */
  protected filterEntityForSubscriber(
    entity: Partial<TDto>,
    socket: QuickdrawSocket,
    entryId: string,
  ): Partial<TDto> {
    return this.hasElevatedAccess(socket, entryId) ? entity : this.stripProtectedFields(entity);
  }

  // ===========================================================================
  // Write Lifecycle Hooks
  // ===========================================================================
  // Overridable extension points around the CRUD trio — the home for
  // cross-cutting side effects (audit logging, denormalized counters, search
  // indexing) without overriding create/update/delete wholesale. Collections
  // are notified automatically between emit and the after* hook.
  //
  // Semantics: before* hooks may veto by throwing (nothing is written);
  // after* hooks run once the write has committed, so a throw propagates to
  // the caller but cannot undo the write.

  /** Transform or validate create input. Runs before the insert. */
  protected async beforeCreate(data: TCreateInput): Promise<TCreateInput> {
    return data;
  }

  /** Runs after a create has committed and been emitted. */
  protected async afterCreate(_entity: TEntity): Promise<void> {}

  /**
   * Transform or validate update input. `before` is the pre-write row when
   * the service has collections or overrides an update/delete hook
   * (otherwise null — the extra fetch is skipped).
   */
  protected async beforeUpdate(
    _id: string,
    data: TUpdateInput,
    _before: TEntity | null,
  ): Promise<TUpdateInput> {
    return data;
  }

  /** Runs after an update has committed and been emitted. */
  protected async afterUpdate(_before: TEntity | null, _after: TEntity): Promise<void> {}

  /** Runs before the delete. Throw to veto (delete() then returns false). */
  protected async beforeDelete(_before: TEntity): Promise<void> {}

  /** Runs after a delete has committed and been emitted. */
  protected async afterDelete(_before: TEntity): Promise<void> {}

  /**
   * Whether writes need the pre-write row: true when the service has
   * collections (scope diffing needs `before`) or overrides one of the
   * update/delete hooks that receive it.
   */
  private needsBeforeEntity(): boolean {
    if (this.collections.size > 0) return true;
    const base = BaseService.prototype as unknown as Record<string, unknown>;
    const self = this as unknown as Record<string, unknown>;
    return (
      self.beforeUpdate !== base.beforeUpdate ||
      self.afterUpdate !== base.afterUpdate ||
      self.beforeDelete !== base.beforeDelete ||
      self.afterDelete !== base.afterDelete
    );
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
   * Create an entity, emit to subscribers, and notify collections.
   */
  protected async create(data: TCreateInput): Promise<TEntity> {
    const prepared = await this.beforeCreate(data);
    const entity = await this.getDelegate().create({ data: prepared });
    this.emitUpdate(entity.id, await this.toDto(entity));
    await this.collections.notify({ type: "create", after: entity });
    await this.afterCreate(entity);
    this.logger.info(`Created entity ${entity.id}`);
    return entity;
  }

  /**
   * Update an entity, emit to subscribers, and notify collections.
   * Returns null when the write fails (e.g. the row does not exist).
   */
  protected async update(id: string, data: TUpdateInput): Promise<TEntity | null> {
    const before = this.needsBeforeEntity() ? await this.findById(id) : null;
    const prepared = await this.beforeUpdate(id, data, before);

    let entity: TEntity;
    try {
      entity = await this.getDelegate().update({
        where: { id } as { id: string },
        data: prepared,
      });
    } catch {
      return null;
    }

    this.emitUpdate(id, await this.toDto(entity));
    await this.collections.notify({ type: "update", before, after: entity });
    await this.afterUpdate(before, entity);
    this.logger.info(`Updated entity ${id}`);
    return entity;
  }

  /**
   * Delete an entity, emit the deletion event, and notify collections.
   * Returns false when the write fails or a beforeDelete hook throws.
   */
  protected async delete(id: string): Promise<boolean> {
    const before = this.needsBeforeEntity() ? await this.findById(id) : null;

    try {
      if (before) await this.beforeDelete(before);
      await this.getDelegate().delete({
        where: { id } as { id: string },
      });
    } catch {
      return false;
    }

    this.emitUpdate(id, { id, deleted: true } as unknown as Partial<TDto>);
    if (before) {
      await this.collections.notify({ type: "delete", before });
      await this.afterDelete(before);
    }
    this.logger.info(`Deleted entity ${id}`);
    return true;
  }

  // ===========================================================================
  // Public Method Definition
  // ===========================================================================

  /**
   * Define a public method that will be exposed via Socket.io.
   *
   * Can be called from external helper functions to split method definitions
   * across multiple files while keeping full type safety.
   *
   * @typeParam K - Method name from the service methods map
   */
  public defineMethod<K extends keyof TServiceMethods & string>(
    name: K,
    access: AccessLevel,
    handler: (
      payload: TServiceMethods[K]["payload"],
      context: ServiceMethodContext,
    ) => Promise<TServiceMethods[K]["response"]>,
    options?: {
      schema?: z.ZodType<TServiceMethods[K]["payload"]>;
      resolveEntryId?: (payload: TServiceMethods[K]["payload"]) => string | null;
    },
  ): ServiceMethodDefinition<TServiceMethods[K]["payload"], TServiceMethods[K]["response"]> {
    const definition: ServiceMethodDefinition<
      TServiceMethods[K]["payload"],
      TServiceMethods[K]["response"]
    > = {
      name,
      access,
      handler: handler as (
        payload: TServiceMethods[K]["payload"],
        context: ServiceMethodContext,
      ) => Promise<TServiceMethods[K]["response"]>,
      schema: options?.schema,
      resolveEntryId: options?.resolveEntryId,
    };

    this.publicMethods.set(name, definition as ServiceMethodDefinition<unknown, unknown>);
    return definition;
  }

  /**
   * Get all public methods for registry discovery.
   */
  public getPublicMethods(): ServiceMethodDefinition<unknown, unknown>[] {
    return Array.from(this.publicMethods.values());
  }

  // ===========================================================================
  // Channel Definition (high-frequency, fire-and-forget events)
  // ===========================================================================

  /**
   * Define a channel: a fire-and-forget event for high-frequency traffic
   * (game input, cursor positions, typing indicators).
   *
   * Channels differ from methods:
   * - No ack, no response — the handler returns void and errors are logged,
   *   never sent to the client.
   * - Exempt from the global rate limiter; each channel enforces its own
   *   per-socket token bucket (`ratePerSecond`/`burst`). Excess messages are
   *   silently dropped; sustained extreme abuse disconnects the socket.
   * - Access checks are fully synchronous and in-memory: authentication is
   *   always required; "Moderate"/"Admin" check the socket's serviceAccess;
   *   entry-level access is expressed via `requireRoom` (the socket must
   *   already be in that room, which was ACL-gated at subscribe time).
   * - `schema` is required — channel payloads are untrusted input arriving
   *   at tick rate.
   *
   * Routes as the Socket.io event `channel:<serviceName>:<name>`.
   *
   * @example
   * ```typescript
   * this.defineChannel(
   *   "input",
   *   "Read",
   *   (payload, ctx) => this.sim.applyInput(ctx.userId, payload),
   *   {
   *     schema: gameInputSchema,
   *     ratePerSecond: 30,
   *     requireRoom: () => this.getRoomName(GLOBAL_WORLD_ID),
   *   },
   * );
   * ```
   */
  public defineChannel<K extends keyof TChannels & string>(
    name: K,
    access: AccessLevel,
    handler: (payload: TChannels[K], context: ServiceChannelContext) => void,
    options: {
      schema: z.ZodType<TChannels[K]>;
      /** Sustained messages/second per socket. Default: 30 */
      ratePerSecond?: number;
      /** Bucket capacity for bursts. Default: 2 × ratePerSecond */
      burst?: number;
      /** Room the socket must already be in (null result skips the check). */
      requireRoom?: (payload: TChannels[K]) => string | null;
    },
  ): ServiceChannelDefinition<TChannels[K]> {
    const ratePerSecond = options.ratePerSecond ?? 30;
    const definition: ServiceChannelDefinition<TChannels[K]> = {
      name,
      access,
      handler,
      schema: options.schema,
      ratePerSecond,
      burst: options.burst ?? ratePerSecond * 2,
      requireRoom: options.requireRoom,
    };

    this.publicChannels.set(name, definition as ServiceChannelDefinition<unknown>);
    return definition;
  }

  /**
   * Get all channels for registry discovery.
   */
  public getPublicChannels(): ServiceChannelDefinition<unknown>[] {
    return Array.from(this.publicChannels.values());
  }

  /**
   * Synchronous, in-memory access check for a channel message.
   * Called by the registry on the hot path — must not touch the database.
   * Returns false to silently drop the message.
   */
  public checkChannelAccess(
    channel: ServiceChannelDefinition<unknown>,
    socket: QuickdrawSocket,
    payload: unknown,
  ): boolean {
    // Channels always require authentication, even at "Public" access —
    // fire-and-forget input from anonymous sockets is never useful and
    // would bypass the per-user accountability of the token bucket.
    if (!socket.userId) return false;

    // "Public"/"Read": any authenticated user passes the service gate
    // (mirrors ensureAccessForMethod's treatment of non-entry-scoped reads).
    // "Moderate"/"Admin": require that service-level access.
    if (
      channel.access !== "Public" &&
      channel.access !== "Read" &&
      !this.hasServiceAccess(socket, channel.access)
    ) {
      return false;
    }

    if (channel.requireRoom) {
      const roomName = channel.requireRoom(payload);
      if (roomName && !socket.rooms.has(roomName)) return false;
    }

    return true;
  }

  /**
   * Verify that all expected service methods have been defined via defineMethod().
   * Call at the end of initMethods() to catch missing implementations at boot time.
   *
   * @param expectedMethods - Array of method names that should have been defined
   * @throws Error if any expected methods are missing
   *
   * @example
   * ```typescript
   * private initMethods(): void {
   *   this.defineMethod("createChat", "Read", ...);
   *   this.defineMethod("deleteChat", "Admin", ...);
   *   this.verifyAllMethods(["createChat", "deleteChat"]);
   * }
   * ```
   */
  protected verifyAllMethods(expectedMethods: readonly (keyof TServiceMethods & string)[]): void {
    const missing: string[] = [];
    for (const method of expectedMethods) {
      if (!this.publicMethods.has(method)) {
        missing.push(method);
      }
    }
    if (missing.length > 0) {
      throw new Error(`${this.serviceName}: Missing method implementations: ${missing.join(", ")}`);
    }
  }

  // ===========================================================================
  // Collections (scope-keyed list subscriptions)
  // ===========================================================================

  /**
   * Declare a collection: rows of this service grouped by a scope id derived
   * from the row. Declared in the constructor next to defineMethod /
   * defineChannel; discovered by ServiceRegistry the same way.
   *
   * Once declared, the CRUD trio emits `added`/`updated`/`removed` deltas to
   * the scope rooms automatically — including scope moves (a row whose scope
   * changes is removed-from-old + added-to-new) and predicate entry/exit
   * (`resolveScopeId` returning null). Hand-rolled write paths use the
   * emitCollection* choke points instead.
   *
   * @example
   * ```typescript
   * type TaskCollections = { cardsByProject: { item: TaskCardDTO } };
   *
   * this.defineCollection("cardsByProject", {
   *   resolveScopeId: (task) => task.projectId,
   *   checkScopeAccess: (userId, projectId) => this.isProjectMember(userId, projectId),
   *   snapshot: (projectId, { cursor, limit }) => this.getCardPage(projectId, cursor, limit),
   *   toItem: (task) => this.buildCardDTO(task.id),
   * });
   * ```
   */
  protected defineCollection<K extends keyof TCollections & string>(
    name: K,
    config: CollectionDefinition<TEntity, TCollections[K]["item"]>,
  ): void {
    this.collections.define(name, config as CollectionDefinition<TEntity, { id: string }>);
  }

  /**
   * Get all collection definitions for registry discovery.
   */
  public getCollections(): Map<string, CollectionDefinition<TEntity, { id: string }>> {
    return this.collections.getAll();
  }

  /**
   * Handle a `{service}:collection:subscribe` (called by ServiceRegistry).
   * Cursor-less calls join the scope room and return the first page (with
   * `ids` when the snapshot provides them); cursor-bearing calls are pure
   * paging. Returns null on access denial or unknown collection.
   */
  public async subscribeCollection(
    payload: CollectionSubscribePayload,
    socket: QuickdrawSocket,
  ): Promise<CollectionSnapshotResponse<{ id: string }> | null> {
    return await this.collections.subscribe(payload, socket);
  }

  /**
   * Handle a `{service}:collection:unsubscribe` (called by ServiceRegistry).
   */
  public unsubscribeCollection(
    payload: CollectionUnsubscribePayload,
    socket: QuickdrawSocket,
  ): void {
    this.collections.unsubscribe(payload, socket);
  }

  /**
   * Notify all collections of a write this service performed outside the
   * CRUD trio, with full scope-move diffing. Prefer the emitCollection*
   * choke points when you already know the delta shape.
   */
  protected async notifyCollections(
    event:
      | { type: "create"; after: TEntity }
      | { type: "update"; before: TEntity | null; after: TEntity }
      | { type: "delete"; before: TEntity },
  ): Promise<void> {
    await this.collections.notify(event);
  }

  /**
   * Emit an `updated` delta for an item to a scope room (client upserts —
   * added-vs-updated is cosmetic). The choke point for hand-rolled write
   * paths that already hold the item DTO.
   *
   * Can be called from external method composition files.
   */
  public emitCollectionUpsert<K extends keyof TCollections & string>(
    collection: K,
    scopeId: string,
    item: TCollections[K]["item"],
  ): void {
    this.collections.emitUpsert(collection, scopeId, item);
  }

  /**
   * Emit a `removed` delta (id-only) to a scope room.
   *
   * Can be called from external method composition files.
   */
  public emitCollectionRemove<K extends keyof TCollections & string>(
    collection: K,
    scopeId: string,
    id: string,
  ): void {
    this.collections.emitRemove(collection, scopeId, id);
  }

  /**
   * Emit a scope move: `removed` from the old scope + `added` to the new.
   *
   * Can be called from external method composition files.
   */
  public emitCollectionMove<K extends keyof TCollections & string>(
    collection: K,
    fromScopeId: string,
    toScopeId: string,
    item: TCollections[K]["item"],
  ): void {
    this.collections.emitMove(collection, fromScopeId, toScopeId, item);
  }

  /**
   * Tell subscribers to re-snapshot the scope (debounced client-side) — the
   * honest fallback for bulk operations and mass reorders.
   *
   * Can be called from external method composition files.
   */
  public emitCollectionReset<K extends keyof TCollections & string>(
    collection: K,
    scopeId: string,
  ): void {
    this.collections.emitReset(collection, scopeId);
  }

  /**
   * Force sockets out of a collection scope room (adapter-safe ACL
   * revocation). With `userId`, only that user's sockets; without, everyone.
   * Promise-shaped for forward compatibility with adapters that resolve
   * membership asynchronously.
   */
  public kickFromCollection(collection: string, scopeId: string, userId?: string): Promise<void> {
    this.collections.kickFromCollection(collection, scopeId, userId);
    return Promise.resolve();
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
    const { expose, access, schema, displayName, tableColumns, hiddenFields, fieldOverrides } =
      options;

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
      expose.meta ?? (expose.list || expose.get || expose.create || expose.update || expose.delete);

    if (shouldExposeMeta) {
      this.publicMethods.set("adminMeta", {
        name: "adminMeta",
        access: access.meta ?? access.list,
        handler: async (
          _payload: unknown,
          _context: ServiceMethodContext,
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
          return await this.adminCreate((payload as { data: TCreateInput }).data);
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
        resolveEntryId: (payload: unknown) => (payload as { entryId: string }).entryId,
      } as ServiceMethodDefinition<unknown, unknown>);
    }

    if (expose.getSubscribers) {
      this.publicMethods.set("adminGetSubscribers", {
        name: "adminGetSubscribers",
        access: access.getSubscribers,
        handler: async (payload: unknown, _context: ServiceMethodContext) => {
          return this.adminGetSubscribers((payload as { entryId: string }).entryId);
        },
        resolveEntryId: (payload: unknown) => (payload as { entryId: string }).entryId,
      } as ServiceMethodDefinition<unknown, unknown>);
    }

    if (expose.reemit) {
      this.publicMethods.set("adminReemit", {
        name: "adminReemit",
        access: access.reemit,
        handler: async (payload: unknown, _context: ServiceMethodContext) => {
          return await this.adminReemit((payload as { entryId: string }).entryId);
        },
        resolveEntryId: (payload: unknown) => (payload as { entryId: string }).entryId,
      } as ServiceMethodDefinition<unknown, unknown>);
    }

    if (expose.unsubscribeAll) {
      this.publicMethods.set("adminUnsubscribeAll", {
        name: "adminUnsubscribeAll",
        access: access.unsubscribeAll,
        handler: async (payload: unknown, _context: ServiceMethodContext) => {
          return this.adminUnsubscribeAll((payload as { entryId: string }).entryId);
        },
        resolveEntryId: (payload: unknown) => (payload as { entryId: string }).entryId,
      } as ServiceMethodDefinition<unknown, unknown>);
    }

    const installedMethods = Object.keys(expose).filter((k) => expose[k as keyof typeof expose]);
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
        `Admin methods not installed for ${this.serviceName}. Call installAdminMethods() first.`,
      );
    }
    return this.adminMeta;
  }

  /**
   * Admin method: List entities with pagination and filters.
   */
  protected async adminList(payload: AdminListPayload): Promise<AdminListResponse<TEntity>> {
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
  protected async adminUpdate(id: string, data: TUpdateInput): Promise<TEntity | null> {
    return await this.update(id, data);
  }

  /**
   * Admin method: Delete an entity.
   */
  protected async adminDelete(id: string): Promise<{ success: boolean; id: string }> {
    const deleted = await this.delete(id);
    return { success: deleted, id };
  }

  /**
   * Admin method: Set entry-level ACL.
   */
  protected async adminSetEntryACL(payload: AdminSetACLPayload): Promise<TEntity | null> {
    const { entryId, acl } = payload;

    try {
      // Update the ACL field on the entity
      const entity = await this.getDelegate().update({
        where: { id: entryId } as { id: string },
        data: { acl } as unknown as TUpdateInput,
      });

      // Emit update to subscribers so they receive the new ACL
      this.emitUpdate(entryId, await this.toDto(entity));

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
    entryId: string,
  ): Promise<{ success: boolean; subscriberCount: number }> {
    const entity = await this.findById(entryId);
    if (!entity) {
      return { success: false, subscriberCount: 0 };
    }

    const subs = this.subscribers.get(entryId);
    const count = subs?.size ?? 0;

    this.emitUpdate(entryId, await this.toDto(entity));

    this.logger.info(`Re-emitted entity ${entryId} to ${count} subscribers`);
    return { success: true, subscriberCount: count };
  }

  /**
   * Admin method: Unsubscribe all sockets from an entity.
   * Room-based (adapter-safe): clears the entity's rooms across all nodes.
   * The reported count covers this node's introspection map only.
   */
  protected adminUnsubscribeAll(entryId: string): {
    success: boolean;
    unsubscribedCount: number;
  } {
    const subs = this.subscribers.get(entryId);
    const count = subs?.size ?? 0;

    const room = this.getRoomName(entryId);
    const fullRoom = serviceFullRoom(this.serviceName, entryId);

    // Notify subscribers they're being unsubscribed, then evict them from
    // the rooms cluster-wide so they stop receiving updates.
    this.emitToRoom(room, `${this.serviceName}:unsubscribed:${entryId}`, {
      reason: "admin_action",
    });
    this.io?.in(room).socketsLeave([room, fullRoom]);
    this.subscribers.delete(entryId);

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
