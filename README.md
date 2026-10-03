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
  `createHttpRouter({ dispatcher, auth })` yourself. It has no rate limit of
  its own: on Express, set `http: { rateLimit: createCallLimiter() }` (from
  `./server/express`), which refuses with the `RATE_LIMITED` reply.
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
  are any on a service without a policy, where the form is the whole check:
  there these methods (and `search`) must be `"public"` or `{ service }`,
  or the service is refused when it is defined.
- `list({ filter?, sort?, cursor?, limit?, totalCount? })` returns
  `{ items, nextCursor, totalCount? }`: equality filters and one sort field,
  limited to the declared fields (anything else is `VALIDATION`; a field
  above the caller's level is `FORBIDDEN`, and a default sort on one falls
  back to `id`), keyset cursors that stay put when rows are inserted, 50
  items by default and at most 200 (a larger `limit` is clamped), and a
  total only when asked (a second statement). Items are the `item`
  projection, stripped of fields above the level the page was read at, as
  collection items are.
- `getMany({ ids })` (at most 200) leaves out ids the caller cannot read and
  ids with no row. Bulk writes skip rows the caller cannot write, run in one
  transaction and return `{ count }`.
- Writes go through the tracked client: `create` sends `added`, `update` a
  patch and `delete` `removed`, and a bulk write past a scope's
  `bulkThreshold` sends it one `reset`. A missing row is `NOT_FOUND`, a
  unique violation `CONFLICT`.
- `update` and `bulkUpdate` (and the admin kit's writes) never let a caller
  without a service-wide `Admin` grant set a column the policy reads (an
  owner column, an access list), and move a row into another parent (an
  `inherit` policy's `via`, an anchored collection's scope column) only
  when the caller's level on the new parent meets the method's row level:
  `FORBIDDEN` otherwise.
- `reorder({ id, beforeId?, afterId? })` puts the row between its new
  neighbors (`beforeId` comes right before it) with one write, or renumbers
  the `within` list in steps of 1,024 when no gap is left.
- The generated inputs carry JSON Schema, so the kit's methods are MCP tools
  too. For hand-written handlers, `./server` has `requireRow(row, message?)`
  (`NOT_FOUND` for a missing row) and `nextOrdinal(db, model, where)`.

### Search kit

Search as a one-line opt-in (design: `docs/rfcs/0003-v5.md`, section 12.2).
`search.contract` makes one query, `search`, and `search.handlers`
implements it; on the client, its member gets `useSearch`:

```typescript
// the shared package
import { defineContract, search } from "@fitzzero/quickdraw-core";

export const task = defineContract("taskService", {
  entity: taskSchema,
  projections: { card: cardSchema },
  methods: {
    // looks in title and description; a call may keep to one scope of byProject
    ...search.contract({
      entity: taskSchema,
      item: cardSchema, // a scoped search's results are its collection's items
      fields: ["title", "description"],
      scope: "byProject",
    }),
  },
  collections: {
    byProject: {
      scope: "projectId",
      item: "card",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
    },
  },
});

// the server
import { search } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: project, via: "projectId" }),
  collections: { byProject: { anchor: project } },
  methods: { ...search.handlers(task, { access: "authenticated" }) },
});

// a component
const { items, isSearching } = qd.task.search.useSearch(text, { scope: projectId });
```

- `search({ q, scope?, cursor?, limit? })` returns `{ items, nextCursor }`
  (and `rev`, below). `q` is trimmed, and one shorter than `minLength`
  (default 2) finds nothing and reads nothing. 20 results by default, at
  most 100, with keyset cursors as for `list`. There is no ranking: results
  come in the scope collection's order, else by id.
- By default a row matches when one of the declared `fields` contains `q`,
  ignoring case; `%`, `_` and `\` in `q` are taken literally. `fields` is an
  explicit list because an unbounded "contains" over every column is slow. A
  field the reader's level does not receive (a field tier) is not searched,
  so whether a row matches never tells what that field holds.
- A search finds only rows the caller can read, as `list` does: the policy's
  `accessWhere` at the form's `entry` or `scope` level, else `Read`; a
  `"public"` search is not filtered and hides every tiered field. With
  `scope`, only that scope's members (its column, or its `via` junction's
  links, and `where`), and only for a caller who may open the scope as
  `qd:col:sub` decides (`UNAUTHENTICATED` without a principal, `FORBIDDEN`
  below the collection's `access` on its anchor). Identical concurrent searches by one caller run once
  (`share: "caller"`). For a contract with several search methods,
  `method` names the one a `search.handlers` call implements.
- `strategy` replaces how rows are found; the kit still adds the access
  filter, the scope and paging. `where(q, ctx)` returns a filter;
  `ids(q, ctx, { limit })` returns ranked ids from an index of your own,
  which the kit reads, keeps to the rows the caller may read (so a page can
  hold fewer than `limit`) and returns in that order as one page. Postgres
  full-text search through a `tsvector` column the app maintains (a
  generated column or a trigger, with a GIN index):

  ```typescript
  ...search.handlers(task, {
    access: "authenticated",
    strategy: {
      // Prisma cannot filter on a tsvector column: find the ids with SQL
      where: async (q) => {
        const rows = await prisma.$queryRaw<{ id: string }[]>`
          SELECT id FROM "Task" WHERE "searchVector" @@ websearch_to_tsquery('english', ${q})
          LIMIT 1000`;
        return { id: { in: rows.map((row) => row.id) } };
      },
    },
  }),
  ```

  For results by relevance, return the ids from `ids` instead, ordered by
  `ts_rank("searchVector", query) DESC` and limited to `limit`.

- `useSearch(q, { scope?, debounceMs?, limit?, enabled? })` sends `q` once
  typing pauses (200 ms), cancels a search still on its way when the next
  one is sent (`qd:cancel`), keeps the last results in the same scope shown
  meanwhile, and returns `{ items, hasMore, isSearching, isLoading, error }`.
  A scoped search's page carries the revision it was read at (`rev`) when
  its items are exactly the scope collection's items: while a
  `useCollection` holds that scope, they are kept in its cache and shown as
  it holds them, so another user's rename of a result shows at once, with
  no second search and no subscription of the search's own.

### Sharing and membership kit

Sharing a row and managing its members as one-line opt-ins (design:
`docs/rfcs/0003-v5.md`, section 12.3). `sharing.contract` makes the methods
for one of the two ways a policy shares rows, and `sharing.handlers`
implements them on the access list or the membership table the service's own
policy reads:

```typescript
// the shared package
import { defineContract, sharing, via } from "@fitzzero/quickdraw-core";

export const project = defineContract("projectService", {
  entity: projectSchema,
  methods: {
    // the JSON access list jsonAcl reads: share, unshare, setLevel, listShares
    ...sharing.contract({ mode: "acl" }),
    // the table members reads: invite, remove, leave, setRole, listMembers; by name too
    ...sharing.contract({
      mode: "members",
      methods: ["invite", "inviteByName", "remove", "leave", "setRole", "listMembers"],
    }),
  },
  collections: {
    // each user's projects: an invite adds the project, a remove or a leave takes it out
    mine: {
      scope: via({ model: "projectMember", entry: "projectId", scope: "userId" }),
      item: "entity",
      order: [["id", "asc"]],
    },
  },
});

// the server
import { anyOf, jsonAcl, members, sharing } from "@fitzzero/quickdraw-core/server";

export const projectService = qd.defineService(project, {
  model: "project",
  access: anyOf(
    jsonAcl("acl", { owner: "ownerId" }),
    members({ model: "projectMember", entry: "projectId", user: "userId", level: "role" }),
  ),
  collections: { mine: { scopeAccess: "self" } },
  methods: {
    ...sharing.handlers(project, {
      // finds the user inviteByName means; none is NOT_FOUND
      resolveUser: async ({ name, email }) =>
        (await prisma.user.findFirst({ where: name === undefined ? { email } : { name } }))?.id,
      // runs inside the change's transaction: its writes commit with it, a throw undoes it
      onChange: async (change, ctx, db) => {
        /* change: { kind, id, userId, before, after } */
      },
    }),
  },
});
```

- Access list methods: `share({ id, userId, level })` gives a user `Read`,
  `Moderate` or `Admin` (replacing any level they had), `setLevel` changes
  the level of a user the row is shared with, `unshare({ id, userId })`
  takes it away, and `listShares({ id })` lists the row's shares; each
  returns the list as `[{ userId, level }]`, one entry per user. Membership
  methods: `invite({ entryId, userId, role? })` and
  `setRole({ entryId, userId, role })` return the member as
  `{ userId, role, level }`, `remove({ entryId, userId })` and
  `leave({ entryId })` return `null`, and
  `listMembers({ entryId, cursor?, limit? })` pages the members in user id
  order (50 by default, at most 200). `shareByName` and `inviteByName` take
  `name` or `email` instead of `userId`, and need `resolveUser`; a mode adds
  every method but those two unless `methods` names its own list.
- Who may call: a change needs `{ entry: "Admin" }` on the row, a list
  `{ entry: "Read" }`, and `leave` a signed-in member (`FORBIDDEN` for
  anyone else). `access: { share: { entry: "Moderate" } }` replaces one
  method's form; a lower form lets that level grant any level, `Admin`
  included.
- The kit changes the list or the table the service's policy reads, alone
  or inside `anyOf`, and takes their names from it: a service whose policy
  has none for a mode the contract uses (or two) fails when it is defined.
  Roles are the policy's `levels` keys, or the level names `Read`,
  `Moderate` and `Admin` without it; another role is `VALIDATION`, and
  `invite` without a role gives the lowest one that can read the row.
- The owner's access never changes (`CONFLICT`). A row keeps its last
  Admin: through the access list, the owner or an `Admin` entry; through
  the table, an `Admin` member (an owner column elsewhere in `anyOf` does not
  count). Taking the last one away, by `unshare`, a lower level, `remove`,
  `leave` or `setRole`, is `CONFLICT`. An access list the policy cannot read
  is `CONFLICT` and left as it is; an entry's other keys are kept. Inviting a
  member is `CONFLICT`, an unknown user `NOT_FOUND`, and a change to the
  level or role a user has already writes nothing.
- Each change reads and writes in one SERIALIZABLE transaction, so two
  changes to one row at once cannot lose one or both remove the last two
  Admins: the database fails the second, which answers `CONFLICT` (try
  again). The writes go through the tracked client, so the flush revokes
  the live subscriptions of whoever lost access (`qd:revoked`) and sends
  the `via` collections over the table `added` and `removed`; the kit sends
  nothing itself.

### Admin kit

Back-office methods for every row of a service, only for service
administrators, with the screen's fields derived from the entity (design:
`docs/rfcs/0003-v5.md`, section 12.4). `admin.contract` makes ordinary,
typed entries, and `admin.handlers` implements them; 4.1's
`installAdminMethods` registered them outside the type map:

```typescript
// the shared package
import { admin, defineContract } from "@fitzzero/quickdraw-core";

export const task = defineContract("taskService", {
  entity: taskSchema, // Zod 4.2 or later: the fields come from its JSON Schema
  methods: {
    // adminList, adminGet, adminCreate, adminUpdate, adminDelete,
    // adminMeta, adminSubscribers, adminReemit; `expose` picks fewer
    ...admin.contract({ entity: taskSchema, filter: ["status"], sort: ["createdAt", "title"] }),
  },
});

// the server
import { admin } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: project, via: "projectId" }),
  methods: {
    ...admin.handlers(task, {
      displayName: "Tasks", // the default: from the service name
      hiddenFields: ["internalNotes"], // never shown, returned or written
      fieldOverrides: { assigneeId: { type: "relation", relationService: "userService" } },
    }),
  },
});

// the client
const { data } = qd.task.admin.adminList.useQuery({ page: 2, sort: { field: "title" } });
const update = qd.task.admin.adminUpdate.useMutation();
update.mutate({ id, data: { status: "done" } });
const { services } = useAdminServices(qd); // [{ key: "task", serviceName, displayName }]
```

- Who may call: every method defaults to `{ service: "Admin" }`, the
  caller's service-wide grant. A row-level `Admin` (the row's owner, an
  access list entry, a member) is `FORBIDDEN`, with or without
  `adminBypass`. `access: { adminList: { service: "Moderate" } }` replaces
  one method's form; whatever the form, the method reaches every row, and
  rows go out with only the fields the caller's service-wide grant reaches
  (a `fields` tier above it is left out, and a filter, sort or write that
  names such a field is `FORBIDDEN`).
- `adminList({ page?, pageSize?, filter?, sort? })` returns
  `{ items, total, page, pageSize, totalPages }`: page numbers from 1, 20 rows
  by default and at most 100 (a larger `pageSize` is clamped), in two
  statements. `filter` is equality on the fields `admin.contract` declares
  and `sort` one declared field (the first one by default, then `id`):
  anything else, an operator object, `where` or `orderBy`, is `VALIDATION`.
  4.1 passed the caller's `where` to the database as it came.
- `adminGet({ id })` returns the row; `adminCreate({ data })` and
  `adminUpdate({ id, data })` write the entity's fields through the tracked
  client, so subscribers and collections get the same frames as for any
  other write; `adminDelete({ id })` returns `null`. `id`, `createdAt` and
  `updatedAt` are never writable, nor are hidden fields or those an override
  made read-only (`VALIDATION`); without a service-wide `Admin` grant, nor
  are the columns the policy reads, and a row moves to another parent only
  with the row level on it (`FORBIDDEN`, as for the read/write kit); each
  value is checked by the entity schema itself, and a value the database
  refuses is `VALIDATION`. A missing row is `NOT_FOUND`.
- `adminMeta()` returns `{ serviceName, displayName, fields }`, one
  `{ name, type, label, required, editable, showInTable, sortable,
filterable, enumValues?, relationService? }` per field: `type` is
  `string`, `number`, `boolean`, `date` (an ISO string with a date format),
  `enum` or `json` from the field's JSON Schema, and `relation` by override;
  `sortable` and `filterable` are the declared fields; `id` and the
  timestamps come first and are not editable; `acl`, `serviceAccess` and
  `service_access` are hidden, as in 4.1.
- `adminSubscribers({ id })` counts the sockets subscribed to a row per
  access level (`{ id, count, levels, complete }`; behind a Redis adapter
  the counts are this server's and `complete` is `false`), and
  `adminReemit({ id })` touches the row so the flush sends it again to every
  subscriber.
- `useAdminServices(qd)` lists the client's services whose `adminMeta`
  answers the user, with their display names, sharing the cache of
  `qd.<service>.admin.adminMeta.useQuery()`. On a mock client it answers
  from the `adminMeta` stubs.

### Presence, streams and channels

Who is online, feeds that start with recent history and then append (logs,
metrics), fast one-way input (cursors, typing) and typed room events
(design: `docs/rfcs/0003-v5.md`, section 12.5). All four are declared in
the contract; they share `qd.<service>.<name>` with the methods and
collections:

```typescript
// the shared package
export const task = defineContract("taskService", {
  entity: taskSchema,
  methods: {
    enterBoard: mutation({ input: z.object({ projectId: z.string() }), output: z.boolean() }),
  },
  streams: {
    // one feed per task; a subscriber needs Read on the task, and first gets the latest 50 lines
    logs: { item: logLineSchema, scope: "taskId", seed: 50, access: { entry: "Read" } },
    load: { item: z.number(), volatile: true, access: "authenticated" }, // one feed for everyone
  },
  channels: {
    // 20 a second per socket; only from a socket subscribed to the task the payload names
    cursor: { payload: cursorSchema, ratePerSecond: 20, requires: { entity: "taskId" } },
  },
  events: { cursorMoved: { payload: cursorSchema } },
});

// the server
export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: project, via: "projectId" }),
  methods: {
    enterBoard: {
      access: { scope: "Read", of: project, id: "projectId" },
      handler: ({ input, ctx }) => ctx.rooms.join(`board:${input.projectId}`),
    },
  },
  channels: {
    // relay each cursor to the board's room
    cursor: (payload, ctx) => {
      ctx.rooms.emit(`board:${payload.projectId}`, task, "cursorMoved", payload);
    },
  },
});
qd.stream(task, "logs").push(taskId, { line: "build started" }); // handlers, jobs, timers
await qd.presence.isOnline(userId); // also ctx.presence and server.presence

// the client
const { items, isLoading } = qd.task.logs.useStream(taskId, { max: 200 });
const { send, isReady } = qd.task.cursor.useChannel();
qd.task.cursorMoved.useEvent((cursor) => drawCursor(cursor));
const here = usePresence(`board:${projectId}`); // user ids, after enterBoard joined the room
```

- Streams: `push` checks each item against the stream's schema (a mismatch
  throws `INTERNAL` and nothing is sent), keeps the latest `seed` items per
  scope in memory on that process (at most 1,000 per scope and 10,000
  scopes per stream; a restart empties them, and durable history is the
  app's: store the rows and expose a collection), and sends
  `qd:stream { s, stream, scope?, item }` to the feed's subscribers,
  volatile when the stream says so. `qd:stream:sub` is authorized with the
  stream's `access` through the access engine, the scope being the row an
  `entry` or `scope` form checks; a stream without `access` is closed. The
  answer is the seed; `useStream` then appends, keeps the latest `max`
  (default 500), and subscribes again after a reconnect, when the seed
  replaces what it held. A socket holds at most 500 feeds.
- Channels: each message is `qd:ch [service, channel, payload]`, sent
  volatile and never answered. Per socket and channel a token bucket
  (`ratePerSecond`, default 30; `burst`, default twice that) drops what is
  over the rate, and a socket whose drops within 10 s pass 100 times the
  rate is disconnected. A message from an anonymous socket, one that fails
  its schema, one without the service grant `{ access: { service }, handler }`
  names, or one whose `requires` the socket does not hold (`{ entity }`: a
  `qd:sub` of that row; `{ collection, scope }`: a `qd:col:sub` of that
  scope) is dropped. Nothing is logged per message; a handler's error is.
  The socket rate limiter does not count channels.
- Presence: `isOnline`, `lastSeen` (now while online, else when the user's
  last socket on this process disconnected), `count` and `users` (each user
  once, anonymous sockets left out) come from this process's sockets, and
  from every node's (`fetchSockets`) behind a Redis adapter.
  `ctx.rooms.join(room)` and `leave` put the calling socket in an app room
  (calls without a socket get `false`; names starting with `qd:` or `user:`
  are refused with `VALIDATION`; at most 100 per socket), and the room's
  sockets get `qd:presence` frames: the list on joining, then who joins and
  who leaves. `usePresence(room)` shows them.
- Events: `ctx.rooms.emit(room, contract, event, payload)` and
  `emitToUser(userId, ...)` replace 4.1's `emitToRoom` and the augmentable
  event map; the payload is checked first (`INTERNAL`, nothing sent, when it
  fails), then sent as `qd:event [service, event, payload]`.
- A mock client's members show what the test sets: `mockItems` and
  `mockError` for a stream, `sent` for a channel, `mockEmit` for an event.

### Auth routes kit

Sign-in for Google, Discord, a development mock and guests, as one Express
middleware (design: `docs/rfcs/0003-v5.md`, section 12.6). The app supplies
how a provider's profile becomes its user (`onLogin`, returning the user's
id) and where sessions are stored (a `SessionStore`); `socketAuth` then
authenticates the server's sockets and HTTP calls by those sessions:

```typescript
import cors from "cors";
import {
  createAuthRoutes,
  discord,
  google,
  guest,
  mock,
  socketAuth,
} from "@fitzzero/quickdraw-core/server/auth";
import { createCallLimiter } from "@fitzzero/quickdraw-core/server/express";

const allowedOrigins = [env.CLIENT_URL]; // the web app's origins: one list for both
const sessions = prismaSessions(prisma); // below

const app = express();
app.set("trust proxy", 1); // behind a proxy, so the rate limits see the client's IP
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(
  createAuthRoutes({
    providers: [
      google({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }),
      discord({ clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET }),
      mock({ listUsers: listSeededUsers }), // served only while isMockOAuthEnabled()
      guest({ createUser: (input) => createGuestUser(guestSchema.parse(input)) }),
    ],
    sessions,
    jwtSecret: env.JWT_SECRET, // 32 characters or more
    onLogin: (profile, provider) => upsertUser(profile, provider), // the user's id, or null to refuse
    allowedOrigins,
    publicUrl: env.API_URL, // redirect URIs: {publicUrl}/auth/{provider}/callback
    successPath: "/auth/callback",
    errorPath: "/auth/login",
  }),
);

const server = qd.createServer({
  app,
  services,
  db: prisma,
  auth: {
    authenticate: socketAuth({
      sessions,
      jwtSecret: env.JWT_SECRET,
      allowedOrigins,
      loadPrincipal: (userId): AppPrincipal => ({ userId, kind: "user" }),
    }),
    loadServiceAccess: (userId) => loadGrants(userId),
  },
  http: { rateLimit: createCallLimiter() }, // the HTTP transport has no limit of its own
});
```

The routes, under `basePath` (default `/auth`). Each POST needs
`Content-Type: application/json`, which a cross-site form cannot send; a
failure answers `{ error: <code>, message }` with the code's HTTP status, and
nothing is cached:

| Route                                  | Answer                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `GET /{provider}/start?returnTo=<url>` | 302 to the provider                                                                                                   |
| `GET /{provider}/callback`             | 302 to `{origin}{successPath}` with the session cookie, or to `{origin}{errorPath}?error=state`, `denied` or `failed` |
| `POST /guest`                          | `createUser(body)`, then `{ userId }` with the session cookie                                                         |
| `GET /me`                              | `{ userId }`, or 401                                                                                                  |
| `POST /logout`                         | 204: revokes the session, clears the cookie                                                                           |
| `POST /logout-all`                     | 204: revokes every session of the user; 401 without a live session                                                    |
| `/mock/provider/*`                     | the mock provider's own endpoints, while `isMockOAuthEnabled()`                                                       |

- The OAuth state is 256 random bits, sent to the provider and kept in a
  10-minute HttpOnly, SameSite=Lax cookie (`__Host-qd_oauth` on `/` over a
  secure request, else `qd_oauth` on `basePath`). The callback clears it
  whatever happens, and accepts only that state, for that provider, within
  its 10 minutes, once (each redeemed state is remembered by the process),
  so a sign-in cannot be finished in another browser or replayed.
- `returnTo` is an origin or a URL on one; only its origin is kept, and only
  when `allowedOrigins` lists it (exact origins, or patterns anchored with
  `^` and `$`; nothing is read from the environment, and localhost or
  Codespaces origins are allowed only when listed). It is checked before it
  is stored and again before the redirect. Without `returnTo` the sign-in
  returns to the first exact origin listed.
- The session cookie holds a JWT naming the user and the session (`sid`).
  It is HttpOnly and SameSite=Lax, Secure in production or over HTTPS, and
  lasts `cookie.maxAgeMs` (7 days), as do the JWT and the stored session.
  `cookie.sameSite: "none"` (always Secure) serves a web app on another
  site; `cookie.domain` (or `COOKIE_DOMAIN`) shares it with subdomains. Its
  name is `cookie.name`, else `__Host-session` when it is Secure and has no
  domain (a browser then keeps it host-only on `/`, so no other site under
  the same parent domain can plant or replace it), else `session`.
- A cookie name a request repeats counts as no credential, for the session
  and the OAuth state alike: a sibling site can plant a second cookie of
  the same name, and the server cannot tell which is its own.
- `me` answers the same 401 whether the request had no credential, a forged
  or expired one, or one whose session was revoked. It, `logout` and
  `logout-all` read the cookie, else an `Authorization: Bearer` token.
- `socketAuth` reads a socket's `auth.token` (a bearer token, for clients
  without cookies), else the session cookie from its handshake; an HTTP
  call's credential is the one the transport found. No credential is
  anonymous; a credential that does not stand for a live session in the
  store is refused with `UNAUTHENTICATED` (logged at debug), so a logged
  out or revoked session stops working at the next handshake or call even
  though its JWT has not expired. A socket that uses the cookie must also
  come from an allowed page: its `Origin` must be in `allowedOrigins`
  (WebSockets are not subject to CORS, and a browser sends the cookie with
  any page's handshake). A handshake without `Origin` is refused unless it
  is a browser's same-origin request (`Sec-Fetch-Site: same-origin`) or
  `allowMissingOrigin: true` is set for native clients that keep cookies.
  Bearer tokens need no Origin, and HTTP calls are guarded by their JSON
  content type instead.
- Rate limits: the sign-in routes share `createAuthLimiter()` (20 requests
  per 15 minutes per IP) and the session routes `createAuthStatusLimiter()`
  (120); pass `rateLimit: { signIn, session }` to replace them (a shared
  store across instances, say) or `false`. The defaults need the optional
  peer `express-rate-limit`. The HTTP transport (`/qd`) is not limited
  unless `http.rateLimit` is set; `createCallLimiter()` (300 calls per
  minute per IP) refuses in the transport's own `RATE_LIMITED` reply. A web
  server that prefetches for many users calls from one address: give it its
  own `keyGenerator` or a higher `max`.
- The mock provider is mounted only while `isMockOAuthEnabled()`
  (`ENABLE_MOCK_OAUTH=true` and `NODE_ENV` other than `production`), and
  every request checks again. Set `mock({ internalUrl })` where the API
  cannot reach itself at `publicUrl`.
- `socketAuth` and the HTTP transport read `__Host-session`, else
  `session`, by default. A changed cookie name must be named in all three
  places: `createAuthRoutes({ cookie: { name } })`,
  `socketAuth({ cookieName })` and `createServer({ http: { cookieName } })`.
- Sockets that are already connected when their session is revoked stay
  connected until they reconnect.
- `issueSession({ sessions, jwtSecret }, userId, { provider })` starts a
  session for an app's own sign-in flow (login codes, an embedded activity),
  and `liveSession` reads a token back; both work with `socketAuth`.

A `SessionStore` on Prisma. Sessions are not live data, so nothing needs
their writes tracked: with the tracked client, the first session write logs
one development warning about a write outside a unit of work, which running
the store's writes inside `qd.run(...)` (or using the untracked client here)
avoids. Delete expired rows now and then.

```prisma
model Session {
  id        String   @id @default(cuid())
  userId    String
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  provider  String
  userAgent String?
  ip        String?
  createdAt DateTime @default(now())
  expiresAt DateTime

  @@index([userId])
  @@index([expiresAt])
}
```

```typescript
import type { SessionStore } from "@fitzzero/quickdraw-core/server/auth";

export function prismaSessions(db: PrismaClient): SessionStore {
  return {
    create: (userId, meta) => db.session.create({ data: { userId, ...meta } }),
    get: (id) => db.session.findUnique({ where: { id } }),
    revoke: (id) => db.session.deleteMany({ where: { id } }),
    revokeAll: (userId) => db.session.deleteMany({ where: { userId } }),
  };
}
```

`createMemorySessionStore()` keeps sessions in the process, for development
and tests.

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
