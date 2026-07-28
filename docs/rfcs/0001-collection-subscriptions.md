# RFC 0001: First-class Collection Subscriptions

- **Status:** Draft
- **Target:** `@fitzzero/quickdraw-core` **4.0.0**
- **Downstream:** Conveyor (reference migration), quickdraw-chat (demo vehicle)
- **Source:** 2026-07-27 three-repo alignment audit (quickdraw-core 3.9.1, quickdraw-chat 3.7.0, Conveyor @ ^3.9.1)

## 0. Thesis and scope stance

quickdraw has a great *entity* subscription primitive and nothing for *lists*. Every app rebuilds the same four-layer compensation stack: mirrored room events → hand-typed event map → `invalidateOn` refetch → reconnect/polling backstops. In Conveyor this shows up as ~60 hand-typed `*:created/deleted/reordered` events (of ~90 total in a 317-line `SocketEventMap`), 152 `emitToRoom` call sites, a `deleteAndBroadcast` helper, `emitTaskUpdate`'s dual-emit, and a 582-line `useBoardData` maintaining three parallel caches. All of it is one missing primitive.

**Core decision: the primitive is a scope-keyed collection, not a live query.** A collection is declared once per service as "rows of this service, grouped by a scope id derived from the row" (`task.projectId`, `message.chatId`, `chatMember.userId`). Membership is a pure function of the row. That covers ~80% of real list UIs, is explainable to a coding agent in one sentence, and is the only shape for which automatic add/remove/update emission, room-based multi-node fanout, and one-line ACL can all be made zero-thought. Arbitrary live `findMany` filters are explicitly out (§8).

**Second decision: no event log, no sequence-gap replay.** Reconnect correctness comes from re-snapshot (the same code path as initial load), plus an optional full id-list in the snapshot for precise pruning, plus per-item last-writer-wins revisions. This collapses the "room events emitted while the socket was down are gone for good" problem (Conveyor `useReconnectResync.ts:11-15`) into a mechanism that already has to exist, instead of a durable per-scope journal in Redis.

**Versioning:** 4.0 is approved, so this ships as a breaking major. We do NOT keep the legacy per-socket `emitUpdate` fallback as a parallel public path, we place the new generics cleanly, and we fold in the type dedupe fixes (RFC 0002 §4) rather than contorting for 3.x source compat. Migration from 3.9 is mechanical (see §7).

---

## 1. Server API surface

### 1.1 New generics on BaseService

```ts
export abstract class BaseService<
  TEntity extends { id: string },
  TCreateInput extends Record<string, unknown>,
  TUpdateInput extends Record<string, unknown>,
  TServiceMethods extends ... = Record<string, { payload: unknown; response: unknown }>,
  TChannels extends ... = Record<string, unknown>,
  TDto extends { id: string } = TEntity,          // NEW — wire shape
  TCollections extends {                           // NEW — collection map
    [K in keyof TCollections]: { item: { id: string } };
  } = Record<string, { item: { id: string } }>,
>
```

- `TDto` defaults to `TEntity`, so simple services compile unchanged.
- `emitUpdate(entryId: string, data: Partial<TDto>): void` — kills Conveyor's `dto as unknown as Partial<Task>` cast at every emit site (`apps/api/src/services/task/service-core.ts:256-260`).
- New overridable mapper, used by auto-emission and by `subscribe()`'s initial payload:

```ts
/** Map a raw row to the wire DTO. Default: identity. May fetch (e.g. Prisma includes). */
protected toDto(entity: TEntity): TDto | Promise<TDto> {
  return entity as unknown as TDto;
}
```

`filterEntityForSubscriber` / `getProtectedFields` retype from `TEntity` to `TDto`.

### 1.2 `defineCollection`

Declared in the constructor next to `defineMethod`/`defineChannel`; discovered by ServiceRegistry the same way.

```ts
// src/server/collections.ts (new file — keeps BaseService.ts from growing past ~1500 LOC)

export interface CollectionSnapshotPage<TItem> {
  items: TItem[];
  nextCursor: string | null;
  totalCount: number;
  /**
   * Full membership id list for the scope (ids only, cheap select).
   * Returned on cursor-less (first-page / re-snapshot) requests so clients can
   * prune rows deleted while disconnected. Omit for unbounded scopes.
   */
  ids?: string[];
}

export interface CollectionDefinition<TEntity, TItem extends { id: string }> {
  /**
   * Which scope(s) a row belongs to. `null` = not in this collection
   * (static predicate filtering). An array supports fan-out scopes
   * (e.g. a chat appearing in every member's "myChats").
   */
  resolveScopeId: (entity: TEntity) => string | string[] | null | Promise<string | string[] | null>;

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
}
```

```ts
// On BaseService:
protected defineCollection<K extends keyof TCollections & string>(
  name: K,
  config: CollectionDefinition<TEntity, TCollections[K]["item"]>,
): void;

public getCollections(): Map<string, CollectionDefinition<TEntity, { id: string }>>; // registry discovery
```

**ACL model (deliberate simplification):** a collection item is *scope-visible* — anyone who passes `checkScopeAccess` sees every item in full. There is no per-subscriber field tiering inside a collection in v1; if a field is sensitive, strip it in `toItem`/`snapshot`. This is what makes room-based (adapter-safe) emission trivially correct, and it matches Conveyor's existing reality (full `TaskCardDTO`s already broadcast unfiltered to the project room). If visibility varies per user within a scope, that is not a collection — model it as separate scopes or per-entity subscriptions. Document this rule loudly.

Example — Conveyor's board, replacing the whole `emitTaskUpdate`/`task:created`/`deleteAndBroadcast` stack:

```ts
type TaskCollections = { cardsByProject: { item: TaskCardDTO } };

this.defineCollection("cardsByProject", {
  resolveScopeId: (task) => task.projectId,
  checkScopeAccess: (userId, projectId) => this.isProjectMember(userId, projectId, "Read"),
  snapshot: (projectId, { cursor, limit }) => this.getCardPage(projectId, cursor, limit),
  toItem: (task) => this.buildCardDTO(task.id), // fetch with includes
});
```

### 1.3 Automatic emission via write lifecycle hooks

Add the (long-missing) lifecycle hooks — collections are their first consumer:

```ts
protected async beforeCreate(data: TCreateInput): Promise<TCreateInput> { return data; }
protected async afterCreate(entity: TEntity): Promise<void> {}
protected async beforeUpdate(id: string, data: TUpdateInput, before: TEntity | null): Promise<TUpdateInput> { return data; }
protected async afterUpdate(before: TEntity | null, after: TEntity): Promise<void> {}
protected async beforeDelete(before: TEntity): Promise<void> {}
protected async afterDelete(before: TEntity): Promise<void> {}
```

Rework the CRUD trio (`before` is only fetched when the service has collections or overrides a hook — one extra `findUnique` per write; it also finally makes `delete()` able to notify parents):

```
create(data):
  data = beforeCreate(data)
  entity = delegate.create({data})
  emitUpdate(entity.id, await toDto(entity))           // unchanged event, now DTO-shaped
  notifyCollections({ type: "create", after: entity })  // NEW
  afterCreate(entity)

update(id, data):
  before = (needsBefore) ? findById(id) : null
  data = beforeUpdate(id, data, before)
  entity = delegate.update(...)
  emitUpdate(id, await toDto(entity))
  notifyCollections({ type: "update", before, after: entity })
  afterUpdate(before, entity)

delete(id):
  before = findById(id)
  delegate.delete(...)
  emitUpdate(id, { id, deleted: true })
  notifyCollections({ type: "delete", before })
  afterDelete(before)
```

`notifyCollections` is the single choke point (private, in `collections.ts`):

- **create:** for each collection, `scopes = resolveScopeId(after)`; emit `added` with `await toItem(after)` to each scope room.
- **update:** compute `beforeScopes` and `afterScopes`. In both → `updated`. In `after` only → `added`. In `before` only → `removed` (id-only payload). **Rows moving between scopes (task changes `projectId`) and predicate entry/exit (`resolveScopeId` goes null→scope) fall out for free — a "move" is removed-from-old + added-to-new.**
- **delete:** `removed` to each `beforeScopes` room.

Note: *within* Conveyor's board, a status-column move is **not** a scope move — scope is `projectId`; status is an item field, so a column move is a plain `updated` delta and the client re-buckets. Deliberate: scoping the collection at the coarsest stable parent keeps deltas cheap and moves free.

### 1.4 Manual emission choke points (for hand-rolled write paths)

Real apps bypass `BaseService.update` for include-rich writes (Conveyor's `updateFields`, `applyStatusChange`). The same primitives are public so those paths stay one-liners:

```ts
public emitCollectionUpsert<K extends keyof TCollections & string>(
  collection: K, scopeId: string, item: TCollections[K]["item"],
): void;                     // emits `updated` (client upserts; added-vs-updated is cosmetic)

public emitCollectionRemove<K extends keyof TCollections & string>(
  collection: K, scopeId: string, id: string,
): void;

public emitCollectionMove<K extends keyof TCollections & string>(
  collection: K, fromScopeId: string, toScopeId: string, item: TCollections[K]["item"],
): void;                     // removed(from) + added(to)

public emitCollectionReset<K extends keyof TCollections & string>(
  collection: K, scopeId: string,
): void;                     // client re-snapshots (debounced) — bulk ops, mass reorders

public async kickFromCollection(collection: string, scopeId: string, userId?: string): Promise<void>;
  // io.in(userId ? `user:${userId}` : room).socketsLeave(room) — adapter-safe revocation
```

Conveyor's `emitTaskUpdate` becomes:

```ts
emitTaskUpdate(id: string, dto: TaskDTO): void {
  this.emitUpdate(id, dto);                                   // TDto generic — no cast
  this.emitCollectionUpsert("cardsByProject", dto.projectId, toCardFromTaskDTO(dto));
}
```

### 1.5 Reorders

**Ordering is data.** The blessed pattern is a sortable field on the item (fractional rank / `boardRank`); a reorder is then one `updated` delta for the moved row and the client's `compare` re-sorts. For bulk reorders or side-structure ordering (Conveyor's per-status `taskIds` arrays today), `emitCollectionReset` is the honest fallback — it degrades to exactly the `invalidateOn` refetch behavior apps already have, minus the hand-wired event names. The framework does **not** grow a `reordered` delta type; two ordering mechanisms in the wire protocol is how protocols rot.

---

## 2. Wire protocol

All auto-registered by ServiceRegistry per service, mirroring the existing naming scheme.

**Client → server (with ack):**

| Event | Payload | Ack data |
|---|---|---|
| `{service}:collection:subscribe` | `{ collection, scopeId, cursor?: string \| null, limit?: number }` | `CollectionSnapshotPage<TItem> & { rev: number }` |
| `{service}:collection:unsubscribe` | `{ collection, scopeId }` | `{ unsubscribed: true }` |

Subscribe joins room `{service}:collection:{collection}:{scopeId}` (entity ids are cuids, so no collision with `{service}:{entryId}` rooms), then runs `snapshot()`. **Paging reuses the same event with a cursor** — a cursor-bearing call skips the room join and just returns a page; no separate "load more" method. `ids` is only computed on cursor-less calls.

**Server → client** — one event name per scope room, `{service}:collection:{collection}:{scopeId}`:

```ts
export type CollectionDelta<TItem extends { id: string }> =
  | { type: "added";   item: TItem; rev: number }
  | { type: "updated"; item: TItem; rev: number }   // full item, never partial — merge is trivial and idempotent
  | { type: "removed"; id: string;  rev: number }
  | { type: "reset";   rev: number };
```

**Revisions instead of sequence numbers.** `rev = Date.now()` at emit; snapshot carries `rev` captured before its query runs. Semantics: per-item last-writer-wins — a client ignores an `added`/`updated` whose `rev` is older than what it holds for that id, and snapshot items only overwrite cached items whose rev predates the snapshot rev. This handles cross-node interleaving through the Redis adapter (each delta carries the full item, so LWW per item is safe) and the delta-races-snapshot window, with no coordinated counter. There is deliberately **no gap detection**: within a connection socket.io preserves per-emitter order; across a disconnect the client re-snapshots, so a gap can never persist. Millisecond clock skew between nodes is bounded by the same-item write path (DB) being serialized anyway; document the assumption. Optional `revOf: (item) => number` config (e.g. row `updatedAt`) if skew bites.

**Reconnect contract:** on reconnect the client re-issues `collection:subscribe` (cursor-less). The response's `ids` (when present) is the authoritative membership: cached items not in `ids` are pruned — this precisely heals deletions missed during the outage, the one case merge-only strategies (Conveyor's `mergeMessages`) can't fix. When `ids` is omitted (unbounded scopes like long chat histories), pruning is skipped and the merge keeps paged-in history — exactly `mergeMessages` semantics, now in the framework.

The entire per-entity protocol (`subscribe`/`batchSubscribe`/`unsubscribe`/`{service}:update:{id}`) is untouched.

---

## 3. Client: `useCollection`

New `src/client/useCollection.ts`:

```ts
export interface UseCollectionOptions<TItem> {
  enabled?: boolean;
  limit?: number;                           // page size, default from server
  compare?: (a: TItem, b: TItem) => number; // client ordering; omit = server snapshot order
  insertPosition?: "start" | "end";         // where `added` lands when no compare; default "end"
  onDelta?: (delta: CollectionDelta<TItem>) => void;
  onError?: (error: string) => void;
}

export interface UseCollectionResult<TItem> {
  items: TItem[];               // ordered, deduped
  byId: ReadonlyMap<string, TItem>;
  totalCount: number | null;
  isLoading: boolean;
  isError: boolean;
  error: string | null;
  hasMore: boolean;
  isLoadingMore: boolean;
  loadMore: () => Promise<void>;
  refresh: () => Promise<void>; // manual re-snapshot (also what `reset` deltas trigger, debounced 100ms)
}

export function useCollection<TItem extends { id: string }>(
  serviceName: string,
  collection: string,
  scopeId: string | null,
  options?: UseCollectionOptions<TItem>,
): UseCollectionResult<TItem>;
```

**TanStack cache shape** — key `[serviceName, "collection", collection, scopeId]`, value:

```ts
interface CollectionCacheEntry<TItem> {
  byId: Record<string, TItem>;
  order: string[];              // insertion/server order; render order applies `compare` on top
  revById: Record<string, number>;
  nextCursor: string | null;
  totalCount: number | null;
  snapshotRev: number;
}
```

**Merge semantics** (a pure, unit-testable module `src/client/collectionCache.ts` — the correctness heart):

- *Snapshot (cursor-less):* prune ids absent from `ids` when provided; upsert page items unless `revById[id] > snapshot.rev` (a live delta raced ahead — the live push wins, generalizing `mergeMessages`' "existing entries win on id collision"); reset `nextCursor`/`totalCount`.
- *Page (cursored):* upsert-only, append unseen ids in server order; never prune. Live deltas and paged history compose because everything is id-keyed — the venetian/mergeMessages problem solved once.
- *Deltas:* `added`/`updated` upsert with rev check (insert per `insertPosition` when new); `removed` deletes and decrements `totalCount`; `reset` schedules a debounced re-snapshot. Deltas arriving while a snapshot is in flight are buffered and applied on top of the snapshot result.

**Lifecycle:** reuses the existing ref-counted `subscriptionRegistry` with key `{service}:collection:{name}:{scopeId}` — same provider, no new machinery: dedupe across components, cleanup on last release, and the existing disconnect→`registry.clear()`→effect-rerun cycle gives re-snapshot-on-reconnect for free (making a global reconnect-resync unnecessary for collections). The batchSubscribe microtask batcher is *not* used in v1 — pages typically mount one or two collections; batching snapshots complicates the ack shape for no measured win.

**Interplay with existing hooks:** `useSubscription` stays the tool for detail panels (full entity, field-tiered); `useCollection` for lists (scope-visible items). They own separate caches by design — mirroring collection items into subscription caches is rejected (hidden coupling, double render paths). `invalidateOn` remains for genuinely query-shaped reads and becomes progressively unnecessary. Also fix while in the neighborhood: `useServiceQuery` passes through `refetchInterval`/`refetchIntervalInBackground` to `useQuery` (currently silently ignored — see RFC 0002 §2).

---

## 4. Multi-node correctness

- **All collection traffic is room-based** (`io.to(room).emit`) — Redis-adapter-safe by construction. No collection state lives in the in-process `subscribers` Map.
- **Fix `emitUpdate`'s multi-node bug in the same release** rather than shipping a second, correct emission path next to a broken one. Today `emitUpdate` iterates the local `subscribers` Map and calls `socket.emit` directly, so entity updates never cross nodes even with the Redis adapter. Mechanism: at subscribe time (where tier is already effectively decided), elevated subscribers additionally join `{service}:{entryId}:full`:

```ts
public emitUpdate(entryId: string, data: Partial<TDto>): void {
  const room = this.getRoomName(entryId);
  const fullRoom = `${room}:full`;
  this.io.to(fullRoom).emit(eventName, data);
  this.io.to(room).except(fullRoom).emit(eventName, this.stripProtectedFields(data));
}
```

`io.to(A).except(B)` is adapter-supported in socket.io v4. Wire format and audience are unchanged. **4.0 breaking note:** the per-socket fallback path is removed (tests use a real io instance via `createTestServer`); tier is now fixed at subscribe time instead of evaluated per emit — a `serviceAccess` change takes effect on re-subscribe. The `subscribers` Map is retained only for admin introspection (`adminGetSubscribers`).
- `kickFromCollection` uses `io.in(...).socketsLeave(room)` (adapter-safe) for ACL revocation.

---

## 5. Typed event maps (rides along; details in RFC 0002 §3)

Collection events need no entries in any event map — they are framework-generated and typed end-to-end by `TCollections` server-side and the `useCollection<TItem>` parameter client-side (apps are encouraged to export a thin typed wrapper per service). Custom room events get the augmentable `QuickdrawEventMap` + static `serviceRoom`/`collectionRoom`/`userRoom` helpers per RFC 0002.

---

## 6. File-level change list (quickdraw-core)

| File | Change |
|---|---|
| `src/server/collections.ts` | **New.** `CollectionDefinition`, `CollectionSnapshotPage`, `CollectionManager` (per-service: definitions, `notifyCollections`, delta/room emission, snapshot dispatch, access check). ~250 LOC. |
| `src/server/BaseService.ts` | Add `TDto`/`TCollections` generics, `toDto`, lifecycle hooks, CRUD rework (§1.3), `defineCollection`/`getCollections` delegating to CollectionManager, manual emit choke points, room-based `emitUpdate` + `:full` room join in `subscribe`/`batchSubscribe`, typed `emitToRoom`. |
| `src/server/ServiceRegistry.ts` | Register `{service}:collection:subscribe` / `:unsubscribe` listeners (validate payload, dispatch to service); extend `BaseServiceInstance` in `src/server/types.ts`. |
| `src/shared/types.ts` | `CollectionDelta`, `CollectionSubscribePayload`, snapshot types, `QuickdrawEventMap`, `serviceRoom`/`collectionRoom`/`userRoom`, `collectionEventName()`. Dedupe `AdminListResponse`/`AdminSetACLPayload` (breaking; RFC 0002 §4). |
| `src/client/collectionCache.ts` | **New.** Pure merge module (snapshot/page/delta application, rev LWW, prune, buffer). Exhaustively unit-tested. |
| `src/client/useCollection.ts` | **New.** Hook per §3, using provider registry + collectionCache. |
| `src/client/useServiceQuery.ts` | Pass through `refetchInterval` / `refetchIntervalInBackground`. |
| `src/client/useRoomEvents.ts` | Typed via `QuickdrawEventMap` (degrading generics). |
| `src/client/types.ts`, `src/client/index.ts`, `src/server/index.ts`, `src/shared/index.ts` | Export new types/hook. |
| Tests | `src/server/collections.test.ts` (auto-emission incl. scope moves + predicate entry/exit, ACL, multi-scope fan-out, reset), `src/client/collectionCache.test.ts`, `src/client/useCollection.test.tsx` (reconnect re-snapshot, delta-during-snapshot buffering, pagination merge), extend `batchSubscribe` tests for `:full` rooms. |
| `eslint-plugin-quickdraw` | New rule `quickdraw/no-manual-collection-events`: flag `emitToRoom` calls whose event name matches `/:(created|deleted|updated|reordered)$/` with "declare a collection instead" (warn-level; consumers flip to error post-migration). |

---

## 7. Phased rollout & migration

**Phase 1 — 4.0.0-rc.1 (foundations):** lifecycle hooks, `TDto` + `toDto`, typed `QuickdrawEventMap`, room helpers, room-based `emitUpdate`, `refetchInterval` passthrough, admin type dedupe. Conveyor consumes rc.1 immediately to delete the `as unknown as Partial<Task>` casts and its `room-helpers.ts` — a confidence canary for the emitUpdate room refactor under real multi-pod load.

**Phase 2 — 4.0.0-rc.2 (collections):** server manager + registry wiring + wire protocol + `useCollection` + tests.

**Phase 3 — quickdraw-chat as the demo (proves both scope shapes):**
- `chatService.defineCollection("myChats", { resolveScopeId: (chat) => memberUserIds(chat), checkScopeAccess: (userId, scopeId) => userId === scopeId, snapshot: recentChatsPage })` — scope = *user id*, demonstrating that scopes aren't only parent entities and exercising the `string[]` fan-out. `ChatList`/`ChatSidebar` drop `staleTime: 0` + manual `onRefresh` for `useCollection("chatService", "myChats", user.id)`.
- `messageService.defineCollection("byChat", ...)` with `ids` omitted (unbounded history); `ChatWindow` drops its hand-rolled `useRoomEvents` + `useState` merge for `useCollection` with `compare: byCreatedAt` and `loadMore`. This becomes the template README's headline example.

**Phase 4 — Conveyor incremental adoption (risk/reward order):**
1. **Simple project-scoped CRUD lists first** (tags, story points, priorities, objectives, checklists, repo refs, suggestion/incident lists): each replaces a `created/updated/deleted` event triple + `deleteAndBroadcast` call + client `invalidateOn` with one `defineCollection` + one `useCollection`. `deleteAndBroadcast` is deleted outright — `BaseService.delete` now fetches `before` and notifies collections natively. `checkScopeAccess` is one shared helper wrapping the existing `projectMember` lookup. ~35–40 of the ~60 compensation events die here.
2. **Chat messages** → `byChat` collection; deletes `chat:message`/`chat:message:updated`/`chat:message:deleted` and `mergeMessages` (typing indicators stay custom room events — correctly, they're ephemeral, not rows).
3. **The board** (highest value, do last): `taskService.defineCollection("cardsByProject", ...)` with `TaskCardDTO` items; `emitTaskUpdate` collapses per §1.4; the ~8 `task:*` mirror emit sites become the automatic path or one-line choke-point calls; cross-project moves become `emitCollectionMove`. Client: `useBoardData`'s `columns`/`extraTasks` + patch helpers replaced by one `useCollection` bucketed by status in a `useMemo`; the venetian section cache remains custom *paging* but sources row changes from collection deltas. Adopt `reset` for `task:reordered` initially; consider a `boardRank` field as a follow-up to make reorders delta-shaped.
4. Cleanup: `socket-events.ts` shrinks to genuinely custom events (presence, typing, agent/deployment streams); flip `no-manual-collection-events` to error; retire polling backstops one at a time; `useReconnectResync` stays (still covers plain `useServiceQuery` reads) but shrinks in blast radius.

---

## 8. What NOT to build (and why)

- **Arbitrary live query subscriptions** (`subscribeQuery(where, orderBy)`): requires re-evaluating predicates per write per subscriber (or a query-invalidation matrix) — the classic real-time tarpit (Meteor oplog tailing, Hasura live queries). Scope-keyed collections + client-side filtering of scope-visible items is the 80% win with O(1) emit cost. Server-side filters stay as snapshot parameters; do not put filter params in the room key.
- **Per-subscriber field tiers inside collections** — breaks single-room emission; the scope-visible rule is the primitive's simplicity guarantee.
- **Durable event logs / seq replay / offline catch-up** — re-snapshot + `ids` pruning is strictly simpler and already required for first load.
- **A `reordered` delta type** — ordering is data (§1.5).
- **Optimistic mutation integration in `useCollection`** — apps can `setQueryData` on the collection key; a blessed helper can come later.
- **Collection batching in the subscribe batcher, cross-service collections, aggregate/count-only subscriptions** — deferred until a real consumer exists.

## 9. Risks / open questions

1. **`before`-fetch cost on `update`/`delete`** — one extra `findUnique` per write when collections/hooks exist. Mitigation: services already holding the row use the manual choke points.
2. **Clock skew on `rev`** across nodes: LWW per item assumes ~ms-honest clocks; optional `revOf: (item) => number` (e.g. row `updatedAt`) if it bites.
3. **`ids` cap** for huge scopes — clamp (suggest 5,000) and omit above it, degrading to no-prune merges; surface as `idsTruncated: true`.
4. **Board filters + collections** (Phase 4.3): keep filtered views on query+delta-hints initially; validate against `useBoardData`'s "mine"/"on-hold" modes before committing to full replacement.
