---
paths:
  - "apps/api/**"
  - "packages/shared/**"
---

# quickdraw 5.0: contracts and services

> From `@fitzzero/quickdraw-skills` (`quickdraw-skills link`). `paths` follow
> the quickdraw template: contracts in `packages/shared`, the server in
> `apps/api`. Another layout replaces this link with a copy and edits them.

## The contract comes first

One contract per service, in the shared package, so the client imports it
without server code. Everything else is typed from it.

```ts
export const task = defineContract("taskService", {
  describe: "Tasks on a project's board.", // what the service is for
  entity: taskSchema, // the full row; every row schema has `id: string`
  projections: { card: cardSchema }, // named lean shapes; "entity" is implicit
  fields: { notes: "Admin" }, // the level a caller needs to receive a field
  methods: {
    rename: mutation({ input: renameSchema, output: "entity", describe: "Renames a task." }),
    count: query({
      input: z.object({ projectId: z.string() }),
      output: z.number(),
      watch: { collection: "board", scope: (input) => input.projectId },
      describe: "Counts the tasks on a project's board.",
    }),
  },
  collections: {
    board: { describe: "A project's tasks.", scope: "projectId", item: "card", order: byOrdinal },
  },
});
```

- Every method is `query` or `mutation`, with `input` and `output`. `output`
  is a schema or a projection: `"entity"`, `"card"`, `nullable("entity")`,
  `listOf("card")`. Only a query may `watch`.
- Give the contract and every member a `describe`: a sentence or two on what
  it is for (each method, collection, stream, channel and event). The MCP
  bridge uses a method's as its tool's description, and `quickdraw-docs`
  leads each section with it. Lint's `require-describe` warns on each one
  missing; kits' contract halves write their own.
- Schemas are any Standard Schema. Use Zod 4.2 or later: MCP tools, the admin
  kit, projection keys and `quickdraw-docs` read their JSON Schema.
- Methods, collections, streams, channels and events share one namespace
  (`qd.<service>.<name>` on the client). `subscribe`, `unsubscribe`, `call`,
  `then`, `useEntity`, `useEntities`, `admin` and `$`-names are reserved.
  A contract without `entity` is an RPC-only service. A service name holds
  no `:` or `@` (it is part of every room name of the service).

## The service implements it

```ts
export const taskService = qd.defineService(task, {
  model: "task", // the Prisma delegate the rows live in
  access: inherit({ from: project, via: "projectId" }), // see quickdraw-access.md
  collections: { board: { anchor: project } },
  methods: {
    count: {
      access: { scope: "Read", of: project, id: "projectId" },
      handler: ({ input, db }) => db.task.count({ where: { projectId: input.projectId } }),
    },
    rename: {
      access: { entry: "Moderate" },
      handler: ({ input, db }) =>
        db.task.update({ where: { id: input.id }, data: { title: input.title } }),
    },
  },
});
```

- `qd` comes from one `initQuickdraw<{ db: typeof db; principal: AppPrincipal }>()`
  for the whole app (`context: (base) => ({...})` adds app fields to every
  `ctx`; `kinds: ["user", "agent"]` the kinds of principal every service
  admits). `db` is `trackPrisma(new PrismaClient({ adapter }))` from
  `@fitzzero/quickdraw-core/prisma`, applied as the last extension.
- `methods` implements exactly the contract's methods; each is
  `{ access, handler }`, plus `kinds` and `rowless` (see
  quickdraw-access.md), `timeoutMs`, and for queries `share` (`"caller"` or
  `"all"`), `ttlMs` and `version`. A service takes `kinds` too: the kinds of
  principal its methods and subscriptions admit.
- `timeoutMs` (else `limits.callTimeoutMs`, 30 s) is how long the caller
  waits: at the limit it gets `TIMEOUT` and `ctx.signal` aborts, but the
  handler runs on, and what it writes still commits. A handler that waits on
  a slow outside API passes it `ctx.signal` and calls
  `ctx.signal.throwIfAborted()` before it writes the outcome, and its
  method's `timeoutMs` sits above the API's slowest answer. The server warns
  (category `quickdraw.call`) when a call that answered `TIMEOUT` goes on to
  commit writes.
- `share: "all"` runs one handler for every caller, with the first caller's
  `ctx`, and gives every caller its result: use it only for a result that
  depends on the input alone. Its handler reads nothing of the caller
  (`ctx.principal`, `ctx.services`, `ctx.mcp`, `ctx.access`, or a context
  field made from them); in development a read of one of the first four warns
  `[quickdraw:shared-principal]`. It is refused with `custom` access and on
  the kit methods whose result depends on the caller (the read/write kit's
  `list` and `getMany`, `search`, the sharing kit's `listShares` and
  `listMembers`, the admin kit's `adminList` and `adminGet`): give those
  `share: "caller"`.
- A handler receives `{ input, ctx, db }`: the parsed input, the context
  (`principal`, `signal`, `log`, `requestId`, `transport`, `touch`, `rooms`,
  `presence`, `mcp`, `services`) and the tracked client.
- For a projection output, return the database row (a `Date` where the wire
  has a string, extra columns allowed): the framework selects and projects
  it. Never build the wire shape by hand. A relation or computed field is
  `project: { card: { select, map } }` on the service, `map` synchronous.
- Fail with `throw new QuickdrawError(code, message, data?)`: `NOT_FOUND`,
  `CONFLICT`, `VALIDATION`, `FORBIDDEN`, and so on. Anything else thrown
  reaches the caller as `INTERNAL`, except Prisma's unique violation
  (`CONFLICT`) and missing row (`NOT_FOUND`, as from `findUniqueOrThrow`).
- To use another service's method, call it through `ctx.services`, by
  service name: `await ctx.services.projectService.get({ id })`. It runs as
  the same principal with transport `"internal"`, checks that method's
  access, joins this call's unit of work (its writes flush with this call's)
  and is cancelled with `ctx.signal`; it is typed by the app's `contracts`
  (`initQuickdraw<{ ...; contracts }>()`). Never write another service's
  model directly to skip its access checks.
- A call through `ctx.services` carries this call's `ctx.mcp`, nested calls
  too, so in an MCP call the method it reaches sees the token's fields. Its
  `ctx.transport` is `"internal"`: tell a token's call apart by `ctx.mcp`,
  never by `ctx.transport === "mcp"`.

## REST routes call the services

Data goes through service methods. The few REST routes an app keeps (a
service worker's renewal, an inbound webhook, the auth routes) never reach
the database themselves: they sign the user in with `requireSession(keys)`
from `@fitzzero/quickdraw-core/server/auth` (it answers 401 itself, and 403
for the session cookie sent from a page outside the auth routes'
`allowedOrigins`, which it finds by the same store object in `keys`, never a
second store over the same table; pass `socketAuth`'s `loadPrincipal` too
when the app builds its own principal) and call the method in process, so its
validation, access check and tracked writes are a socket call's:

```ts
app.post("/api/push/resubscribe", express.json(), requireSession(keys), (req, res) => {
  void (async () => {
    const { principal } = sessionOf(req);
    try {
      res.json(await qd.caller(principal).pushService.subscribePush(req.body));
    } catch (error) {
      const failure = toWire(error); // a QuickdrawError: answer its code's status
      res.status(httpStatus(failure.code)).json(failure);
    }
  })();
});
```

`qd.caller(principal)` loads the principal's service-wide grants with the
server's `auth.loadServiceAccess`, as a socket's handshake does (once per
caller, again after the server refreshes that user's grants), so a method
behind `{ service: L }` passes or fails as it would over a socket. A
principal that carries `serviceAccess` keeps exactly those grants. Never
read `req.userId` through a cast, and never build a principal with grants
by hand to get past a check.

Authentication goes through the auth routes kit's helpers, which check the
session store on every call, so a signed-out or revoked session stops at
once:

- `socketAuth(...)` is `createServer`'s `authenticate`: the session cookie
  from an allowed page (the Origin rule), or a bearer token.
- `requireSession(keys)` guards the app's own REST routes.
- `bearerAuth(...)` is for a hook handed a bearer token alone: the MCP
  bridge's `principal`, an `authenticate` that reads `auth.token`.
- MCP clients connect to `createMcpHttpRouter`'s path itself (`POST /mcp`,
  MCP's Streamable HTTP transport: `claude mcp add --transport http`), each
  call as the bearer token's principal through the registry's `principal`
  hook, behind the router's `allowedOrigins`: never write an MCP transport
  of your own for agents that bring a token.
- An app's own MCP route, or an in-process assistant, that signs the
  caller in itself (with `requireSession`, say) passes that caller to the
  registry: `registry.callMethod(service, method, input, { request, principal })`.
  The registry's `principal` hook is not asked (`null` calls anonymously),
  the `context` hook and bound arguments see that principal, and its grants
  load as `qd.caller`'s do. Never take it from a request body, and never
  smuggle the user to the hook some other way (a map keyed by the request).
- Never `verifyJWT` alone: it checks the signature and expiry, not the
  session store.
- A custom `authenticate` takes the session cookie only from
  `request.sessionCookie` (HTTP), after `cookieOriginAllowed(request,
allowedOrigins)`, and checks it with `liveSession`; `auth.token` holds
  only a bearer token for it.
- `authenticate` refuses credentials only by throwing
  `QuickdrawError("UNAUTHENTICATED")` (or `"FORBIDDEN"`), and lets an
  anonymous caller in by returning `null`. Anything else it or
  `loadServiceAccess` throws is an outage (the store or the database
  down): a socket's handshake is refused `INTERNAL`, and the client keeps
  the user and connects again by itself, and an HTTP call is answered
  `INTERNAL` (500). Never throw a plain `Error` for bad credentials, which
  the client would retry for ever: the server warns
  `[quickdraw:authenticate-threw]` in development, and lint's
  `no-plain-error-refusal` reports one thrown in an `authenticate` (or
  `socketAuth`'s `loadPrincipal`, which refuses by returning `null`)
  written where the server is made.
- The MCP registry's `principal` hook refuses a token the same way: a
  `QuickdrawError("UNAUTHENTICATED")` (or `"FORBIDDEN"`) fails the call
  `UNAUTHENTICATED` (401 over HTTP), and anything else it throws is an
  outage, answered `INTERNAL` (500), never a refused token. `bearerAuth`
  refuses that way. Never throw a plain `Error` there for a bad token, which
  the agent would get as `INTERNAL`: the registry warns
  `[quickdraw:mcp-principal-threw]` in development, and
  `no-plain-error-refusal` reports one thrown in a hook written where the
  registry is made.

## Writes are tracked; frames are derived

Entity frames, collection deltas and change topics are computed from the
writes made through `db`, after the response is sent:

- Write through the handler's `db` (it may return `db.task.update(...)`
  unawaited). In a job, script or webhook, import the tracked client and
  wrap the work in `qd.run(async (ctx) => ...)`, which flushes before it
  returns; a boot-time seed may run it before `createServer` too (its writes
  then reach no subscriber). Never write through the untracked client.
- A helper that writes takes the tracked client by its type:
  `client: Tracked<PrismaClient>`, or `TrackedTransaction<PrismaClient>`
  when it may run inside `db.$transaction(async (tx) => ...)` (`tx` is
  one, and so is `db`). `trackPrisma` returns a `Tracked<PrismaClient>`;
  the untracked client is none, so passing it is a type error. Both types
  are on `@fitzzero/quickdraw-core/prisma` and the root export. Never type
  such a parameter `PrismaClient`, which the untracked client is too;
  `no-untracked-write` reads the type, whatever the parameter's name, on a
  destructured binding (`{ db }: { db: Tracked<PrismaClient> }`) and a
  class member (`private readonly prisma: Tracked<PrismaClient>`) as well.
  Import the type from quickdraw itself: lint does not read an alias of
  your own, nor a re-export from your own module. A
  `db` declared `PrismaClient` (a lazy `Proxy`, say) carries no mark:
  declare it `Tracked<PrismaClient>` to pass it to such a helper.
- Background work a handler starts and does not await (a push sent after
  the reply) runs in `qd.run(fn, { detached: true })`: a unit of its own,
  flushed when `fn` settles. Without `detached` it joins the handler's unit,
  which may have flushed already, and its writes flush as ambient. Catch
  what the promise rejects with.
- Never emit by hand: no `io.emit`, `socket.emit` or `qd:` event names.
- List the other models a service writes: `writes: ["taskLabel"]`.
- Nested writes (`data: { labels: { create: [...] } }`) are not tracked:
  write each model through its own delegate, inside an interactive
  `db.$transaction(async (tx) => ...)` when they must commit together.
- Inside `db.$transaction(async (tx) => ...)`, write through `tx`, and
  nest through `tx.$transaction(async (inner) => ...)`: a savepoint, whose
  writes are sent only if it and the transaction around it commit (a
  rolled-back savepoint's are dropped, even when the outer one catches and
  commits). Work on `db` there (a write, or a `db.$transaction` of its own)
  runs outside the transaction and commits on its own, and its frames are
  sent whatever the transaction does: write through `tx` what must commit
  or roll back with it. `tx` writes to its own transaction wherever it is
  used, and is refused once that transaction ended; never keep it past its
  callback. On PGlite, with one connection, work on `db` inside a callback
  waits for the transaction to end. A `ctx.touch` in the callback joins the
  transaction: touch a root `db.$executeRaw` after the callback.
- Raw SQL writes and database cascades are not seen: record them with
  `ctx.touch("task", ids)` (`{ removed: true }` for deleted rows); `qd.run`
  passes `fn` the same `touch`. Before deleting a row whose dependents the
  database deletes or clears (`onDelete: Cascade`, `SetNull`), delete or
  clear them through `db` first, in the same transaction, so the lists
  holding them are told; for the admin kit, in its `prepare`.
- A write to one row that changes how another service's row looks (a
  parent's counts) declares `affects: [{ service: task, id: "parentTaskId" }]`.

## Collections

A contract collection has `scope` (a string column, or
`via({ model, entry, scope })` for a junction table), `item`, `order` (ending
in `id`), and optionally `where`, `limit`, `maxLimit`, `index` (small fields
sent for the whole scope), `views` (`(row, who) => boolean` over index rows)
and `access`. The service says who may open a scope: `{ anchor: project }`
(the level on the row the scope value names) or `{ scopeAccess: "self" }`
(the subscriber's own user id), plus `requires: { service: "Read" }` when
the list must need the service-wide grant its methods ask for
(`{ scopeAccess: "self", requires: { service: "Read" } }`: the user's own
rows, for holders of the Read grant); both checks then apply, and a socket
whose grants reload below it leaves the scope. Everyone in an anchored scope sees every
item, so derive the item service's access from the anchor (`inherit`); a
self scope's items follow the item service's policy, so its user gets only
the rows they may read. A `via` scope over the item service's own `members`
table counts only links whose role gives at least the collection's
`access`. An item that reads its `via` junction (a member count) declares
`via({ model, entry, scope, refreshEntry: true })`, or the count goes stale
in every scope but the one a membership write links.

## Kits instead of hand-written CRUD

Before writing `get`, `list`, `create`, `update`, `delete`, `search`,
sharing or admin methods by hand, use the kit: it checks access on every row
it touches, pages, filters by declared fields and stays live. Lint's
`prefer-kit` warns on a hand-written method a kit implements (`get`,
`list`, `create`, `getTask`, `listTasks`, `createTask`, `share`,
`adminList`, ...) in a service that spreads no kit, and on one that
duplicates what a kit spread beside it serves (a `getNote` beside a crud
kit whose `access` names `get`: call the kit's `get`); when one must stay
hand-written, say why right above it:
`// quickdraw: hand-written because it answers null for a missing task`.
Contract halves come from `@fitzzero/quickdraw-core`, handlers from
`@fitzzero/quickdraw-core/server`, spread into `methods`:

- `crud.contract({ entity, get: true, list: { item, filter, sort }, create: { input }, update: { input }, delete: true })`
  (also `getMany`, `reorder`, `bulkUpdate`, `bulkDelete`) with
  `crud.handlers(task, { access: { get: { entry: "Read" }, ... }, prepare })`.
- `search.contract({ entity, fields, item?, scope? })` with `search.handlers(task, { access })`.
- `sharing.contract({ mode: "acl" | "members" })` with `sharing.handlers(project)`,
  on a service whose policy has a `jsonAcl` or `members`.
- `admin.contract({ entity })` with `admin.handlers(task)` (`{ service: "Admin" }` by default).
  Name what an admin may change with `editable: ["title", "status"]` (on
  `admin.contract` too, so the input schemas and MCP tools name only those):
  every other field is read-only, and a write naming one is `VALIDATION`.
  Without it the kit writes every field it shows but `id` and the
  timestamps, owner and foreign-key columns included. No kit ever writes a
  relation field or a nested write (`{ connect }`, `{ update }`): either is
  `VALIDATION`, whoever the caller, and `adminMeta` shows a relation field
  (one a projection selects with a nested select) as read-only.
  On a users service, `admin.handlers(user, { grants: true })` lets the admin
  screen edit `serviceAccess` (or the column `auth.serviceAccessSource`
  names, whatever its name) through `adminUpdate` (service-wide Admins
  only); never hand-write a `setServiceAccess` method for it. A dispatcher
  made without `createServer` (HTTP only, an MCP process) names that column
  as `createDispatcher({ serviceAccessSource })`. Without
  `grants: true` the kit hides that column. `adminMeta`
  marks that field `kind: "grants"`; an app with a grants editor of its own
  keeps it out of the generic form with
  `fieldOverrides: { serviceAccess: { showInForm: false } }`. What an admin
  edit must set off goes in `admin.handlers(task, { onWrite })`, which
  runs in the edit's transaction (an audit row that commits with it), or
  `onCommitted`, which runs once it committed, in a unit of its own (a
  game applying an edited definition to its running simulation, so a
  rolled-back edit is never applied); never wrap the kit's handlers.
  What must happen before an edit goes in `prepare(call, ctx, db)`, in
  the same transaction: a column the server computes (a content hash) is
  returned from it and written over the caller's data, even a hidden or
  read-only one (never `id`, a timestamp or a relation; a parent it sets
  needs the caller's row level on it, as in the read/write kit), so it
  need not be an editable field of the entity; and before an `adminDelete`
  it deletes or clears through `db` the rows the database would cascade,
  so their subscribers and lists are told. A cascade too large for
  Prisma's five-second transaction (a user's delete clearing their rows in
  every service) gets `transaction: { timeoutMs }` beside `prepare`, never
  a hand-written delete method. The statements of `prepare` and `onWrite`
  get the development checks a handler's do.

## Realtime

- Streams: `streams: { logs: { item, scope: "taskId", seed: 50, access } }`;
  push with `qd.stream(task, "logs").push(taskId, item)`, and several items
  at once with `pushMany(taskId, items)`, never `push` in a loop. A job that
  skips feeds nobody watches asks
  `await qd.stream(task, "logs").subscribers(taskId)` (the sockets on every
  node), never Socket.IO's adapter rooms, which hold one node's. When the
  items are deltas (a game's ticks), give the service a computed seed,
  `streams: { world: { seed: (worldId, ctx) => [snapshotOf(worldId)] } }`,
  never a bootstrap call beside the stream; `validate: "development"` there
  skips the per-item schema check in production for a hot stream. A
  `volatile: true` stream drops an item for a socket only while 64 wait on
  its connection: of a burst, a socket on a free connection gets 65 (one
  goes at once) and the rest are dropped until the connection sends what
  waits, so push one snapshot instead of a bigger burst. A feed
  only a room's sockets may read takes `access: { room }`, never an entry
  policy that repeats the room's membership: a scoped stream computes the
  room from its scope, ``{ room: (worldId) => `world:${worldId}` }``, and
  only a global stream names it or takes `{ prefix }` (on a scoped stream
  those would let a socket in one world read every world, so
  `defineContract` refuses them).
- A query over a model the service only `writes` (no service owns it)
  declares `watch: { service: ["gameScore"] }`, naming the models it reads
  (the service's `model` and its `writes`), with `watchAccess` on the
  service; never an app event the client invalidates by hand. `watch:
"service"` re-reads after a write to any of them (a chat membership the
  same service writes included), so use it only for a query over all.
- Channels: `channels: { cursor: { payload, ratePerSecond, requires } }` in
  the contract, `channels: { cursor: (payload, ctx) => ... }` on the service.
  `requires` is what the sending socket must hold: `{ entity: "taskId" }` (a
  subscription to the row the payload's key names), `{ collection, scope }`,
  or an app room a method joined that socket to: `{ room: "world" }` names
  the room itself (not a payload key), ``{ room: (p) => `lobby:${p.lobbyId}` }``
  computes it, `{ room: { prefix: "world:" } }` takes any room with that
  prefix. The handler reads the matched room as `ctx.room`; never repeat a
  world's id in every input frame. 4.x's `requireRoom` becomes `{ room }`.
  Give every channel a `requires`: without one any signed-in user may send
  it, about any room its payload names, and the server warns
  `channel-without-requires`. A handler that relays a message emits to
  `ctx.room`, never to a room built from the payload. Only when any
  signed-in user may send it, say so on the service:
  `channels: { ping: { access: "authenticated", handler } }`.
- A game loop asks `qd.rooms.size(room)` (this node's sockets, spectators
  included, synchronous) at its tick rate, never Socket.IO's adapter;
  `ctx.socketId` names the calling socket in a method.
- Peer links: `createServer({ peers: true })` lets two clients of an app
  room link directly (`createPeerLink` on the client). The server forwards
  their signals and relays their messages only between signed-in sockets
  of the room, and ends a player's links when they leave it or
  `rooms.leave(room, { userId })` takes them out. Tell players each other's
  socket ids with an event or a method's answer (`ctx.socketId`). The
  server never sees what a link carries: a method that records what a
  client reports from a link (a score, a winner) checks it as untrusted
  input, and its contract's `describe` says so.
- Host mode: a channel or stream declared `serve: "host"` is served by the
  room's host, one player's client (`defineHost` on the client), over peer
  links; the server needs `peers: true` and never handles it. A
  host-served channel declares `requires: { room }` and a host-served
  stream a scope and `access: { room: (scope) => room }`. Give a
  host-served channel no handler and a host-served stream no options or
  seed: `defineService` refuses them. Pick the host in a method,
  `ctx.rooms.setHost(room)` for the calling socket (after a check of the
  app's own: a seat, a role), never by election; read it with
  `ctx.rooms.hostOf(room)`, clear it with `clearHost(room)`, and decide
  what follows in `onHostLeave({ room, socketId, principal, reason })`.
  Behind a cluster adapter, a node that dies without closing its sockets
  leaves the hosts it held recorded on the other nodes until each room's
  host is set or cleared again, and no `onHostLeave` runs for them. So
  when the app picks a host only while `hostOf(room)` is `null`, also let
  a player take over a host that stops answering: a method that calls
  `setHost(room)` or `clearHost(room)` after a timeout of the app's own.
  The server never sees what a host and its players send each other: what
  a host reports to a method (a result, a score) is one player's word,
  checked as untrusted input, and the contract's `describe` says so. The
  service's `kinds` does not reach host-served members: any signed-in
  socket of the room can link to the host, so guard the method that joins
  the room.
- Events: `events: { moved: { payload } }`, sent with
  `ctx.rooms.emit(room, task, "moved", payload)` to an app room
  (`ctx.rooms.join(room)` in a method puts the caller's socket in one), and
  to a user's sockets with `ctx.rooms.emitToUser(userId, ...)`, never
  `emit("user:...")` (refused, as are `qd:` rooms). Name app rooms with a
  prefix (`doc:${id}`), never a bare 20-character id: a name with the shape
  of a Socket.IO socket id is refused.
  Code that is not a handler (a game loop, a timer, a job) sends with
  `qd.rooms.emit(room, task, "moved", payload)`; never keep the `io` server
  to emit by hand.
- When a user loses the right to a room (removed from a chat, kicked from a
  game), `await ctx.rooms.leave(room, { userId })` (or `qd.rooms.leave`)
  takes all their sockets out on every node, before anything they must not
  hear is sent; a sharing kit's `onChange` does it for a user a change left
  below the room's join check (`change.after === null`, or with custom
  `members` `levels`, a role below that level too), inside the change's
  transaction (a join racing the commit can put them back until they
  disconnect). 4.x's "emit to the user instead of the room" workaround is
  not needed.
- React to a socket leaving with the service's own `onRoomLeave`
  (`defineService(game, { onRoomLeave })`, beside `methods`), never with
  `socket.on("disconnect")` or a hook each server root must remember:
  every server the service runs in (tests and benchmarks too) runs it once
  per socket in a unit of work of its own, and each room carries `last`
  (the user's last socket there, on any node), which is when a 4.x
  `playerLeft` fires. `createServer({ onRoomLeave })` is for a hook of the
  whole app.

## Performance

Bound every `findMany` with `take`; batch per-item reads with `in:` filters;
filter in `where`, not after loading. Write many rows in one statement when
they all get the same data (`updateMany`, `createMany`); a large insert may
go in fixed-size `createMany` chunks, which neither `no-db-call-in-loop` nor
the N+1 warning counts. When each row's data differs, loop over the rows
inside an interactive
`db.$transaction(async (tx) => ...)` and await one `tx.task.update(...)` by
id per row, not an array-form `$transaction([...])`, which cannot read a
moved row inside its batch. A projection's relation count selects the
relation's ids (`labels: { select: { id: true } }`) and counts them in
`map`, never `_count`, which Prisma compiles to a `GROUP BY` over the whole
relation table on every read; a huge relation gets a counter column.
"Make sure this row exists" is `db.x.upsert({ where, create, update: {} })`:
it costs one read when the row is there and signals nothing, so a page load
or a reconnect that re-ensures a membership sends no frame. A write that
matches no row or has nothing to write (`data: {}`) signals nothing; every
other write signals, one that sets a column to the value it already holds
too, so re-ensure a row with that upsert rather than by writing its values
again.
`share: "caller"` for hot queries (`"all"` only for a result that depends
on the input alone); `versionColumn: "updatedAt"` answers "not modified"
cheaply, for a query whose form checked the row its `id` names (an `entry`
form on `id`), or that says `rowless: true` under a form that checks no
row. The quickdraw lint rules enforce most of this file (`no-untracked-write`,
`no-foreign-write`, `no-nested-write`, `no-raw-sql-write`, `no-manual-emit`,
`no-unbounded-read`, `no-db-call-in-loop`, `no-load-then-filter`,
`prefer-kit`): fix the code, not the rule. In development the server also
names a client loop: `[quickdraw:repeated-call]` when one connection calls
a method with the same input more than 10 times within a second, or is
refused `RATE_LIMITED` more than 30 times within a minute. Find the client
code that repeats it (quickdraw-client.md); never raise the rate limit to
quiet it.
