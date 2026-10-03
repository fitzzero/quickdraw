# @fitzzero/quickdraw-core

Fast fullstack patterns for real-time applications with Socket.io and TanStack Query.

## Features

- **Server Core**: BaseService class with typed CRUD, ACL-based access control, and real-time subscriptions
- **Collections**: declare a scope-keyed list once, get live add/update/remove deltas, pagination, and reconnect healing — no hand-wired events
- **Client Core**: TanStack Query integration with Socket.io for real-time state management
- **Socket Inputs**: Pre-built form components that sync with server state
- **Custom OAuth**: JWT-based authentication with Discord and Google providers
- **Type Safety**: End-to-end TypeScript support with shared type definitions

## Installation

```bash
pnpm add @fitzzero/quickdraw-core
```

## 5.0 preview: the server factory, its transports and the 4.x shim

The rest of this README describes 4.x. On the `dev` branch, 5.0 replaces
`createQuickdrawServer` and `ServiceRegistry` with `qd.createServer`
(design: `docs/rfcs/0003-v5.md`, sections 3, 8 and 10). It attaches to the
Express app and HTTP server the app already owns, never listens or exits the
process itself, and serves every service over three transports:

```typescript
import express from "express";
import { qd } from "./quickdraw"; // initQuickdraw<{ db; principal }>()

const app = express();
app.use(express.json()); // optional: the HTTP transport reads JSON bodies itself
const server = qd.createServer({
  app, // the HTTP transport is mounted on it; the HTTP server is created from it
  services: [taskService, projectService],
  db: prisma,
  auth: {
    // a user id or a principal; nothing for anonymous; throw to refuse
    authenticate: async ({ auth }) => verifySession(auth.token),
    loadServiceAccess: async (userId) =>
      (await prisma.user.findUnique({ where: { id: userId } }))?.serviceAccess,
  },
  legacyWire: true, // serve 4.x clients during the upgrade
  handleSignals: true, // close on SIGTERM and SIGINT (never process.exit)
});
server.httpServer.listen(4000);
```

- **Socket.IO** (protocol 5): a client connects with
  `auth: { token, qd: { protocol: 5, client } }`, receives `qd:hello` with the
  server's limits, and calls through `qd:call` and `qd:cancel`. Every socket
  gets the same few listeners however many methods the services have. The
  JSON-only parser is the default; `binary: true` restores the stock one.
  The socket rate limiter is on by default (100 events per minute per socket,
  `qd:ch`, `qd:cancel`, `qd:sub` and `qd:unsub` not counted); configure it
  with `rateLimit`, or turn it off with `rateLimit: false`.
- **HTTP**: `POST /qd/{service}/{method}` with the input as a JSON body and
  `Content-Type: application/json` (required, even without a body). The
  principal comes from the `session` cookie or an `Authorization: Bearer`
  token through the same `authenticate`; the reply is `{ ok: true, d }` or
  `{ ok: false, e: { code, message, data? } }` with the code's HTTP status.
  Works on Express 4 and 5, and on a bare Node server. Move it with
  `http: { path }`, turn it off with `http: false`, or mount
  `createHttpRouter({ dispatcher, auth })` yourself.
- **In process**: `server.dispatcher.caller(principal)` or `qd.caller(principal)`.

Pass your own HTTP server as `httpServer` together with the `app` it was
created from (or with `http: false`): the HTTP transport is mounted on `app`.

`server.close()` disconnects every socket, waits for the calls still in
flight (a mutation runs to its end) and closes the HTTP server, giving up after
`shutdownTimeoutMs` (default 10 s);
`server.rotate({ withinMs })` asks clients to reconnect within a window;
`server.access.refresh(userId)` reloads a user's grants, pushes `qd:access`
and resolves the user's entity subscriptions again (behind a cluster adapter,
on every node).

### The 4.x legacy shim

With `legacyWire: true`, a client that connects without `auth.qd` is served
as a 4.x client instead of being refused with `PROTOCOL_MISMATCH`. The shim
serves **request/response calls only**: `socket.emit("taskService:get", payload, ack)`
runs through the 5.0 pipeline and is answered in the 4.x `ServiceResponse`
shape, `{ success: true, data }` or `{ success: false, error, code }`, with the
HTTP status of the 5.0 error code as `code` (for example 422 for invalid
input, where 4.1 sent 400). A 4.x call made without a payload arrives as
`null`, as it did in 4.x. 4.x subscriptions (`{service}:subscribe`),
collections and channels are **not served**: those events get no reply. The
socket still receives `auth:info` on connect, and each service, method and
principal kind that calls through the shim is logged once at `warn`, so the
remaining 4.x clients can be found.

### MCP bridge

`@fitzzero/quickdraw-core/server/mcp` serves the services to AI agents as MCP
tools generated from their contracts at startup: one tool per method, named
`{service}_{method}`, described by the method's `describe` text
(`query({ input, output, describe: "Reads one task by its id." })`), with the
input schema's JSON Schema as its arguments and `readOnlyHint` on every query.
That needs Zod 4.2 or later for the input schemas: a method whose schema cannot
describe itself as JSON Schema stops the registry at startup, naming the method,
unless it is excluded. Every tool call goes through the dispatcher with
transport `"mcp"`, so input validation, access checks and limits apply exactly
as on a socket.

```typescript
import {
  createMcpHttpRouter,
  createMcpRegistry,
  createMcpStdioServer,
} from "@fitzzero/quickdraw-core/server/mcp";

// qd = initQuickdraw<{ db; principal; mcp: { scopes: string[] } }>() types ctx.mcp
const registry = createMcpRegistry({
  services: [taskService, projectService],
  dispatcher: server.dispatcher,
  // who a stdio session or an HTTP bearer token stands for; nothing = anonymous
  principal: async (request): Promise<AppPrincipal | null> =>
    verifyAgentToken(request.transport === "http" ? request.token : process.env.AGENT_TOKEN),
  context: async (request) => ({ scopes: await scopesOf(request) }), // ctx.mcp in handlers
  exclude: ["taskService.purge"], // or include: [...]; name: (service, method) => ...
  customTools: [
    {
      name: "summarize",
      description: "Summarizes the caller's open tasks.",
      inputSchema: z.object({ projectId: z.string() }), // validated before the handler runs
      // access: "authenticated" is the default; "public" lets anonymous callers in
      handler: async ({ arguments: args, caller }) => summarize(args, caller), // caller acts as the agent
    },
  ],
});

app.use(createMcpHttpRouter({ registry })); // GET /mcp/tools, POST /mcp/invoke
createMcpStdioServer({ registry, name: "my-app", version: "1.0.0" }); // in an MCP client's process
```

- **stdio** speaks the JSON-RPC wire format 4.1 did (protocol version
  2024-11-05). One process is one session: its queries share one concurrency
  lane, and `notifications/cancelled` cancels a call. Start its module through
  `bootstrapMcpServer(new URL("./mcp-server.js", import.meta.url))`, which
  sends console output to stderr so only the protocol reaches stdout.
- **HTTP** keeps 4.1's routes: `POST /mcp/invoke` takes `{ name, arguments }`
  or 4.1's `{ service, method, payload }` and answers `{ success: true, data }`,
  or `{ success: false, error, code, data? }` with the code's HTTP status.
- An anonymous caller (the `principal` hook returned nothing) may call
  `"public"` methods, and custom tools that declare `access: "public"`; any
  other tool answers `UNAUTHENTICATED` before it runs.
- A failed call reaches the agent as a tool error carrying the code
  (`FORBIDDEN`, `VALIDATION` with the issues, and so on). Changed from 4.1:
  tools are per method rather than per service, the agent can no longer pick
  its user with a `userId` argument, and `generateToolMetadata` is gone.

### Tracked writes

`@fitzzero/quickdraw-core/prisma` wraps the app's Prisma client so the
framework sees every write made through it (design: `docs/rfcs/0003-v5.md`,
section 5). Pass the tracked client as `db`; the server finds the rest on it:

```typescript
import { trackPrisma } from "@fitzzero/quickdraw-core/prisma";

export const db = trackPrisma(new PrismaClient({ adapter })); // the last extension applied
export const qd = initQuickdraw<{ db: typeof db; principal: AppPrincipal }>();
const server = qd.createServer({ app, services, db, flushSink: [auditSink] });

await qd.run(() => db.task.updateMany({ where: { dueAt: { lt: now } }, data: { late: true } }));
```

- Every handler runs in a unit of work. Each `create`, `update`, `upsert`,
  `delete`, `createMany`, `updateMany` and `deleteMany` made through `db` is
  recorded with its row ids, merged per row, and handed to the flush sinks
  once the response has been sent, with one revision per flush. A handler
  may return `db.task.update(...)` without awaiting it.
- Writes inside `db.$transaction` join the unit only when it commits; a
  rollback drops them. Prefer the interactive form
  (`db.$transaction(async (tx) => ...)`): an array-form
  `db.$transaction([...])` has no transaction client, so the rows a
  `deleteMany` or `updateMany` in it reads first are read outside the batch,
  and rows its earlier statements changed may be missed (a development
  warning names the model and operation).
- Jobs, scripts and webhooks wrap their writes in `qd.run(fn)`, which
  flushes before it returns. A write made outside any unit of work flushes
  on its own on the next tick, with a development warning.
- Not seen: nested writes (`{ labels: { create: [...] } }`, which warn in
  development), raw SQL and database cascades. Record raw SQL with
  `ctx.touch("task", ids)`, or `{ removed: true }` for deleted rows.
- Tracked models need a string `id` column; writes to other models pass
  through untracked, with one warning.

`createRecordingSink()` on `./testing` records what is flushed, for tests.
Entity frames, collection deltas and change topics are built on these
flushes (below).

### Access control

Each method declares who may call it, and a service with rows declares one
access policy that says how a principal's level on a row is found (design:
`docs/rfcs/0003-v5.md`, section 4). Everything fails closed: a method without
`access` does not compile, and a missing grant, an unknown level, a missing
id, a row that does not exist or a malformed access list denies.

```typescript
import { anyOf, inherit, jsonAcl, members } from "@fitzzero/quickdraw-core/server";

export const projectService = qd.defineService(project, {
  model: "project", // the Prisma model the rows live in
  access: anyOf(
    jsonAcl("acl", { owner: "ownerId" }), // [{ userId, level }] plus Admin for the owner
    members({ model: "projectMember", entry: "projectId", user: "userId", level: "role" }),
  ),
  methods: { get: { access: { entry: "Read" }, handler: ({ input, db }) => /* ... */ } },
});

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: project, via: "projectId" }), // the level on the task's project
  methods: {
    rename: { access: { entry: "Moderate" }, handler: /* ... */ },
    create: { access: { scope: "Moderate", of: project, id: "projectId" }, handler: /* ... */ },
    archiveAll: { access: { service: "Admin" }, handler: /* ... */ },
  },
});
```

- Forms: `"public"`, `"authenticated"`, `{ service: L }` (the user's
  service-wide grant), `{ entry: L, id? }` (the policy's level on the row;
  `id` defaults to `input.id`), `{ service: L1, entry: L2 }` (either),
  `{ scope: L, of, id }` (the level on a row of another service) and
  `custom(fn)`. Without a principal every form but `"public"` answers
  `UNAUTHENTICATED`; a principal that fails gets `FORBIDDEN`.
- A service-wide `Admin` grant passes every check on its service
  (`adminBypass: false` turns that off). A grant below `Admin` counts only
  where the form names `service`: a `Read` grant no longer reads every row,
  and a `Read` method without a row id is no longer open to every signed-in
  user, as both were in 4.x.
- Policies: `owner(field)`, `jsonAcl(field, { owner? })`,
  `members({ model, entry, user, level, levels? })`, `inherit({ from, via })`,
  `anyOf(...)` and `resolver({ levelsFor, where? })`. Their column names are
  checked against the Prisma client's models at compile time. A lookup is one
  batched query per table, memoized for the call, so checking 60 ids costs
  what checking one does. `entry` access needs a policy; a service without
  `model` may only use `"public"`, `"authenticated"`, `{ service }` and
  `custom`.
- `server.dispatcher.access` gives the same answers to other code:
  `levelsFor(service, principal, ids)`, `accessWhere(service, principal, level)`
  (a `where` filter for `findMany`, or `"none"`) and `onAccessChanged(listener)`,
  called when a tracked write may have changed someone's access to a row.
- `createServer({ access: { cacheMs: 30_000 } })` keeps policy lookups across
  requests; tracked writes to the columns and membership tables the policies
  read evict them. Writes the tracked client cannot see are picked up only
  when the time passes, so the cache is off by default.

### Projections and entity subscriptions

A projection is the wire shape of a row (design: `docs/rfcs/0003-v5.md`,
section 6). Its keys decide what a read selects, so a row is never read wider
than what is sent:

```typescript
export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: project, via: "projectId" }),
  versionColumn: "updatedAt", // answers "not modified" from the row's own time
  affects: [{ service: task, id: "parentTaskId" }], // a write to a child sends its parent again
  project: {
    // relations and computed fields: read with select, built by map
    card: { select: { title: true, status: true }, map: (row: CardRow) => toCard(row) },
  },
  methods: {
    // returns the database row: the framework keeps the projection's keys, dates as ISO strings
    get: {
      access: { entry: "Read" },
      handler: ({ input, db }) => db.task.findUniqueOrThrow({ where: { id: input.id } }),
    },
  },
});
```

- A projection's keys come from its schema's JSON Schema (Zod 4.2 or later),
  or from `project: { <name>: { keys } }`; a service whose projection has
  neither fails when it is defined. A handler returning a projection returns
  rows (a `Date` is fine where the wire has a string, extra columns are
  dropped); with `map`, it returns what `map` takes.
- Fields the contract's `fields` map puts above the caller's level on a row
  are stripped from that caller's copy, after any shared run.
- `qd:sub { s, ids, revs? }` (up to 500 ids) authorizes every id in one
  lookup, reads the allowed rows in one query, joins the room of each row
  found for the subscriber's level, and answers each id with
  `{ ok: true, d, rev }`, `{ ok: true, nm: true, rev }` (the held revision is
  current) or `{ ok: false, e }` (`FORBIDDEN`, `NOT_FOUND`). A socket is never
  in the room of a row it could not read. `qd:unsub { s, ids }` leaves.
- After each flush, subscribers get `qd:e`: `{ t: "u", s, id, rev, d }` with
  the whole row (a create, a touch, a projection with `map`, an `affects` row),
  `{ t: "p", s, id, rev, d }` with the changed fields only (an update of plain
  projection fields), or `{ t: "r", s, id, rev }` (a delete). One read per
  service per flush, none when no room has subscribers, and each frame is
  stripped once per subscriber tier.
- When a write lowers or removes someone's access, their sockets leave the
  rooms anchored on that row and get `qd:revoked { kind: "entity", reason:
"access", s, id }`; a changed level moves them to that tier's room with the
  row as they may now see it.
- "Not modified" (for `qd:sub` and for queries returning one projection row
  by `id`) comes from `versionColumn`, or from an in-process change log of
  recent flushes. The change log sees only this process's writes: an app
  running several processes without a Socket.IO cluster adapter declares
  `versionColumn`s or passes `changeLog: false`.
- Behind a cluster adapter (`setupRedisAdapter`), every touched row is read
  and sent, since other nodes' rooms are not visible, and access changes and
  refreshed grants are broadcast to every node.

### Collections and change topics

A collection is the rows of one service grouped by a scope value (design:
`docs/rfcs/0003-v5.md`, section 7). The contract declares it; the service
says whose policy authorizes a scope:

```typescript
export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: project, via: "projectId" }), // derived from the anchor: see below
  collections: { byProject: { anchor: project }, mine: { scopeAccess: "self" } },
  watchAccess: { service: "Read" }, // opens the service topic to Read grants; closed without it
  methods: {
    /* ... */
  },
});
```

- `qd:col:sub { s, c, scope }` authorizes the scope through its anchor's
  policy (the collection's `access` level, `Read` by default), then answers a
  page and joins the scope's room; flushes send `qd:c` deltas to it. A
  `"self"` scope is the subscriber's own user id: its items are stripped at
  `Read`, and it may not declare a higher `access`.
- Items are visible to everyone in the scope: no per-row policy or field
  tier applies inside a collection. Derive the item service's own access
  from the anchor (`inherit` from it, as above): a per-row policy on the
  item service (an owner column, a row's access list) is not applied to
  collection items, so a row it would hide still reaches everyone in its
  scope.
- `qd:watch { s, topic }` joins a change topic: `{collection}:{scope}`,
  authorized like a subscribe to that scope, or `service`, which changes
  whenever any row of the service does. The service topic is closed
  (`FORBIDDEN`) unless the service declares `watchAccess` (`"public"`,
  `"authenticated"` or `{ service: level }`). A watcher that loses access
  leaves the topic after one last `qd:changed`.
- The socket rate limiter does not count subscription events; each socket
  runs `qd:sub`, `qd:col:sub`, `qd:col:items` and `qd:watch` in a lane
  instead: `limits.subscriptions` (8 at once, 64 waiting), then
  `RATE_LIMITED`.

### Read/write kit

The methods most services write by hand, as one-line opt-ins (design:
`docs/rfcs/0003-v5.md`, section 12.1). `crud.contract` returns ordinary
entries for exactly the methods it names, and `crud.handlers` implements
exactly those, each with the access form it is given:

```typescript
// the shared package
import { crud, defineContract, mutation } from "@fitzzero/quickdraw-core";

export const task = defineContract("taskService", {
  entity: taskSchema,
  projections: { card: cardSchema },
  methods: {
    ...crud.contract({
      entity: taskSchema,
      get: true,
      getMany: true,
      list: { item: cardSchema, filter: ["projectId", "status"], sort: ["ordinal", "updatedAt"] },
      create: { input: newTaskSchema },
      update: { input: taskPatchSchema }, // every field optional; the kit adds `id`
      delete: true,
      reorder: { column: "ordinal", within: "projectId" },
      bulkUpdate: { input: taskPatchSchema }, // the kit adds `ids`
      bulkDelete: true,
    }),
    archive: mutation({ input: z.object({ id: z.string() }), output: "entity" }),
  },
});

// the server
import { crud, inherit, nextOrdinal } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: project, via: "projectId" }),
  methods: {
    ...crud.handlers(task, {
      access: {
        get: { entry: "Read" },
        getMany: "authenticated",
        list: "authenticated",
        create: { scope: "Moderate", of: project, id: "projectId" },
        update: { entry: "Moderate" },
        delete: { entry: "Admin" },
        reorder: { entry: "Moderate" },
        bulkUpdate: "authenticated",
        bulkDelete: "authenticated",
      },
      // what `create` writes: columns from the principal, the next ordinal
      prepare: async (input, ctx, db) => ({
        ...input,
        ownerId: ctx.principal.userId,
        ordinal: await nextOrdinal(db, "task", { projectId: input.projectId }),
      }),
    }),
    archive: { access: { entry: "Admin" }, handler: /* ... */ },
  },
});
```

- Each method needs a form: one missing from `access` does not compile.
  `get`, `update`, `delete` and `reorder` act on `input.id`, which
  `{ entry: L }` checks. `list`, `getMany`, `bulkUpdate` and `bulkDelete` act
  on many rows, so they also keep only the rows the service's policy gives
  the caller at the form's `entry` or `scope` level (else `Read` for reads
  and `Moderate` for writes): a list never shows a row `get` would refuse. A
  service-wide `Admin` grant reaches every row. A `"public"` read's rows are
  not filtered (a public bulk write still needs a level on each row), nor
  are any on a service without a policy, where the form is the whole check.
- `list({ filter?, sort?, cursor?, limit?, totalCount? })` returns
  `{ items, nextCursor, totalCount? }`: equality filters and one sort field,
  limited to the declared fields (anything else is `VALIDATION`), keyset
  cursors that stay put when rows are inserted, 50 items by default and at
  most 200 (a larger `limit` is clamped), and a total only when asked (a
  second statement). Items are the `item` projection, stripped of fields
  above the level the page was read at, as collection items are.
- `getMany({ ids })` (at most 200) leaves out ids the caller cannot read and
  ids with no row. Bulk writes skip rows the caller cannot write, run in one
  transaction and return `{ count }`.
- Writes go through the tracked client: `create` sends `added`, `update` a
  patch and `delete` `removed`, and a bulk write past a scope's
  `bulkThreshold` sends it one `reset`. A missing row is `NOT_FOUND`, a
  unique violation `CONFLICT`.
- `reorder({ id, beforeId?, afterId? })` puts the row between its new
  neighbors (`beforeId` comes right before it) with one write, or renumbers
  the `within` list in steps of 1,024 when no gap is left.
- The generated inputs carry JSON Schema, so the kit's methods are MCP tools
  too. For hand-written handlers, `./server` has `requireRow(row, message?)`
  (`NOT_FOUND` for a missing row) and `nextOrdinal(db, model, where)`.

### Testing

`@fitzzero/quickdraw-core/testing` boots the real server on a free port:

```typescript
import { createTestApp } from "@fitzzero/quickdraw-core/testing";

const app = await createTestApp({ services: [taskService], db: testPrisma });
await app.as(alice).taskService.rename({ id, title }); // in process
const { call, socket } = await app.connect(alice); // a real v5 socket
await call.taskService.get({ id });
await app.close();
```

Its sockets act as the principal they connect with. `emitWithAck` and
`waitForEvent` send raw frames and wait for events.

`describeAccessMatrix(app, { service, principals, cases, via? })` runs each
case as each principal, and anonymously, through the app's real dispatcher
(in process, or over a socket per principal with `via: "socket"`), and fails
listing every cell that differs from the expected table:

```typescript
await describeAccessMatrix(app, {
  service: taskService,
  principals: { owner, member, stranger },
  cases: [
    { method: "get", input: { id }, allow: ["owner", "member"] }, // everyone else is denied
    {
      method: "rename",
      input: { id, title: "x" },
      expect: { owner: "allow", member: "FORBIDDEN" },
    },
  ],
});
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

### Collections (Live Lists)

Entity subscriptions cover single rows; **collections** cover lists. A
collection is "rows of this service, grouped by a scope id derived from the
row" — declare it once and the framework handles emission (multi-node-safe),
pagination, and reconnect correctness. No more `task:created` /
`task:deleted` mirror events, `invalidateOn` refetches, or hand-rolled
merge-by-id state.

**Server** — declare next to your methods; the CRUD trio emits deltas
automatically (scope moves and predicate entry/exit included):

```typescript
type MessageCollections = { byChat: { item: MessageDTO } };

class MessageService extends BaseService<
  Message,
  Prisma.MessageCreateInput,
  Prisma.MessageUpdateInput,
  MessageServiceMethods,
  Record<string, unknown>, // channels
  MessageDTO, // TDto — wire shape
  MessageCollections // TCollections
> {
  constructor(prisma: PrismaClient) {
    super({ serviceName: "messageService" });
    this.setDelegate(prisma.message);

    this.defineCollection("byChat", {
      resolveScopeId: (message) => message.chatId,
      checkScopeAccess: (userId, chatId) => this.isChatMember(userId, chatId),
      // Server-ordered first page + reconnect re-snapshot. Omit `ids` for
      // unbounded histories like this one; return it for bounded scopes so
      // reconnecting clients prune rows deleted while offline.
      snapshot: async (chatId, { cursor, limit }) => this.getMessagePage(chatId, cursor, limit),
      toItem: (message) => this.toDto(message),
    });
  }
}
```

**Client** — one hook per list; live deltas, `loadMore` paging, and
re-snapshot-on-reconnect are built in:

```tsx
import { useCollection } from "@fitzzero/quickdraw-core/client";

function ChatWindow({ chatId }: { chatId: string }) {
  const {
    items: messages,
    isLoading,
    hasMore,
    loadMore,
  } = useCollection<MessageDTO>("messageService", "byChat", chatId, {
    compare: (a, b) => a.createdAt.localeCompare(b.createdAt),
  });

  return <MessageList messages={messages} onScrollTop={hasMore ? loadMore : undefined} />;
}
```

Scopes don't have to be parent entities — `resolveScopeId` may return a
`string[]` to fan out (e.g. a chat appearing in every member's `myChats`
collection, scope = user id), or `null` to exclude a row (predicate
filtering). For hand-rolled write paths, one-line choke points keep deltas
flowing: `emitCollectionUpsert` / `emitCollectionRemove` /
`emitCollectionMove` / `emitCollectionReset`, plus `kickFromCollection` for
adapter-safe ACL revocation.

ACL is deliberately simple: items are **scope-visible** — anyone who passes
`checkScopeAccess` sees every item in full (strip sensitive fields in
`toItem`/`snapshot`). If visibility varies per user within a scope, that's
not a collection — use separate scopes or entity subscriptions.

When to use which:

| Hook              | Use for                                                       |
| ----------------- | ------------------------------------------------------------- |
| `useSubscription` | One entity, field-tiered (detail panels)                      |
| `useCollection`   | Live lists of a scope (boards, feeds, chat histories)         |
| `useServiceQuery` | Genuinely query-shaped reads (search, cross-scope aggregates) |

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

For genuinely custom, ephemeral events (typing indicators, presence pulses —
things that aren't rows), broadcast with `emitToRoom` and listen with
`useRoomEvents`:

```tsx
import { useSubscription, useRoomEvents } from "@fitzzero/quickdraw-core/client";

function ChatView({ chatId }: { chatId: string }) {
  const { data: chat } = useSubscription("chatService", chatId);
  const [typing, setTyping] = useState<string | null>(null);

  // Lifecycle-managed event listeners — cleanup handled automatically
  useRoomEvents({
    "chat:typing": ({ userName }: { userName: string }) => setTyping(userName),
    "chat:typingStop": () => setTyping(null),
  });

  return <Chat chat={chat} typing={typing} />;
}
```

Event names and payloads can be typed end-to-end by augmenting
`QuickdrawEventMap` from the package root — `emitToRoom` and `useRoomEvents`
then check payloads and autocomplete names (and degrade to
`string`/`unknown` if you never augment it):

```typescript
declare module "@fitzzero/quickdraw-core" {
  interface QuickdrawEventMap {
    "chat:typing": { userName: string };
    "chat:typingStop": Record<string, never>;
  }
}
```

Don't hand-emit row lifecycle events (`task:created`, `task:deleted`, …) —
that's what collections automate; the shipped
`quickdraw/no-manual-collection-events` lint rule flags them.

### Auto-Invalidating Queries

For genuinely query-shaped reads (search results, cross-scope aggregates)
that should refresh when related events fire, use `invalidateOn`:

```tsx
import { useServiceQuery } from "@fitzzero/quickdraw-core/client";

function SearchResults({ query }: { query: string }) {
  const { data: results } = useServiceQuery(
    "taskService",
    "searchTasks",
    { query },
    {
      invalidateOn: ["task:statusUpdate"],
      refetchInterval: 60_000, // optional periodic refresh
    },
  );

  return <Results items={results} />;
}
```

Rapid-fire events within 100ms are debounced into a single refetch. For
plain scope lists, prefer `useCollection` — it replaces the
`invalidateOn` + refetch cycle with true deltas.

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

## Splitting Large Services

Real services grow past what one file should hold. The proven pattern —
battle-tested in the framework's largest consumer without import cycles — is
an abstract `*ServiceCore` plus method modules wired by a thin concrete
subclass:

```typescript
// services/task/service-core.ts — state, ACL overrides, helpers. No methods.
export abstract class TaskServiceCore extends BaseService<
  Task,
  Prisma.TaskCreateInput,
  Prisma.TaskUpdateInput,
  TaskServiceMethods,
  TaskChannels,
  TaskDTO,
  TaskCollections
> {
  constructor(protected readonly prisma: PrismaClient) {
    super({ serviceName: "taskService" });
    this.setDelegate(prisma.task);
  }

  public buildCardDTO(taskId: string): Promise<TaskCardDTO> {
    /* ... */
  }
}

// services/task/methods/create-task.ts — one module per method (or cluster).
// defineMethod is public precisely so modules can register on the instance.
export function registerCreateTask(service: TaskService): void {
  service.defineMethod(
    "createTask",
    "Read",
    async (payload, ctx) => {
      // ...
    },
    { schema: createTaskSchema },
  );
}

// services/task/index.ts — the concrete subclass wires the modules.
export class TaskService extends TaskServiceCore {
  constructor(prisma: PrismaClient) {
    super(prisma);
    registerCreateTask(this);
    registerUpdateTask(this);
    // ...
    this.verifyAllMethods(["createTask", "updateTask" /* ... */]);
  }
}
```

Core → modules → concrete class is a DAG: the core never imports the modules,
the modules never import each other. `verifyAllMethods` catches a forgotten
`register*` call at boot. The public choke points (`emitUpdate`,
`emitCollectionUpsert`, `emitToRoom`, `isLevelSufficient`, …) exist so method
modules outside the class stay fully capable.

## Package Exports

```typescript
// Shared types (both server and client)
import {
  ServiceResponse,
  AccessLevel,
  ServiceMethodMap,
  // Room helpers + typed events (4.0)
  serviceRoom,
  collectionRoom,
  userRoom,
  type QuickdrawEventMap,
  type CollectionDelta,
} from "@fitzzero/quickdraw-core";

// Server
import {
  BaseService,
  BaseRpcService, // 4.0: method-only services, no delegate/CRUD
  ServiceRegistry,
  createQuickdrawServer,
  type CollectionDefinition, // 4.0
  type QuickdrawIdentity, // 4.0: structured authenticate result
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
  useCollection, // 4.0: live scope-keyed lists
  useRoomEvents,
  ServiceCallError, // 4.0: hook errors carry the server code
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
│  useCollection() ───────────────────────────────────────────┤   │
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
│  BaseService<Entity, Create, Update, Methods, …, Dto, Colls>    │
│  ├── defineMethod() - Type-safe method definition               │
│  ├── defineCollection() - Live lists with automatic deltas      │
│  ├── subscribe() / unsubscribe() - Real-time subscriptions      │
│  ├── create() / update() / delete() - CRUD, auto-emit + hooks   │
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
