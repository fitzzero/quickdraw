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
import { createQuickdrawServer, BaseService } from "@fitzzero/quickdraw-core/server";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Define your service
class ChatService extends BaseService<
  Chat,
  Prisma.ChatCreateInput,
  Prisma.ChatUpdateInput,
  ChatServiceMethods
> {
  constructor() {
    super({ serviceName: "chatService", hasEntryACL: true });
    this.setDelegate(prisma.chat);

    // Define public methods
    this.createChat = this.defineMethod("createChat", "Read", async (payload, ctx) => {
      const chat = await this.create({ title: payload.title, ownerId: ctx.userId });
      return { id: chat.id };
    });
  }

  createChat: ReturnType<typeof this.defineMethod<"createChat">>;
}

// Start server
const { io, httpServer } = createQuickdrawServer({
  port: 4000,
  cors: { origin: "http://localhost:3000" },
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
import { QuickdrawProvider } from "@fitzzero/quickdraw-core/client";

export default function RootLayout({ children }) {
  return (
    <QuickdrawProvider serverUrl="http://localhost:4000" authToken={getAuthToken()}>
      {children}
    </QuickdrawProvider>
  );
}

// app/chat/page.tsx
import { useService, useSubscription, useRoomEvents } from "@fitzzero/quickdraw-core/client";

function ChatPage({ chatId }: { chatId: string }) {
  // Subscribe to real-time entity updates
  const { data: chat, isLoading } = useSubscription("chatService", chatId);

  // Mutation hook
  const updateTitle = useService("chatService", "updateTitle", {
    onSuccess: () => console.log("Title updated!"),
  });

  // Listen for custom events broadcast to the chat room
  const [typing, setTyping] = useState(false);
  useRoomEvents({
    "chat:message": (msg) => appendMessage(msg),
    agent_typing_start: () => setTyping(true),
    agent_typing_stop: () => setTyping(false),
  });

  if (isLoading) return <div>Loading...</div>;

  return (
    <div>
      <h1>{chat?.title}</h1>
      <button onClick={() => updateTitle.mutate({ id: chatId, title: "New Title" })}>
        Update Title
      </button>
    </div>
  );
}
```

### Socket Inputs

```tsx
import { SocketTextField } from "@fitzzero/quickdraw-core/client";

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

### Custom Room Events

When your server broadcasts custom events to subscription rooms via `emitToRoom`, use `useRoomEvents` on the client to listen with proper lifecycle management:

```tsx
import { useSubscription, useRoomEvents } from "@fitzzero/quickdraw-core/client";

function ProjectBoard({ projectId }: { projectId: string }) {
  const { data: project } = useSubscription("projectService", projectId);
  const [tasks, setTasks] = useState<Task[]>([]);

  // Lifecycle-managed event listeners — cleanup handled automatically
  useRoomEvents({
    "task:created": (task: Task) => setTasks((prev) => [...prev, task]),
    "task:deleted": ({ id }: { id: string }) => setTasks((prev) => prev.filter((t) => t.id !== id)),
  });

  return <Board tasks={tasks} />;
}
```

### Auto-Invalidating Queries

For list queries that should refresh when related events fire, use `invalidateOn`:

```tsx
import { useServiceQuery } from "@fitzzero/quickdraw-core/client";

function TaskList({ projectId }: { projectId: string }) {
  // Auto-refetches when tasks are created, deleted, or change status
  const { data: tasks } = useServiceQuery(
    "taskService",
    "listTasks",
    { projectId },
    {
      invalidateOn: ["task:created", "task:deleted", "task:statusUpdate"],
    },
  );

  return (
    <ul>
      {tasks?.map((t) => (
        <li key={t.id}>{t.title}</li>
      ))}
    </ul>
  );
}
```

Rapid-fire events within 100ms are debounced into a single refetch.

### Channels (High-Frequency Traffic)

Methods are request/response: ack'd, ACL-checked against the database, and
counted by the global rate limiter. **Channels** are their fire-and-forget
counterpart for traffic where per-message overhead matters and losing a
message is fine — game input, cursor positions, typing indicators, telemetry.

Channel messages have no ack and no response. Each message is validated
(zod schema required), access-checked entirely in memory (zero DB reads on
the hot path), and governed by a per-socket, per-channel token bucket instead
of the global limiter. Excess messages are silently dropped; sustained extreme
flooding disconnects the socket.

**Server** — define channels next to methods; broadcast tick data back with
`emitToRoomVolatile` (backpressured clients drop frames instead of queueing):

```typescript
type GameServiceChannels = ServiceChannelMap<{
  input: { seq: number; dx: number; dy: number; boost: boolean };
}>;

class GameService extends BaseService<
  GameWorld,
  Prisma.GameWorldCreateInput,
  Prisma.GameWorldUpdateInput,
  GameServiceMethods,
  GameServiceChannels // 5th type param
> {
  constructor(prisma: PrismaClient) {
    super({ serviceName: "gameService" });
    this.setDelegate(prisma.gameWorld);

    this.defineChannel(
      "input",
      "Read",
      (payload, ctx) => this.sim.applyInput(ctx.userId, payload),
      {
        schema: gameInputSchema,
        ratePerSecond: 30, // default 30
        burst: 60, // default 2x rate
        requireRoom: () => this.getRoomName(WORLD_ID), // entry-level gate
      },
    );
  }

  // In a 20Hz tick loop:
  broadcastSnapshot(snapshot: WorldSnapshot): void {
    this.emitToRoomVolatile(this.getRoomName(WORLD_ID), "game:snapshot", snapshot);
  }
}
```

Exempt channel traffic from the global rate limiter (channels self-limit):

```typescript
import { CHANNEL_EVENT_PREFIX } from "@fitzzero/quickdraw-core";

const rateLimiter = createRateLimiter({
  maxRequests: 100,
  excludePrefixes: [CHANNEL_EVENT_PREFIX],
});
```

**Client** — send with `useChannelSend`; receive broadcasts with the existing
`useRoomEvents` (volatile room emits arrive as ordinary events):

```tsx
import { useSubscription, useRoomEvents, useChannelSend } from "@fitzzero/quickdraw-core/client";

function GameView({ worldId }: { worldId: string }) {
  useSubscription("gameService", worldId); // room membership gates the channel
  const { send, isReady } = useChannelSend<GameInput>("gameService", "input");

  useRoomEvents({
    "game:snapshot": (snap: WorldSnapshot) => applySnapshot(snap),
  });

  // e.g. called from a fixed-timestep loop
  const onTick = (input: GameInput) => send(input);
}
```

**Access model** (all synchronous, in-memory):

| Check                    | Behavior                                                                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication           | Always required — anonymous messages dropped, even at `"Public"` access                                                                                        |
| `"Public"` / `"Read"`    | Any authenticated user passes the service gate                                                                                                                 |
| `"Moderate"` / `"Admin"` | Requires that level in the socket's `serviceAccess`                                                                                                            |
| `requireRoom`            | Socket must already be in the resolved room — membership was ACL-checked at subscribe time, so this inherits entry ACL semantics without a DB read per message |

Channels route as the Socket.io event `channel:<serviceName>:<channelName>`
(helper: `channelEventName(serviceName, channelName)`), which also makes them
easy to speak from non-JS clients (game engines, native apps).

When to use which:

|                | Method                    | Channel                  |
| -------------- | ------------------------- | ------------------------ |
| Response       | ack with data/error       | none (fire-and-forget)   |
| Frequency      | occasional (user actions) | tick rate (10-60Hz)      |
| Loss tolerance | must not lose             | next message supersedes  |
| ACL            | full async check incl. DB | in-memory only           |
| Rate limit     | global limiter            | per-channel token bucket |

## Package Exports

```typescript
// Shared types (both server and client)
import { ServiceResponse, AccessLevel, ServiceMethodMap } from "@fitzzero/quickdraw-core";

// Server
import {
  BaseService,
  ServiceRegistry,
  createQuickdrawServer,
  createJWT,
  verifyJWT,
  discordProvider,
  googleProvider,
  // Auth & security (3.7+)
  createMockOAuthProvider,
  registerMockOAuthProvider,
  isMockOAuthEnabled,
  validateRedirectOrigin,
  setSessionCookie,
  clearSessionCookie,
  createRequireAuth,
  encrypt,
  decrypt,
} from "@fitzzero/quickdraw-core/server";

// Express rate-limit presets (3.7+, requires the optional express-rate-limit peer)
import {
  createAuthLimiter,
  createWebhookLimiter,
  createPublicApiLimiter,
} from "@fitzzero/quickdraw-core/server/express";

// Server testing
import {
  createTestServer,
  connectAsUser,
  emitWithAck,
} from "@fitzzero/quickdraw-core/server/testing";

// Dual-mode Prisma test databases (3.7+, optional peers: @electric-sql/pglite, pg)
import {
  createPrismaTestGlobalSetup,
  resetDatabase,
  workerDatabaseUrl,
} from "@fitzzero/quickdraw-core/server/testing/prisma";

// Client
import {
  QuickdrawProvider,
  useQuickdrawSocket,
  useService,
  useServiceQuery,
  useSubscription,
  useRoomEvents,
  SocketCheckbox,
  SocketTextField,
  SocketSelect,
  SocketSlider,
  SocketSwitch,
} from "@fitzzero/quickdraw-core/client";

// Client testing
import { createMockSocket, createTestWrapper } from "@fitzzero/quickdraw-core/client/testing";
```

## Linting

The package ships a shared oxlint base config, `oxlint.base.jsonc` — the
framework's lint best practices (strict type-safety, complexity budgets, and
the `quickdraw` plugin rules pre-wired for `services/**` and client code).
Extend it from your root `.oxlintrc.json` so best practices update with the
package:

```jsonc
{
  "extends": ["./node_modules/@fitzzero/quickdraw-core/oxlint.base.jsonc"],
  // plugins are NOT purely inherited: omitting this array unions oxlint's
  // default plugin set into the merge — mirror the base's list.
  "plugins": ["typescript", "import", "react", "nextjs", "jsx_a11y"],
  // ignorePatterns, env, globals, and settings are not inherited — declare here.
  "ignorePatterns": ["**/dist/**", "**/node_modules/**"],
  "overrides": [
    // Project-specific relaxations win over the base (overrides concatenate,
    // consumer last), e.g. allow specific cross-service mutations:
    {
      "files": ["**/services/**/*.ts"],
      "rules": {
        "quickdraw/no-cross-service-mutations": [
          "error",
          { "allowedModels": { "chat": ["chatMember"] } },
        ],
      },
    },
  ],
}
```

The base config also loads `./eslint-plugin` (the `quickdraw` rules) via
`jsPlugins` — no separate wiring needed. The `./eslint-config` export (ESLint
flat config) is legacy; prefer the oxlint base.

## Local Development

This package is developed alongside [quickdraw-chat](https://github.com/fitzzero/quickdraw-chat), a reference implementation.

quickdraw-chat consumes the published npm package. For local iteration
against a checkout, use `bun link` (or point lint `extends` at the sibling
path), and always re-verify against a published version before releasing:

```bash
bun run build  # or bun run dev for watch mode
```

## Type Definitions

Define your service methods in a shared types file:

```typescript
// shared/types.ts
import type { ServiceMethodMap } from "@fitzzero/quickdraw-core";

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
    payload: { id: string; userId: string; level: "Read" | "Moderate" | "Admin" };
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

| Level    | Value | Typical Use                      |
| -------- | ----- | -------------------------------- |
| Public   | 0     | No authentication required       |
| Read     | 1     | View data, subscribe to updates  |
| Moderate | 2     | Edit content, manage members     |
| Admin    | 3     | Delete, manage ACL, full control |

## Testing

### Server Integration Tests

```typescript
import {
  createTestServer,
  connectAsUser,
  emitWithAck,
} from "@fitzzero/quickdraw-core/server/testing";

describe("ChatService", () => {
  let server;

  beforeAll(async () => {
    server = await createTestServer({
      services: { chatService: new ChatService() },
      seedDb: async () => {
        /* seed test data */
      },
    });
  });

  afterAll(() => server.stop());

  it("creates chat", async () => {
    const client = await server.connectAs("user-id");
    const chat = await client.emit("chatService:createChat", { title: "Test" });
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
