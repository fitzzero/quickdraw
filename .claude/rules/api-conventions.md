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
  ChatServiceMethods // Service method definitions map
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

Call `this.assertAllMethodsDefined()` after registering methods to catch
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
| `useServiceQuery` | Reads (`listX`, `getX`, `search`) — TanStack Query caching           |
| `useService`      | Writes/mutations (`createX`, `updateX`, `delete`) — `.mutate()` API  |
| `useSubscription` | Live entity data — auto-subscribes on mount, updates on server emits |
| `useRoomEvents`   | Raw room event streams                                               |

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
