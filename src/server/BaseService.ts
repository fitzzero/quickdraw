import type { z } from "zod";
import type {
  AccessLevel,
  ServiceMethodDefinition,
  ServiceMethodContext,
  Logger,
  ACL,
} from "../shared/types";
import { consoleLogger } from "../shared/types";
import type {
  QuickdrawSocket,
  BaseServiceOptions,
  InstallAdminMethodsOptions,
  PrismaDelegate,
} from "./types";

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
  > = Record<string, { payload: unknown; response: unknown }>,
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

  // Collection of public methods for registry discovery
  private readonly publicMethods: Map<
    string,
    ServiceMethodDefinition<unknown, unknown>
  > = new Map();

  constructor(options: BaseServiceOptions) {
    this.serviceName = options.serviceName;
    this.hasEntryACL = options.hasEntryACL ?? false;
    this.defaultACL = options.defaultACL ?? [];
    this.logger = options.logger?.child({ service: this.serviceName }) ??
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
   * Subscribe a socket to an entity's updates.
   * Returns the current entity data if access is granted, null otherwise.
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

    this.logger.debug(`User ${socket.userId} subscribed to ${entryId}`);

    // Return current entity data
    const entity = await this.findById(entryId);
    return entity;
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
  }

  /**
   * Remove a socket from all subscriptions (called on disconnect).
   */
  public unsubscribeSocket(socket: QuickdrawSocket): void {
    for (const [entryId, sockets] of this.subscribers.entries()) {
      if (sockets.has(socket)) {
        sockets.delete(socket);
        if (sockets.size === 0) {
          this.subscribers.delete(entryId);
        }
      }
    }
  }

  /**
   * Emit an update to all subscribers of an entity.
   */
  protected emitUpdate(entryId: string, data: Partial<TEntity>): void {
    const eventName = `${this.serviceName}:update:${entryId}`;
    const subs = this.subscribers.get(entryId);

    if (subs) {
      for (const socket of subs) {
        socket.emit(eventName, data);
      }
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
      resolveEntryId?: (payload: TServiceMethods[K]["payload"]) => string | null;
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
  // Admin Methods (Scaffolding)
  // ===========================================================================

  /**
   * Install standard admin CRUD methods.
   * Call this in derived class constructor to expose admin endpoints.
   */
  protected installAdminMethods(_options: InstallAdminMethodsOptions): void {
    // Implementation will be added in base-service-rewrite todo
    // This is a placeholder to establish the API
    this.logger.debug("Admin methods installation placeholder");
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
