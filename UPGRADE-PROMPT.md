# Upgrade to quickdraw-core 4.0.0

Paste this file to a coding agent (or follow it yourself) to migrate an app
from quickdraw-core 3.x to 4.0.

```bash
bun update @fitzzero/quickdraw-core   # or pnpm update
# then set "@fitzzero/quickdraw-core": "^4.0.0" in package.json
```

4.0 is the collection-subscriptions major (see `docs/rfcs/0001` + `0002` in
the repo). Most 3.x services compile unchanged; the breaking changes below
are mechanical. Work through Part 1 first — the app should build and behave
identically — then adopt collections (Part 2) list by list.

---

## Part 1 — Breaking changes (do these first)

### 1.1 `emitUpdate` now takes the wire DTO (`Partial<TDto>`)

`BaseService` has two new trailing generics:

```typescript
BaseService<TEntity, TCreateInput, TUpdateInput, TMethods, TChannels, TDto, TCollections>;
```

`TDto` defaults to `TEntity`, so services whose wire shape IS the row need
nothing. Services that emit a mapped DTO (includes, computed fields) should:

1. Pass the DTO type as the 6th generic.
2. Override `toDto(entity): TDto | Promise<TDto>` (used by the CRUD trio's
   auto-emission, `subscribe`/`batchSubscribe` payloads, and collections).
3. Delete the casts — `emitUpdate(id, dto as unknown as Partial<Task>)`
   becomes `emitUpdate(id, dto)`.

`getProtectedFields` / `stripProtectedFields` / `filterEntityForSubscriber`
now speak `TDto` — if you override them with `TEntity`-typed signatures,
retype them.

### 1.2 Per-socket emission fallback is gone; services must be registered

`emitUpdate`, `emitToRoom`, and `emitToRoomVolatile` now require the Socket.io
server instance (set automatically by `ServiceRegistry.registerService` /
`createQuickdrawServer`). If you unit-test services without a registry and
expect emits to reach sockets, use `createTestServer` from
`@fitzzero/quickdraw-core/server/testing` — emission without `io` is a
debug-logged no-op.

Why: `emitUpdate` used to iterate an in-process socket map, so entity updates
**never crossed nodes** under the Redis adapter. It is now room-based:
elevated subscribers join `{service}:{id}:full` at subscribe time and get the
unfiltered payload; everyone else in `{service}:{id}` gets protected fields
stripped.

Consequences to check:

- **Tier is fixed at subscribe time.** A user whose `serviceAccess` or
  ownership changes gets the new tier on their next subscribe (e.g. after
  reconnect), not mid-subscription. If you revoke access, force a
  re-subscribe or disconnect the socket.
- Live emits have exactly two tiers (full / stripped). A custom
  `filterEntityForSubscriber` with more tiers still shapes the _initial_
  subscribe payload, but live updates are two-tier — put extra tiers in
  separate scopes or DTOs if they matter live.
- `subscribe`/`batchSubscribe` return `Partial<TDto> | null` (filtered DTOs)
  instead of `TEntity`.

### 1.3 Admin types: one canonical shape each

If you imported admin types from the package root, the aspirational
duplicates are gone; the canonical shapes (what the server actually sends)
now live in both the root and `/server` exports:

| 3.x (root export)                                        | 4.0 canonical                                         |
| -------------------------------------------------------- | ----------------------------------------------------- |
| `AdminListPayload {page, pageSize, sort, filter}`        | `{page?, pageSize?, where?, orderBy?}`                |
| `AdminListResponse {rows, page, pageSize, total}`        | `{items, total, page, pageSize, totalPages}`          |
| `AdminSetEntryACLPayload {id, acl}`                      | `AdminSetACLPayload {entryId, acl}`                   |
| `AdminGetSubscribersPayload {id}`                        | `{entryId}`; response `{entryId, subscribers, count}` |
| `AdminReemitPayload {id}` / `{emitted}`                  | `{entryId}` / `{success, subscriberCount}`            |
| `AdminUnsubscribeAllPayload {id}` / `{id, unsubscribed}` | `{entryId}` / `{success, unsubscribedCount}`          |

Admin UIs built against the _server's actual behavior_ need no runtime
changes — only imports/type names. UIs built against the old root types were
already wrong at runtime.

### 1.4 Write lifecycle hooks may change your override strategy

If you overrode `create`/`update`/`delete` wholesale just to add side
effects, replace the override with the new hooks:

```typescript
protected override async beforeCreate(data: TCreateInput): Promise<TCreateInput> { ... }
protected override async afterCreate(entity: TEntity): Promise<void> { ... }
protected override async beforeUpdate(id, data, before: TEntity | null): Promise<TUpdateInput> { ... }
protected override async afterUpdate(before: TEntity | null, after: TEntity): Promise<void> { ... }
protected override async beforeDelete(before: TEntity): Promise<void> { ... }  // throw to veto
protected override async afterDelete(before: TEntity): Promise<void> { ... }
```

Note: when a service has collections or overrides an update/delete hook, the
CRUD trio fetches the pre-write row (one extra `findUnique` per write).
Services that already hold the row can keep their hand-rolled write paths and
use the collection choke points (§2.3) instead.

### 1.5 Auth: structured identity (optional but recommended)

`authenticate` may still return a `string` userId — that keeps working. New
capabilities:

```typescript
auth: {
  authenticate: async (socket, auth) => ({
    userId,                          // optional — non-user principals allowed
    principalType: "user",           // e.g. "taskToken", "runner"
    claims: { taskId },              // stamped onto socket.claims
    serviceAccess: { chatService: "Admin" },  // optional — else loadServiceAccess runs
  }),
  loadServiceAccess: async (userId) => user.serviceAccess,  // fixes the {} TODO
}
```

The server now emits `auth:info` (`{ userId, serviceAccess, principalType }`)
— `useQuickdrawSocket().userId/serviceAccess` finally populate — and joins
authenticated sockets to `user:{userId}`, so `emitToUserRoom` works without
app-side middleware. Delete any hand-rolled user-room joins (idempotent, but
dead code now).

### 1.6 Client context additions

`QuickdrawSocketContextValue` gained `isRateLimited` / `reportRateLimited`.
If you build mock contexts in tests, add them (or use
`createMockSocketContext` from `/client/testing`, which has them).

`QuickdrawProvider` now invalidates all TanStack queries on reconnect by
default (plain `useServiceQuery` reads were keeping stale data — room events
emitted during an outage are gone for good). Pass
`reconnectBehavior="none"` to opt out. If you had a hand-rolled
reconnect-resync hook, delete it.

### 1.7 Method-only services: extend `BaseRpcService`

Replace `BaseService<never, never, never, TMethods>` declarations:

```typescript
class CloudBuildService extends BaseRpcService<CloudBuildMethods> { ... }
```

---

## Part 2 — Adopt collections (the point of 4.0)

Each hand-maintained live list — `*:created`/`*:deleted` room events, an
`invalidateOn` refetch, a `deleteAndBroadcast` helper, a merge-by-id reducer
— collapses into one server declaration plus one client hook.

### 2.1 Declare the collection

```typescript
type TaskCollections = { cardsByProject: { item: TaskCardDTO } };

class TaskService extends BaseService<
  Task,
  Prisma.TaskCreateInput,
  Prisma.TaskUpdateInput,
  TaskMethods,
  TaskChannels,
  TaskDTO,
  TaskCollections
> {
  constructor(prisma: PrismaClient) {
    super({ serviceName: "taskService" });
    this.setDelegate(prisma.task);

    this.defineCollection("cardsByProject", {
      // Which scope(s) a row belongs to; null = not in the collection;
      // string[] fans out (e.g. a chat in every member's "myChats").
      resolveScopeId: (task) => task.projectId,
      // ACL, checked once at subscribe time. Scope-visible: whoever passes
      // sees every item in full — strip sensitive fields in toItem/snapshot.
      checkScopeAccess: (userId, projectId) => this.isProjectMember(userId, projectId),
      // First page + reconnect re-snapshot. Server-ordered. Return `ids`
      // (full membership, ids only) so reconnecting clients prune deletions;
      // omit for unbounded scopes like chat history.
      snapshot: (projectId, { cursor, limit }) => this.getCardPage(projectId, cursor, limit),
      // Row -> item DTO for automatic deltas. Default: the service's toDto.
      toItem: (task) => this.buildCardDTO(task.id),
    });
  }
}
```

`this.create/update/delete` now emit the right `added`/`updated`/`removed`
deltas automatically — including scope moves and predicate entry/exit.

### 2.2 Consume with `useCollection`

```tsx
const { items, isLoading, hasMore, loadMore } = useCollection<TaskCardDTO>(
  "taskService",
  "cardsByProject",
  projectId,
  { compare: (a, b) => a.rank.localeCompare(b.rank) },
);
```

Delete, per list: the `useRoomEvents` mirror handlers, the `invalidateOn`
option, the manual merge state, and any reconnect-refetch effect —
`useCollection` handles live deltas, pagination (`loadMore` reuses the
subscribe event with a cursor), reconnect re-snapshot, and deletion pruning.

### 2.3 Hand-rolled write paths: one-line choke points

Where you bypass the CRUD trio (include-rich updates, bulk ops):

```typescript
this.emitCollectionUpsert("cardsByProject", dto.projectId, toCard(dto)); // upsert one row
this.emitCollectionRemove("cardsByProject", projectId, taskId);
this.emitCollectionMove("cardsByProject", fromProjectId, toProjectId, toCard(dto));
this.emitCollectionReset("cardsByProject", projectId); // bulk ops — clients re-snapshot (debounced)
await this.kickFromCollection("cardsByProject", projectId, userId); // ACL revocation, adapter-safe
```

Reorders: ordering is data — put a sortable field on the item and a reorder
is one `updated` delta; the framework deliberately has no `reordered` delta.
For side-structure ordering, `emitCollectionReset` degrades to exactly the
`invalidateOn` behavior you had.

### 2.4 Migration order that works (per the RFC)

1. Simple parent-scoped CRUD lists (tags, checklists, …) — each deletes an
   event triple + client merge.
2. Chat-style unbounded histories (`ids` omitted; `compare` + `loadMore`).
3. The big board/table views last (highest value, most custom code).
4. Then flip `quickdraw/no-manual-collection-events` from warn to error —
   it flags any `emitToRoom` still ending in `:created/:deleted/:updated/:reordered`.

## Part 3 — Update agent context files

In `CLAUDE.md` / `.claude/rules/` of your app:

- Document `defineCollection`/`useCollection` as THE pattern for live lists;
  mark `invalidateOn` + mirror room events as legacy for row lists.
- The method-verification helper is `verifyAllMethods([...])` — some 3.x
  docs referenced a nonexistent `assertAllMethodsDefined()`.
- Note the two-tier emit model and subscribe-time ACL tier.
- Note `BaseRpcService` for method-only services, and the `*ServiceCore` +
  method-modules pattern for splitting large services (see README
  "Splitting large services").
