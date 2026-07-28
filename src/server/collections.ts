import type { Server as SocketIOServer } from "socket.io";
import type {
  CollectionDelta,
  CollectionSnapshotPage,
  CollectionSnapshotResponse,
  CollectionSubscribePayload,
  CollectionUnsubscribePayload,
  Logger,
} from "../shared/types";
import { collectionEventName, collectionRoom, userRoom } from "../shared/types";
import type { QuickdrawSocket } from "./types";

/** Default snapshot page size when neither the request nor the definition sets one. */
const DEFAULT_PAGE_LIMIT = 100;
/** Hard clamp on requested page sizes. */
const MAX_PAGE_LIMIT = 500;
/** Above this many ids, `ids` is dropped from the response (`idsTruncated: true`). */
const MAX_IDS = 5_000;

/**
 * A scope-keyed collection of a service's rows.
 *
 * A collection is "rows of this service, grouped by a scope id derived from
 * the row" (`task.projectId`, `message.chatId`, `chatMember.userId`).
 * Membership is a pure function of the row — that is what makes automatic
 * add/remove/update emission, room-based multi-node fanout, and one-line ACL
 * zero-thought.
 *
 * **ACL model (deliberate simplification):** a collection item is
 * *scope-visible* — anyone who passes `checkScopeAccess` sees every item in
 * full. There is no per-subscriber field tiering inside a collection; if a
 * field is sensitive, strip it in `toItem`/`snapshot`. If visibility varies
 * per user within a scope, that is not a collection — model it as separate
 * scopes or per-entity subscriptions.
 */
export interface CollectionDefinition<TEntity, TItem extends { id: string }> {
  /**
   * Which scope(s) a row belongs to. `null` = not in this collection
   * (static predicate filtering). An array supports fan-out scopes
   * (e.g. a chat appearing in every member's "myChats").
   */
  resolveScopeId: (
    entity: TEntity,
  ) => string | string[] | null | Promise<string | string[] | null>;

  /** ACL for joining the scope room. Runs once at subscribe time. */
  checkScopeAccess: (
    userId: string,
    scopeId: string,
    socket: QuickdrawSocket,
  ) => boolean | Promise<boolean>;

  /** Initial page + re-snapshot query. Server-ordered. */
  snapshot: (
    scopeId: string,
    opts: { cursor: string | null; limit: number; userId: string },
  ) => Promise<CollectionSnapshotPage<TItem>>;

  /**
   * Row -> collection item DTO for automatic delta emission.
   * May be async (fetch with includes). Default: the service's `toDto`.
   */
  toItem?: (entity: TEntity) => TItem | Promise<TItem>;

  /** Default page size for snapshot requests. Default 100, max clamp 500. */
  defaultLimit?: number;

  /**
   * Revision source for `added`/`updated` deltas, instead of `Date.now()`
   * at emit. Must return epoch-milliseconds-comparable numbers (e.g. the
   * row's `updatedAt`). Use when multi-node clock skew bites.
   */
  revOf?: (item: TItem) => number;
}

/**
 * A write observed by the CRUD trio, fed to {@link CollectionManager.notify}
 * for automatic delta emission.
 */
export type CollectionWriteEvent<TEntity> =
  | { type: "create"; after: TEntity }
  | { type: "update"; before: TEntity | null; after: TEntity }
  | { type: "delete"; before: TEntity };

interface CollectionManagerOptions<TEntity> {
  serviceName: string;
  getIo: () => SocketIOServer | null;
  logger: Logger;
  /** Fallback item mapper when a definition has no `toItem` (the service's `toDto`). */
  defaultToItem: (entity: TEntity) => { id: string } | Promise<{ id: string }>;
}

/**
 * Per-service collection state and emission logic: holds definitions, serves
 * snapshot subscriptions, and turns write events into scope-room deltas.
 *
 * All emission is room-based (`io.to(room).emit`) — Redis-adapter-safe by
 * construction. No collection state lives in any in-process subscriber map.
 */
export class CollectionManager<TEntity extends { id: string }> {
  private readonly definitions = new Map<string, CollectionDefinition<TEntity, { id: string }>>();
  private readonly serviceName: string;
  private readonly getIo: () => SocketIOServer | null;
  private readonly logger: Logger;
  private readonly defaultToItem: (entity: TEntity) => { id: string } | Promise<{ id: string }>;

  constructor(options: CollectionManagerOptions<TEntity>) {
    this.serviceName = options.serviceName;
    this.getIo = options.getIo;
    this.logger = options.logger;
    this.defaultToItem = options.defaultToItem;
  }

  public define(name: string, config: CollectionDefinition<TEntity, { id: string }>): void {
    if (this.definitions.has(name)) {
      throw new Error(`${this.serviceName}: collection "${name}" is already defined`);
    }
    this.definitions.set(name, config);
  }

  public getAll(): Map<string, CollectionDefinition<TEntity, { id: string }>> {
    return this.definitions;
  }

  public get size(): number {
    return this.definitions.size;
  }

  // ===========================================================================
  // Wire operations (called by BaseService on behalf of the registry)
  // ===========================================================================

  /**
   * Handle a `{service}:collection:subscribe`.
   *
   * Cursor-less: ACL check, join the scope room, snapshot with `ids`.
   * Cursor-bearing: pure paging — ACL check, no room join, `ids` stripped
   * (pruning against a partial page would drop valid cached rows).
   *
   * Returns `null` on access denial or unknown collection (indistinguishable
   * to the client, mirroring entity subscribe semantics).
   */
  public async subscribe(
    payload: CollectionSubscribePayload,
    socket: QuickdrawSocket,
  ): Promise<CollectionSnapshotResponse<{ id: string }> | null> {
    const definition = this.definitions.get(payload.collection);
    if (!definition) {
      this.logger.debug(`Unknown collection ${this.serviceName}:${payload.collection}`);
      return null;
    }
    if (!socket.userId) return null;

    const allowed = await definition.checkScopeAccess(socket.userId, payload.scopeId, socket);
    if (!allowed) return null;

    const cursor = payload.cursor ?? null;
    if (cursor === null) {
      void socket.join(collectionRoom(this.serviceName, payload.collection, payload.scopeId));
    }

    // Captured before the query runs: deltas emitted while the query is in
    // flight carry a later rev and win the client-side merge.
    const rev = Date.now();
    const limit = Math.min(
      Math.max(payload.limit ?? definition.defaultLimit ?? DEFAULT_PAGE_LIMIT, 1),
      MAX_PAGE_LIMIT,
    );
    const page = await definition.snapshot(payload.scopeId, {
      cursor,
      limit,
      userId: socket.userId,
    });

    const response: CollectionSnapshotResponse<{ id: string }> = { ...page, rev };
    if (cursor !== null) {
      delete response.ids;
      delete response.idsTruncated;
    } else if (response.ids && response.ids.length > MAX_IDS) {
      delete response.ids;
      response.idsTruncated = true;
    }
    return response;
  }

  /** Handle a `{service}:collection:unsubscribe` — leave the scope room. */
  public unsubscribe(payload: CollectionUnsubscribePayload, socket: QuickdrawSocket): void {
    void socket.leave(collectionRoom(this.serviceName, payload.collection, payload.scopeId));
  }

  // ===========================================================================
  // Automatic emission (the single choke point for the CRUD trio)
  // ===========================================================================

  /**
   * Turn a write event into deltas for every collection on the service.
   *
   * - create: `added` to each scope of `after`.
   * - update: diff scopes of `before` vs `after` — in both → `updated`,
   *   `after` only → `added`, `before` only → `removed`. Scope moves and
   *   predicate entry/exit fall out for free.
   * - delete: `removed` to each scope of `before`.
   *
   * Errors in app-provided callbacks are logged, never thrown — the write
   * has already committed; emission failures must not fail the response.
   */
  public async notify(event: CollectionWriteEvent<TEntity>): Promise<void> {
    if (this.definitions.size === 0) return;

    for (const [name, definition] of this.definitions) {
      try {
        await this.notifyOne(name, definition, event);
      } catch (error) {
        this.logger.error(`Collection emission failed for ${this.serviceName}:${name}`, {
          eventType: event.type,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private async notifyOne(
    name: string,
    definition: CollectionDefinition<TEntity, { id: string }>,
    event: CollectionWriteEvent<TEntity>,
  ): Promise<void> {
    switch (event.type) {
      case "create": {
        const scopes = normalizeScopes(await definition.resolveScopeId(event.after));
        if (scopes.length === 0) return;
        const item = await this.toItem(definition, event.after);
        const rev = this.revFor(definition, item);
        for (const scopeId of scopes) {
          this.emitDelta(name, scopeId, { type: "added", item, rev });
        }
        return;
      }
      case "update": {
        const beforeScopes = event.before
          ? normalizeScopes(await definition.resolveScopeId(event.before))
          : [];
        const afterScopes = normalizeScopes(await definition.resolveScopeId(event.after));
        const beforeSet = new Set(beforeScopes);
        const afterSet = new Set(afterScopes);

        const removed = beforeScopes.filter((s) => !afterSet.has(s));
        const entered = afterScopes.filter((s) => !beforeSet.has(s));
        const stayed = afterScopes.filter((s) => beforeSet.has(s));

        if (entered.length > 0 || stayed.length > 0) {
          const item = await this.toItem(definition, event.after);
          const rev = this.revFor(definition, item);
          for (const scopeId of stayed) {
            this.emitDelta(name, scopeId, { type: "updated", item, rev });
          }
          for (const scopeId of entered) {
            this.emitDelta(name, scopeId, { type: "added", item, rev });
          }
        }
        for (const scopeId of removed) {
          this.emitDelta(name, scopeId, { type: "removed", id: event.after.id, rev: Date.now() });
        }
        return;
      }
      case "delete": {
        const scopes = normalizeScopes(await definition.resolveScopeId(event.before));
        for (const scopeId of scopes) {
          this.emitDelta(name, scopeId, { type: "removed", id: event.before.id, rev: Date.now() });
        }
        return;
      }
    }
  }

  // ===========================================================================
  // Manual choke points (for hand-rolled write paths)
  // ===========================================================================

  /** Emit `updated` (client upserts; added-vs-updated is cosmetic). */
  public emitUpsert(collection: string, scopeId: string, item: { id: string }): void {
    const definition = this.definitions.get(collection);
    const rev = definition ? this.revFor(definition, item) : Date.now();
    this.emitDelta(collection, scopeId, { type: "updated", item, rev });
  }

  public emitRemove(collection: string, scopeId: string, id: string): void {
    this.emitDelta(collection, scopeId, { type: "removed", id, rev: Date.now() });
  }

  /** A move is removed-from-old + added-to-new. */
  public emitMove(
    collection: string,
    fromScopeId: string,
    toScopeId: string,
    item: { id: string },
  ): void {
    const definition = this.definitions.get(collection);
    const rev = definition ? this.revFor(definition, item) : Date.now();
    this.emitDelta(collection, fromScopeId, { type: "removed", id: item.id, rev });
    this.emitDelta(collection, toScopeId, { type: "added", item, rev });
  }

  /** Clients re-snapshot (debounced) — for bulk ops and mass reorders. */
  public emitReset(collection: string, scopeId: string): void {
    this.emitDelta(collection, scopeId, { type: "reset", rev: Date.now() });
  }

  /**
   * Force sockets out of a scope room — ACL revocation that works across
   * nodes (`socketsLeave` is adapter-safe). With `userId`, only that user's
   * sockets are kicked; without, the whole room is cleared.
   */
  public async kickFromCollection(
    collection: string,
    scopeId: string,
    userId?: string,
  ): Promise<void> {
    const io = this.getIo();
    if (!io) {
      this.logger.debug(`No io instance; cannot kick from ${this.serviceName}:${collection}`);
      return;
    }
    const room = collectionRoom(this.serviceName, collection, scopeId);
    io.in(userId ? userRoom(userId) : room).socketsLeave(room);
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private async toItem(
    definition: CollectionDefinition<TEntity, { id: string }>,
    entity: TEntity,
  ): Promise<{ id: string }> {
    return definition.toItem ? await definition.toItem(entity) : await this.defaultToItem(entity);
  }

  private revFor(
    definition: CollectionDefinition<TEntity, { id: string }>,
    item: { id: string },
  ): number {
    return definition.revOf?.(item) ?? Date.now();
  }

  private emitDelta(
    collection: string,
    scopeId: string,
    delta: CollectionDelta<{ id: string }>,
  ): void {
    const io = this.getIo();
    if (!io) {
      this.logger.debug(
        `No io instance; dropping ${delta.type} delta for ${this.serviceName}:${collection}:${scopeId}`,
      );
      return;
    }
    const room = collectionRoom(this.serviceName, collection, scopeId);
    io.to(room).emit(collectionEventName(this.serviceName, collection, scopeId), delta);
  }
}

/** Normalize a resolveScopeId result to a deduped scope-id list. */
function normalizeScopes(scopes: string | string[] | null): string[] {
  if (scopes === null) return [];
  if (typeof scopes === "string") return [scopes];
  return [...new Set(scopes)];
}
