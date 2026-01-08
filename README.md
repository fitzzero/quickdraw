# @quickdraw/core

Fast fullstack patterns for real-time applications with Socket.io and TanStack Query.

## Features

- **Server Core**: BaseService class with typed CRUD, ACL-based access control, and real-time subscriptions
- **Client Core**: TanStack Query integration with Socket.io for real-time state management
- **Socket Inputs**: Pre-built form components that sync with server state
- **Custom OAuth**: JWT-based authentication with Discord and Google providers
- **Type Safety**: End-to-end TypeScript support with shared type definitions

## Installation

```bash
pnpm add @quickdraw/core
```

## Quick Start

### Server Setup

```typescript
import { createQuickdrawServer, BaseService } from '@quickdraw/core/server';
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
import { QuickdrawProvider } from '@quickdraw/core/client';

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
import { useService, useSubscription } from '@quickdraw/core/client';

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
import { SocketTextField } from '@quickdraw/core/client';

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
import { ServiceResponse, AccessLevel, ServiceMethodMap } from '@quickdraw/core';

// Server
import { 
  BaseService, 
  ServiceRegistry, 
  createQuickdrawServer,
  createJWT,
  verifyJWT,
  discordProvider,
  googleProvider,
} from '@quickdraw/core/server';

// Server testing
import { createTestServer, connectAsUser, emitWithAck } from '@quickdraw/core/server/testing';

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
} from '@quickdraw/core/client';

// Client testing
import { createMockSocket, createTestWrapper } from '@quickdraw/core/client/testing';
```

## Type Definitions

Define your service methods in a shared types file:

```typescript
// shared/types.ts
import type { ServiceMethodMap } from '@quickdraw/core';

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

Quickdraw supports two levels of access control:

### Service-level ACL

Stored in `user.serviceAccess` JSON field:
```json
{ "chatService": "Admin", "userService": "Read" }
```

### Entry-level ACL

Stored in entity's `acl` JSON field (when `hasEntryACL: true`):
```json
[
  { "userId": "user-1", "level": "Admin" },
  { "userId": "user-2", "level": "Read" }
]
```

### Access Levels

- **Public**: No authentication required
- **Read**: Authenticated users (default for subscriptions)
- **Moderate**: Edit access (update, moderate content)
- **Admin**: Full access (delete, manage ACL)

## Testing

### Server Integration Tests

```typescript
import { createTestServer, connectAsUser, emitWithAck } from '@quickdraw/core/server/testing';

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
import { createTestWrapper, createMockSocket, mockSuccessEmit } from '@quickdraw/core/client/testing';

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
