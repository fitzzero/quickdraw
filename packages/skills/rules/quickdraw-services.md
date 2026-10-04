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
  entity: taskSchema, // the full row; every row schema has `id: string`
  projections: { card: cardSchema }, // named lean shapes; "entity" is implicit
  fields: { notes: "Admin" }, // the level a caller needs to receive a field
  methods: {
    rename: mutation({ input: renameSchema, output: "entity", describe: "Renames a task." }),
    count: query({
      input: z.object({ projectId: z.string() }),
      output: z.number(),
      watch: { collection: "board", scope: (input) => input.projectId },
    }),
  },
  collections: { board: { scope: "projectId", item: "card", order: byOrdinal } }, // ends in "id"
});
```

- Every method is `query` or `mutation`, with `input` and `output`. `output`
  is a schema or a projection: `"entity"`, `"card"`, `nullable("entity")`,
  `listOf("card")`. Only a query may `watch`.
- Schemas are any Standard Schema. Use Zod 4.2 or later: MCP tools, the admin
  kit, projection keys and `quickdraw-docs` read their JSON Schema.
- Methods, collections, streams, channels and events share one namespace
  (`qd.<service>.<name>` on the client). `subscribe`, `unsubscribe`, `call`,
  `then`, `useEntity`, `useEntities`, `admin` and `$`-names are reserved.
  A contract without `entity` is an RPC-only service.

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
  `ctx`). `db` is `trackPrisma(new PrismaClient({ adapter }))` from
  `@fitzzero/quickdraw-core/prisma`, applied as the last extension.
- `methods` implements exactly the contract's methods; each is
  `{ access, handler }`, plus `timeoutMs`, `rowless` (see
  quickdraw-access.md), and for queries `share` (`"caller"` or `"all"`),
  `ttlMs` and `version`.
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

## Writes are tracked; frames are derived

Entity frames, collection deltas and change topics are computed from the
writes made through `db`, after the response is sent:

- Write through the handler's `db` (it may return `db.task.update(...)`
  unawaited). In a job, script or webhook, import the tracked client and
  wrap the work in `qd.run(async (ctx) => ...)`, which flushes before it
  returns. Never write through the untracked client.
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
- Raw SQL writes and database cascades are not seen: record them with
  `ctx.touch("task", ids)` (`{ removed: true }` for deleted rows); `qd.run`
  passes `fn` the same `touch`.
- A write to one row that changes how another service's row looks (a
  parent's counts) declares `affects: [{ service: task, id: "parentTaskId" }]`.

## Collections

A contract collection has `scope` (a string column, or
`via({ model, entry, scope })` for a junction table), `item`, `order` (ending
in `id`), and optionally `where`, `limit`, `maxLimit`, `index` (small fields
sent for the whole scope), `views` (`(row, who) => boolean` over index rows)
and `access`. The service says who may open a scope: `{ anchor: project }`
(the level on the row the scope value names) or `{ scopeAccess: "self" }`
(the subscriber's own user id). Everyone in a scope sees every item, so
derive the item service's access from the anchor (`inherit`). An item that
reads its `via` junction (a member count) declares
`via({ model, entry, scope, refreshEntry: true })`, or the count goes stale
in every scope but the one a membership write links.

## Kits instead of hand-written CRUD

Before writing `get`, `list`, `create`, `update`, `delete`, `search`,
sharing or admin methods by hand, use the kit: it checks access on every row
it touches, pages, filters by declared fields and stays live. Lint's
`prefer-kit` warns on a hand-written method a kit implements (`get`,
`list`, `create`, `getTask`, `listTasks`, `createTask`, `share`,
`adminList`, ...) in a service that spreads no kit; when one must stay
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
  On a users service, `admin.handlers(user, { grants: true })` lets the admin
  screen edit `serviceAccess` through `adminUpdate` (service-wide Admins
  only); never hand-write a `setServiceAccess` method for it.

## Realtime

- Streams: `streams: { logs: { item, scope: "taskId", seed: 50, access } }`;
  push with `qd.stream(task, "logs").push(taskId, item)`, and several items
  at once with `pushMany(taskId, items)`, never `push` in a loop.
- Channels: `channels: { cursor: { payload, ratePerSecond, requires } }` in
  the contract, `channels: { cursor: (payload, ctx) => ... }` on the service.
  `requires` is what the sending socket must hold: `{ entity: "taskId" }` (a
  subscription to the row the payload's key names), `{ collection, scope }`,
  or an app room a method joined that socket to: `{ room: "world" }` names
  the room itself (not a payload key), ``{ room: (p) => `lobby:${p.lobbyId}` }``
  computes it. 4.x's `requireRoom` becomes `{ room }`.
- Events: `events: { moved: { payload } }`, sent with
  `ctx.rooms.emit(room, task, "moved", payload)` to an app room
  (`ctx.rooms.join(room)` in a method puts the caller's socket in one).
  Code that is not a handler (a game loop, a timer, a job) sends with
  `qd.rooms.emit(room, task, "moved", payload)`; never keep the `io` server
  to emit by hand.
- When a user loses the right to a room (removed from a chat, kicked from a
  game), `await ctx.rooms.leave(room, { userId })` (or `qd.rooms.leave`)
  takes all their sockets out on every node, before anything they must not
  hear is sent. 4.x's "emit to the user instead of the room" workaround is
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
they all get the same data (`updateMany`, `createMany`). When each row's
data differs, loop over the rows inside an interactive
`db.$transaction(async (tx) => ...)` and await one `tx.task.update(...)` by
id per row, not an array-form `$transaction([...])`, which cannot read a
moved row inside its batch. A projection's relation count selects the
relation's ids (`labels: { select: { id: true } }`) and counts them in
`map`, never `_count`, which Prisma compiles to a `GROUP BY` over the whole
relation table on every read; a huge relation gets a counter column.
`share: "caller"` for hot queries;
`versionColumn: "updatedAt"` answers "not modified" cheaply. The quickdraw
lint rules enforce most of this file (`no-untracked-write`,
`no-foreign-write`, `no-nested-write`, `no-raw-sql-write`, `no-manual-emit`,
`no-unbounded-read`, `no-db-call-in-loop`, `no-load-then-filter`,
`prefer-kit`): fix the code, not the rule. In development the server also
names a client loop: `[quickdraw:repeated-call]` when one connection calls
a method with the same input more than 10 times within a second, or is
refused `RATE_LIMITED` more than 30 times within a minute. Find the client
code that repeats it (quickdraw-client.md); never raise the rate limit to
quiet it.
