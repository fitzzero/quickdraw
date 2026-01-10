# @fitzzero/quickdraw-core

Fast fullstack patterns for real-time applications with Socket.io and TanStack Query.

## Features

- **Server Core**: BaseService class with typed CRUD, ACL-based access control, and real-time subscriptions
- **Client Core**: TanStack Query integration with Socket.io for real-time state management
- **Socket Inputs**: Pre-built form components that sync with server state
- **Custom OAuth**: JWT-based authentication with Discord and Google providers
- **Type Safety**: End-to-end TypeScript support with shared type definitions

## Installation

```bash
pnpm add @fitzzero/quickdraw-core
```

## Quick Start

### Server Setup

```typescript
import { createQuickdrawServer, BaseService } from '@fitzzero/quickdraw-core/server';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// Define your service
class ChatService extends BaseService<Chat, Prisma.ChatCreateInput, Prisma.ChatUpdateInput, ChatServiceMethods> {
  constructor() {
    super({ serviceName: 'chatService', hasEntryACL: true });
    this.setDelegate(prisma.chat);
    
    // Define public methods
    this.createChat = this.defineMethod('createChat', 'Read', async (payload, ctx) => {
      const chat = await this.create({ title: payload.title, ownerId: ctx.userId });
      return { id: chat.id };
    });
  }
  
  createChat: ReturnType<typeof this.defineMethod<'createChat'>>;
}

// Start server
const { io, httpServer } = createQuickdrawServer({
  port: 4000,
  cors: { origin: 'http://localhost:3000' },
  services: {
    chatService: new ChatService(),
  },
  auth: {
    authenticate: async (socket, auth) => {
      const payload = await verifyJWT(auth.token, process.env.JWT_SECRET);
      return payload?.userId;
    },
  },
});
```

### Client Setup

```tsx
// app/layout.tsx
import { QuickdrawProvider } from '@fitzzero/quickdraw-core/client';

export default function RootLayout({ children }) {
  return (
    <QuickdrawProvider
      serverUrl="http://localhost:4000"
      authToken={getAuthToken()}
    >
      {children}
    </QuickdrawProvider>
  );
}

// app/chat/page.tsx
import { useService, useSubscription } from '@fitzzero/quickdraw-core/client';

function ChatPage({ chatId }: { chatId: string }) {
  // Subscribe to real-time updates
  const { data: chat, isLoading } = useSubscription('chatService', chatId);
  
  // Mutation hook
  const updateTitle = useService('chatService', 'updateTitle', {
    onSuccess: () => console.log('Title updated!'),
  });
  
  if (isLoading) return <div>Loading...</div>;
  
  return (
    <div>
      <h1>{chat?.title}</h1>
      <button onClick={() => updateTitle.mutate({ id: chatId, title: 'New Title' })}>
        Update Title
      </button>
    </div>
  );
}
```

### Socket Inputs

```tsx
import { SocketTextField } from '@fitzzero/quickdraw-core/client';

function ChatTitleEditor({ chat, updateChat }) {
  return (
    <SocketTextField
      state={chat}
      update={(patch) => updateChat.mutateAsync({ id: chat.id, ...patch })}
      property="title"
      commitMode="debounce"
      debounceMs={500}
      placeholder="Chat title..."
    />
  );
}
```

## Package Exports

```typescript
// Shared types (both server and client)
import { ServiceResponse, AccessLevel, ServiceMethodMap } from '@fitzzero/quickdraw-core';

// Server
import { 
  BaseService, 
  ServiceRegistry, 
  createQuickdrawServer,
  createJWT,
  verifyJWT,
  discordProvider,
  googleProvider,
} from '@fitzzero/quickdraw-core/server';

// Server testing
import { createTestServer, connectAsUser, emitWithAck } from '@fitzzero/quickdraw-core/server/testing';

// Client
import {
  QuickdrawProvider,
  useQuickdrawSocket,
  useService,
  useSubscription,
  SocketCheckbox,
  SocketTextField,
  SocketSelect,
  SocketSlider,
  SocketSwitch,
} from '@fitzzero/quickdraw-core/client';

// Client testing
import { createMockSocket, createTestWrapper } from '@fitzzero/quickdraw-core/client/testing';
```

## Local Development

This package is developed alongside [quickdraw-chat](https://github.com/fitzzero/quickdraw-chat), a reference implementation.

### Using pnpm link

```bash
# In quickdraw-chat, the package is linked:
"@fitzzero/quickdraw-core": "link:../../../quickdraw"

# Changes to quickdraw-core are instantly available after rebuild
pnpm build  # or pnpm dev for watch mode
```

## Type Definitions

Define your service methods in a shared types file:

```typescript
// shared/types.ts
import type { ServiceMethodMap } from '@fitzzero/quickdraw-core';

export type ChatServiceMethods = ServiceMethodMap<{
  createChat: {
    payload: { title: string };
    response: { id: string };
  };
  updateTitle: {
    payload: { id: string; title: string };
    response: { id: string; title: string };
  };
  inviteUser: {
    payload: { id: string; userId: string; level: 'Read' | 'Moderate' | 'Admin' };
    response: { id: string };
  };
}>;
```

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Client (React)                          │
├─────────────────────────────────────────────────────────────────┤
│  QuickdrawProvider                                              │
│  ├── TanStack QueryClient                                       │
│  └── Socket.io Connection                                       │
│                                                                 │
│  useService() ──────────────────────────────────────────────┐   │
│  useSubscription() ─────────────────────────────────────────┤   │
│  SocketTextField, SocketCheckbox, ... ──────────────────────┤   │
│                                                             │   │
└─────────────────────────────────────────────────────────────│───┘
                                                              │
                        Socket.io Events                      │
                                                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                         Server (Node.js)                        │
├─────────────────────────────────────────────────────────────────┤
│  createQuickdrawServer()                                        │
│  └── ServiceRegistry                                            │
│      ├── Auto-discovers public methods                          │
│      └── Wires methods to Socket.io events                      │
│                                                                 │
│  BaseService<Entity, CreateInput, UpdateInput, ServiceMethods>  │
│  ├── defineMethod() - Type-safe method definition               │
│  ├── subscribe() / unsubscribe() - Real-time subscriptions      │
│  ├── create() / update() / delete() - CRUD with auto-emit       │
│  └── checkAccess() - ACL enforcement                            │
│                                                                 │
│  Auth Utilities                                                 │
│  ├── createJWT() / verifyJWT()                                  │
│  └── OAuth providers (Discord, Google)                          │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

## Access Control

Quickdraw provides flexible ACL with two complementary levels:

### Service-level ACL

Blanket permissions across all entries in a service. Stored in `user.serviceAccess`:

```typescript
// User model must satisfy QuickdrawUser interface
interface QuickdrawUser {
  id: string;
  serviceAccess?: Record<string, AccessLevel> | null;
}

// Example: Admin access to all chats
user.serviceAccess = { chatService: "Admin", userService: "Read" };
```

### Entry-level ACL

Per-entity permissions. Quickdraw supports two patterns:

#### Pattern 1: JSON ACL (Simple)

Store ACL directly on the entity. Best for:
- Simple ownership models (owner + collaborators)
- When you don't need to query "all entities user X can access" efficiently
- Minimal schema complexity

```typescript
// Entity must satisfy ACLEntity interface
interface ACLEntity {
  id: string;
  acl?: ACL | null;  // ACL = Array<{ userId: string; level: AccessLevel }>
}

// Prisma schema
model Document {
  id    String @id @default(cuid())
  acl   Json?  // Stores [{ userId: "...", level: "Read" }]
}

// Service - uses default checkEntryACL (no override needed)
class DocumentService extends BaseService<Document, ...> {
  constructor(prisma: PrismaClient) {
    super({ serviceName: "documentService", hasEntryACL: true });
    this.setDelegate(prisma.document);
  }
}
```

#### Pattern 2: Membership Table (Complex)

Separate table for memberships. Best for:
- Querying "all entities user X can access" efficiently
- Complex role hierarchies
- Additional membership metadata (join date, invited by, etc.)

```typescript
// Prisma schema
model Chat {
  id      String       @id
  members ChatMember[]
}

model ChatMember {
  chatId String
  userId String
  level  String  // "Read" | "Moderate" | "Admin"
  
  @@unique([chatId, userId])
}

// Service - override checkEntryACL to use membership table
class ChatService extends BaseService<Chat, ...> {
  protected override async checkEntryACL(
    userId: string,
    chatId: string,
    requiredLevel: AccessLevel
  ): Promise<boolean> {
    const member = await this.prisma.chatMember.findUnique({
      where: { chatId_userId: { chatId, userId } },
    });
    if (!member) return false;
    return this.isLevelSufficient(member.level as AccessLevel, requiredLevel);
  }
}
```

### Access Check Order

When a method is called, `ensureAccessForMethod` checks in this order:

1. **Service-level**: `socket.serviceAccess[serviceName] >= requiredLevel` → Allow
2. **Custom override**: `checkAccess()` returns true → Allow (use for self-access patterns)
3. **Entry-level**: `checkEntryACL()` returns true → Allow (JSON ACL or membership table)
4. **Deny** if none of the above

### Access Levels

| Level | Value | Typical Use |
|-------|-------|-------------|
| Public | 0 | No authentication required |
| Read | 1 | View data, subscribe to updates |
| Moderate | 2 | Edit content, manage members |
| Admin | 3 | Delete, manage ACL, full control |

## Testing

### Server Integration Tests

```typescript
import { createTestServer, connectAsUser, emitWithAck } from '@fitzzero/quickdraw-core/server/testing';

describe('ChatService', () => {
  let server;
  
  beforeAll(async () => {
    server = await createTestServer({
      services: { chatService: new ChatService() },
      seedDb: async () => { /* seed test data */ },
    });
  });
  
  afterAll(() => server.stop());
  
  it('creates chat', async () => {
    const client = await server.connectAs('user-id');
    const chat = await client.emit('chatService:createChat', { title: 'Test' });
    expect(chat.id).toBeDefined();
    client.close();
  });
});
```

### Client Component Tests

```typescript
import { createTestWrapper, createMockSocket, mockSuccessEmit } from '@fitzzero/quickdraw-core/client/testing';

test('renders chat', () => {
  const mockSocket = createMockSocket();
  mockSocket.emit.mockImplementation(mockSuccessEmit({ title: 'Test Chat' }));
  
  const wrapper = createTestWrapper({ socketContext: { socket: mockSocket } });
  render(<ChatView chatId="123" />, { wrapper });
  
  expect(screen.getByText('Test Chat')).toBeInTheDocument();
});
```

## Contributing

Contributions are welcome! Please read our contributing guide for details.

## License

MIT
