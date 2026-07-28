---
paths:
  - "src/**/*"
---

# API Conventions

## BaseService Pattern

BaseService is the core server-side abstraction (`src/server/BaseService.ts`).

```typescript
class ChatService extends BaseService<
  Chat, // Prisma model type
  Prisma.ChatCreateInput, // Prisma create input type
  Prisma.ChatUpdateInput, // Prisma update input type
  ChatServiceMethods, // Service method definitions map
  ChatChannels, // Optional: channel payload map
  ChatDTO, // Optional: wire DTO (default TEntity) — override toDto()
  ChatCollections // Optional: collection map for defineCollection
> {
  constructor(prisma: PrismaClient) {
    super({
      serviceName: "chatService", // Socket event prefix
      hasEntryACL: true, // Enable entry-level access control
      defaultACL: [], // Optional default ACL for new entries
      logger: customLogger, // Optional (gets a child logger per service)
    });
    this.setDelegate(prisma.chat);
  }
}
```

Method-only services (no delegate, no CRUD, no subscriptions) extend
`BaseRpcService<TMethods, TChannels>` instead.

### Defining Public Methods

`defineMethod` exposes a method via Socket.IO (`serviceName:methodName`). It
returns the definition and is public, so helper functions in other files can
register methods on a service while keeping type safety.

```typescript
this.defineMethod(
  "createChat", // Key of TServiceMethods — payload/response inferred
  "Read", // AccessLevel
  async (payload, ctx) => {
    // ctx.userId, ctx.socketId, ctx.serviceAccess
    return { id: chat.id };
  },
  {
    schema: zodSchema, // Optional Zod payload validation
    resolveEntryId: (p) => p.id, // For entry-level ACL checks
  },
);
```

Call `this.verifyAllMethods([...])` after registering methods to catch
methods declared in `TServiceMethods` but never implemented. Use
`installAdminMethods()` to expose inherited admin CRUD (list/get/create/update/
delete/setEntryACL/…) with per-method access levels.

### Access Levels

`AccessLevel` (`src/shared/types.ts`): `"Public" | "Read" | "Moderate" | "Admin"`.

| Level      | Meaning                          |
| ---------- | -------------------------------- |
| `Public`   | No authentication required       |
| `Read`     | Authenticated users              |
| `Moderate` | Edit access                      |
| `Admin`    | Full access (delete, manage ACL) |

### CRUD Methods

Inherited protected methods that auto-emit `serviceName:update:{entryId}` to
subscribers: `this.create(data)`, `this.update(id, data)`, `this.delete(id)`
(emits `{ id, deleted: true }`), plus read-only `this.findById(id)`.

Emission is room-based and two-tier: elevated subscribers (in
`{room}:full`, joined at subscribe time) get the payload unfiltered,
everyone else gets `getProtectedFields()` stripped. Payloads are
`Partial<TDto>` via `toDto()`. The write lifecycle hooks
(`beforeCreate/afterCreate`, `beforeUpdate/afterUpdate`,
`beforeDelete/afterDelete`) are the extension points — don't override the
CRUD trio wholesale for side effects.

### Collections (Live Lists)

Declared in the constructor; see `src/server/collections.ts` and the README
"Collections" section:

```typescript
this.defineCollection("byChat", {
  resolveScopeId: (msg) => msg.chatId, // null = excluded; string[] = fan-out
  checkScopeAccess: (userId, chatId) => this.isChatMember(userId, chatId),
  snapshot: (chatId, { cursor, limit }) => this.getPage(chatId, cursor, limit),
  toItem: (msg) => this.toDto(msg), // default: toDto
});
```

The CRUD trio emits `added`/`updated`/`removed` deltas automatically (scope
moves included). Hand-rolled write paths use `emitCollectionUpsert/Remove/
Move/Reset`; `kickFromCollection` revokes adapter-safely. Items are
scope-visible (no per-subscriber tiering) — strip sensitive fields in
`toItem`/`snapshot`. Never hand-emit `*:created/deleted/updated/reordered`
room events (lint: `quickdraw/no-manual-collection-events`).

## ServiceRegistry

Auto-wires services to Socket.IO (`src/server/ServiceRegistry.ts`):

```typescript
const registry = new ServiceRegistry(io);
registry.registerService("chatService", chatService);
// Creates events: chatService:subscribe, chatService:unsubscribe, chatService:<method>
```

## Client Hooks

| Hook              | Use for                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `useServiceQuery` | Query-shaped reads (`search`, aggregates) — TanStack Query caching   |
| `useService`      | Writes/mutations (`createX`, `updateX`, `delete`) — `.mutate()` API  |
| `useSubscription` | Live single entity — auto-subscribes on mount, updates on emits      |
| `useCollection`   | Live lists of a scope — deltas, `loadMore` paging, reconnect healing |
| `useRoomEvents`   | Custom ephemeral room events (typing, presence)                      |

```typescript
const createChat = useService("chatService", "createChat", {
  onSuccess: (data) => {},
  onError: (error) => {},
});
createChat.mutate({ title: "New Chat" });

const { data, isLoading, error } = useSubscription<Chat>("chatService", chatId);
```

## End-to-End Type Safety

Service methods are declared once as a `{ payload, response }` map and shared
between client and server:

```typescript
type ChatServiceMethods = {
  createChat: {
    payload: { title: string };
    response: { id: string };
  };
};
```
