# Migrating a quickdraw 4.x app to 5.0

5.0 rebuilds the parts of quickdraw a 4.x app is written against: services
are declared as `qd.defineService(contract, { ... })` objects instead of
`BaseService` classes, every service starts from a contract in the shared
package, access is declared per method and decided by one row policy, frames
and deltas follow tracked writes instead of hand emits, and the web app calls
a typed client instead of string-named hooks. The concepts carry over: a
service, its methods, levels, rooms, collections, channels. The design record
is [`docs/rfcs/0003-v5.md`](docs/rfcs/0003-v5.md); section 15 lists every
4.x API and what replaces it, and this guide takes them one at a time.

Most of the move is mechanical, and `@fitzzero/quickdraw-codemod` does it:
run it first, then work through the report it writes. This guide explains
each kind of item the report lists, the defaults that changed, and how to
keep 4.x clients working while you ship.

- [Before you start](#before-you-start)
- [Run the codemod](#run-the-codemod)
- [Work through the report](#work-through-the-report)
- [4.x to 5.0, one API at a time](#4x-to-50-one-api-at-a-time)
- [Boards: from a watched query to a collection](#boards-from-a-watched-query-to-a-collection)
- [Hand-built auth to the auth routes kit](#hand-built-auth-to-the-auth-routes-kit)
- [Defaults that changed](#defaults-that-changed)
- [Running 4.x and 5.0 clients together](#running-4x-and-50-clients-together)
- [Lint, skills and agents](#lint-skills-and-agents)
- [Splitting large services](#splitting-large-services)
- [Order of the migrations](#order-of-the-migrations)
- [Every removed 4.x name](#every-removed-4x-name)

## Before you start

- **Node 24** or later, which 5.0 requires.
- **Prisma 7.** The tracked-writes adapter (`trackPrisma` from
  `@fitzzero/quickdraw-core/prisma`) wraps a Prisma 7 client; every quickdraw
  app is on Prisma 7 already.
- **Zod 3.25** or later for validation: 5.0 validates through Standard
  Schema, which Zod 3.25 implements, so existing schemas keep working. **Zod
  4.2** or later where 5.0 reads a schema's JSON Schema: MCP tools, the admin
  kit's field metadata, a projection's keys, and `quickdraw-docs`. A Zod 3
  schema there fails when the service or the MCP registry is built, naming
  the method.
- **The peers' new floors.** 5.0's optional peer dependencies start
  higher than 4.1's: `react` `^19.0.0` (4.1: `>=18.0.0`),
  `@tanstack/react-query` `^5.20.0` (4.1: `>=5.0.0`), `socket.io` and
  `socket.io-client` `^4.8.0` (4.1: `>=4.0.0`), `@prisma/client` `^7.0.0`
  (4.1: `>=5.0.0`), `pg` `^8.13.0` (4.1: `>=8.0.0`) and
  `@electric-sql/pglite` `^0.3.16` (4.1: `>=0.3.0`). Upgrade the ones the
  app installs before the packages below.
- **A clean working tree.** The codemod rewrites files in place; review its
  changes as a diff.

Then upgrade the packages:

```bash
bun add @fitzzero/quickdraw-core            # in every package that imports it
bun add -d @fitzzero/quickdraw-lint @fitzzero/quickdraw-skills oxlint
```

The shared package now holds the contracts, so it needs `zod` among its
dependencies when it did not have it.

## Run the codemod

From the app's repository root:

```bash
bunx @fitzzero/quickdraw-codemod v5 . --dry-run   # what it would change
bunx @fitzzero/quickdraw-codemod v5 .
```

It expects the template's layout (`packages/shared`, `apps/api`, `apps/web`,
and `packages/db` exporting `prisma`); `--shared`, `--api`, `--web` and
`--db-package` move each part. It changes nothing it cannot translate
faithfully. What it does:

- **Contracts.** For each 4.x method map (`interface ChatServiceMethods`) it
  writes `packages/shared/src/contracts/<service>.ts` with
  `defineContract("<serviceName>", { methods })`, keeping the service name
  exactly (stored grants in `User.serviceAccess` name it). A method's
  `input` is the Zod schema its `defineMethod` passed as `schema:`, moved
  into the shared package with the helpers it uses (`cuidSchema`, say, into
  `contracts/helpers.ts`); without one, `todoSchema<Payload>()`. An output is
  `"entity"` (or `nullable("entity")`, `listOf("entity")`) when the 4.x
  response was the service's DTO, `todoSchema<Response>()` otherwise. A
  mutation of one row whose 4.x response was `DTO | null` answers `"entity"`,
  marked in the contract and above its handler: 4.x's `this.update` gave
  `null` for a missing row, a tracked write throws `NOT_FOUND` instead
  (though under an `{ entry }` access form the missing row is refused
  `FORBIDDEN` before the handler runs), and only an exact `"entity"`
  output is optimistic by default. The
  entity is `todoSchema<DTO>({ keys })`, the DTO's fields. A method is a
  `query` when its name starts with get, list, search, find or count, or the
  web app reads it with `useServiceQuery`, and a `mutation` otherwise.
  `contracts/index.ts` exports the `contracts` map the web client is built
  from, keyed by service name.
- **Services.** Each `class X extends BaseService<...>` (or
  `BaseRpcService`) becomes `export const x = qd.defineService(contract, ...)`
  in the same file, with its `model`, an `access` policy and `methods`. Each
  `defineMethod(name, level, handler, options)` becomes a method entry: the
  handler body is kept, `(payload, ctx)` becomes `({ input, ctx, db })`, `payload` becomes
  `input`, `ctx.userId` becomes `ctx.principal.userId`, `this.prisma`
  becomes the tracked `db`, and the template's `requireAuth(ctx)` guard goes
  where access already requires a principal. The access mapping is below.
  Helper methods and getters become module functions (a getter's reads call
  it: `this.enabled` is `enabled()`); overridden 4.x hooks,
  `defineCollection` options and `installAdminMethods` options stay in the
  file, marked. Each field becomes a marked module binding with its
  initializer (`const playingUsers = new Set<string>()`), and `this.x`
  reads it; the constructor's other code, the values it gave fields
  included, goes into an exported `setUp<Service>(...)` function that takes
  the constructor's parameters it uses, marked: call it once where the
  server starts, or move each part. Only the Prisma client's field goes (it
  is `db`), and a field holding another 4.x service, whose uses are marked
  (`ctx.services` replaces it). A call of the 4.x base class
  (`super.unsubscribe(...)`) is dropped under a marker naming it, since
  `super` outside a class does not parse. A split service's method modules
  keep their files, with typed method objects (see
  [Splitting large services](#splitting-large-services)).
- **The web app.** `useService`, `useServiceQuery`, `useSubscription` and
  `useCollection` calls become `qd.<service>.<method>.useMutation()`,
  `.useQuery(input)`, `qd.<service>.useEntity(id)` and
  `qd.<service>.<collection>.useCollection(scope)`, whether the call reaches
  quickdraw directly or through the template's typed wrappers
  (`hooks/useService.ts`), which it deletes once nothing uses them, with a
  file of types only they imported (`hooks/service-types.ts`). A local type
  that only a rewritten hook's type arguments named goes, a one-argument
  `UseCollectionResult<Item>` gets 5.0's second argument, and an import left
  holding only types becomes `import type`.
- **Other uses of a service class.** Its import becomes one of the service
  object, `new ChatService(prisma)` becomes `chatService` (marked: the
  server takes services in `qd.createServer({ services })`) and the class
  as a type `typeof chatService`. Where the file already binds that name
  (`const chatService = new ChatService(prisma)`, a parameter
  `pushService: PushService`), the object is imported under an alias
  (`chatService as chatServiceDef`). Every use of a 4.x instance's members
  (`pushService.resubscribe(...)`, `gameService.sim`), a dynamic `import()`
  of a service class and the `new` after it are marked.
- **Every workspace package that depends on quickdraw**, not only the three
  above (a database package's test helpers, say): `@fitzzero/quickdraw-core/server/testing/prisma`
  becomes `@fitzzero/quickdraw-core/testing/prisma` (the same functions),
  and the rest of the 4.x API there is marked.
- **New files**: `apps/api/src/db.ts` (`trackPrisma(prisma)`),
  `apps/api/src/quickdraw.ts` (`initQuickdraw<AppTypes>()`) and
  `apps/web/src/lib/quickdraw.ts` (`createQuickdrawClient(contracts)`).
- **Template carve-outs.** A service whose 4.x code sat between a template
  carve-out's comments (`quickdraw-game:start` and `quickdraw-game:end`,
  around its `ServiceMethodsMap` entry) keeps them: its lines in
  `contracts/index.ts` sit between the same comments, and its new contract
  file carries a `[carve-out]` marker, so a fork that strips the carve-out
  can delete it too. An entity key the 4.x DTO declares inside a carve-out
  (a game-only `isGuest` on `UserDTO`) keeps the carve-out's comments
  around it in the contract's `keys`.
- **Formatting.** It formats every file it writes, the report too, with the
  app's formatter (oxfmt, prettier or Biome, when the root `package.json`
  has it and it is installed), so the output passes the app's format check
  as it is written. Files the formatter's config ignores are left as
  written. A failure prints the formatter's exit code, its own error and the
  files it left unformatted.
- **The report.** Wherever a person has to decide, it leaves a
  `// quickdraw-migrate: review [kind] ...` marker on its own line above the
  code in question (a hook's `error` read as the 4.x message string among
  them: it is a `QuickdrawError` now), and writes
  `quickdraw-migration-report.md` at the root: every marker, with its file
  and line in the formatted file, grouped by kind. A dry run lists it as `A`
  (created) on the first run.

Running it again changes nothing at all, so delete each marker once its
item is done and run it again: the report is rewritten from the markers
that remain. Commit the output as it is, then adopt lint with a baseline
([Lint, skills and agents](#lint-skills-and-agents)): the output breaks
rules (unused 4.x hooks kept for review, say) until its markers are done.

### The access mapping

4.x checked a method's level in one of three ways, and the codemod writes
the 5.0 form that admits exactly the same callers:

| 4.x method                                                                                                   | 4.x admitted                                                            | 5.0 form                       |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- | ------------------------------ |
| `"Public"`                                                                                                   | everyone                                                                | `"public"`                     |
| any level, with a row id (`resolveEntryId`, or a payload with `id`, which 4.x read whenever it was a string) | a service grant at the level, or the row check (`checkEntryACL`, `acl`) | `{ service: L, entry: L, id }` |
| `"Read"` without a row id                                                                                    | every signed-in user                                                    | `"authenticated"`, marked      |
| `"Moderate"` or `"Admin"` without a row id                                                                   | a service grant at the level                                            | `{ service: L }`               |

The second row is never `{ entry: L }`: 4.x let a service grant pass a row
check, and dropping the `service` half would lock those users out. The
third is marked because a `Read` method that names no row was open to every
signed-in user in 4.x, which was rarely meant: narrow it to `{ service:
"Read" }`, an `entry` form, or a `scope` form when it was not. The service
gets the policy the forms need: `jsonAcl("acl")` for `hasEntryACL: true`
(4.x read the row's `acl` column), and a marked placeholder where 4.x
overrode `checkAccess` or `checkEntryACL`, which grants no row until you
port the override.

5.0 refuses, when a service with an access policy is defined, a method
whose input has `id` under a form that checks no row (`"public"`,
`"authenticated"`, `{ service: L }` below `Admin`): anyone the form admits
would reach any row by its id. A 4.x `"Public"` method that named a row is
that shape, and 4.x did let everyone call it, so the codemod writes
`rowless: true` beside its `"public"`, marked: the method still admits
exactly the 4.x callers, and the marker asks whether a lookup open to
anyone was meant. Keep `rowless: true` when it was (a public profile, a
lookup by an id that tells nothing); otherwise drop the flag and give the
method an `entry` form. An input that has no JSON Schema yet (a Zod 3 schema,
a `todoSchema`) is not checked, so the refusal can first appear when the
schema moves to Zod 4: it names the method and both ways out.

`jsonAcl` keeps 4.x's semantics but one: a user with several entries in a
row's list gets the highest of their levels, where 4.x's `checkEntryACL`
took the first entry (`[{ userId: "u1", level: "Read" }, { userId: "u1",
level: "Admin" }]` was `Read` and is `Admin`). The highest agrees with what
the list filters match; the codemod marks each `jsonAcl("acl")` it writes,
once per service, so check the stored lists for duplicate entries.

## Work through the report

In this order, because each step leans on the one before:

1. **Contracts.** Replace each `todoSchema` with a real schema (lint's
   `no-todo-schema` lists them), give the entity a schema, and check each
   method's kind: a query can be shared, cached and refetched; a mutation
   cannot. The codemod writes no `describe`, since 4.x had no per-method
   prose: write one for the contract and each method, collection, stream,
   channel and event (lint's `require-describe` lists them). MCP tools are
   described by them, and `quickdraw-docs` prints them.
2. **Access.** Decide the `"authenticated"` forms and the `rowless`
   flags, and port each access override into the service's policy.
3. **Emits.** Delete the hand emits once the writes go through `db` and the
   collections are declared; replace `this.create/update/delete` and the
   lifecycle hooks.
4. **Client.** Declare the collections the web app reads, and settle the
   hook options 5.0 dropped.

Then run lint (`no-v4-api` names every 4.x API that is left, with its
replacement) and the typecheck. The codemod's output typechecks against 5.0
apart from what its markers cover, so the remaining errors are the work
list.

## 4.x to 5.0, one API at a time

Each section is one row of section 15 of the design record. The 4.x code is
a small 4.1 app; the 5.0 code is that app migrated by hand to the end, past
the codemod's markers. Both compile: the 4.x examples against the published
4.1.0, the 5.0 examples against this release.

### Service classes become `qd.defineService`

A service is a contract plus a definition object: no class, no
constructor, no generics to keep in step. `defineService`'s types require
exactly the contract's methods, each with `access` and `handler`.

<!-- example: ../../../codemod/test/guide-v4/apps/api/src/services/task.ts#class -->

```ts
export class TaskService extends BaseService<
  Task,
  Prisma.TaskUncheckedCreateInput,
  Prisma.TaskUpdateInput,
  TaskServiceMethods,
  Record<string, never>,
  TaskDTO,
  TaskCollections
> {
  constructor(private readonly prisma: PrismaClient) {
    super({ serviceName: "taskService", hasEntryACL: true });
    this.setDelegate(prisma.task);
    this.initMethods();
  }
```

<!-- example: apps/api/src/services/migration/task.ts#service -->

```ts
import { inherit } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(taskContract, {
  // was setDelegate(prisma.task)
  model: "task",
  // was checkEntryACL: the caller's role on the task's project, now one policy for every surface
  access: inherit({ from: projectContract, via: "projectId" }),
  // was afterUpdate touching the project: send the project row again after each flush
  affects: [{ service: projectContract, id: "projectId" }],
  // a board opens with Read on its project
  collections: { byProject: { anchor: projectContract } },
  methods: {
    // quickdraw: hand-written because it answers null for a missing task, as 4.x did
    getTask: {
      // 4.x read payload.id implicitly, and a service grant passed too
      access: { service: "Read", entry: "Read", id: "id" },
      handler: ({ input, db }) => db.task.findUnique({ where: { id: input.id } }),
    },
    renameTask: {
      access: { service: "Moderate", entry: "Moderate", id: "id" },
      // tracked: subscribers get the frame, the board its delta; NOT_FOUND where this.update returned null
      handler: ({ input, db }) =>
        db.task.update({ where: { id: input.id }, data: { title: input.title } }),
    },
    archiveAll: {
      // "Admin" with no row id needed the service grant in 4.x too
      access: { service: "Admin" },
      handler: async ({ input, ctx, db }) => {
        const { count } = await db.task.updateMany({
          where: { projectId: input.projectId },
          data: { status: "archived" },
        });
        // was this.emitToRoom(serviceRoom(...), "task:archived", ...)
        ctx.rooms.emit(`project:${input.projectId}`, taskContract, "archived", {
          projectId: input.projectId,
        });
        return { count };
      },
    },
  },
  channels: {
    // was defineChannel: relay each cursor to the project's room
    cursor: (payload, ctx) => {
      ctx.rooms.emit(`project:${payload.projectId}`, taskContract, "cursorMoved", payload);
    },
  },
});
```

The contract it implements lives in the shared package:

<!-- example: packages/shared/src/migration/contracts.ts#contract -->

```ts
const cursorSchema = z.object({ projectId: z.string(), x: z.number() });

const taskEntity = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.string(),
  ordinal: z.number(),
  notes: z.string().nullable(),
});

export const taskContract = defineContract("taskService", {
  // new in 5.0: the codemod writes no describe; lint's require-describe lists each one missing
  describe: "Tasks on a project's board.",
  // was TaskDTO; a schema now, so it validates and lists its keys
  entity: taskEntity,
  // was getProtectedFields(): notes reach Moderate and up
  fields: { notes: "Moderate" },
  methods: {
    getTask: query({
      input: z.object({ id: z.string() }),
      output: nullable("entity"),
      describe: "Reads one task, or null.",
    }),
    renameTask: mutation({
      input: z.object({ id: z.string(), title: z.string().min(1) }),
      output: nullable("entity"),
      describe: "Renames a task, or answers null.",
    }),
    archiveAll: mutation({
      input: z.object({ projectId: z.string() }),
      output: z.object({ count: z.number() }),
      describe: "Archives every task of a project.",
    }),
  },
  collections: {
    // was defineCollection("byProject", ...): declared, so its deltas follow tracked writes
    byProject: {
      describe: "A project's tasks, by ordinal.",
      scope: "projectId",
      item: "entity",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
    },
  },
  // was QuickdrawEventMap and emitToRoom
  events: {
    archived: {
      payload: z.object({ projectId: z.string() }),
      describe: "A project's tasks were archived.",
    },
    cursorMoved: { payload: cursorSchema, describe: "Another user's cursor moved." },
  },
  // was defineChannel
  channels: { cursor: { payload: cursorSchema, describe: "Where a user's cursor is." } },
});
```

### `BaseRpcService` becomes a contract without `entity`

A service with no rows is a contract without an entity, implemented by a
service without `model`. Such a service may use `"public"`,
`"authenticated"`, `{ service }` and `custom` access, but no row forms.

<!-- example: ../../../codemod/test/guide-v4/apps/api/src/services/health.ts#rpc -->

```ts
import { BaseRpcService } from "@fitzzero/quickdraw-core/server";

export class HealthService extends BaseRpcService<HealthServiceMethods> {
  constructor() {
    super({ serviceName: "healthService" });
    this.defineMethod("ping", "Public", async () => ({ at: new Date().toISOString() }));
  }
}
```

<!-- example: packages/shared/src/migration/contracts.ts#rpc -->

```ts
// No entity: an RPC-only contract, the 5.0 form of a BaseRpcService
export const healthContract = defineContract("healthService", {
  describe: "Tells a caller the server is up.",
  methods: {
    ping: query({
      input: z.undefined(),
      output: z.object({ at: z.string() }),
      describe: "Answers with the server's time.",
    }),
  },
});
```

<!-- example: apps/api/src/services/migration/health.ts#rpc -->

```ts
// No model and no policy: a service without rows, as BaseRpcService was
export const healthService = qd.defineService(healthContract, {
  methods: {
    ping: { access: "public", handler: () => ({ at: new Date().toISOString() }) },
  },
});
```

### Method maps, `SubscriptionDataMap` and room unions are inferred

The hand-written maps that typed 4.x's hooks are gone: every type comes
from the contract (`InputOf`, `OutputOf`, `EntityOf`, `ItemOf` and the
rest, from the package root). Delete the maps once nothing imports them.

<!-- example: ../../../codemod/test/guide-v4/packages/shared/src/index.ts#maps -->

```ts
export interface TaskDTO {
  id: string;
  projectId: string;
  title: string;
  status: string;
  notes: string | null;
  createdAt: string;
}

export interface TaskServiceMethods {
  getTask: { payload: { id: string }; response: TaskDTO | null };
  renameTask: { payload: { id: string; title: string }; response: TaskDTO | null };
  archiveAll: { payload: { projectId: string }; response: { count: number } };
}

export interface ServiceMethodsMap {
  taskService: TaskServiceMethods;
}

export interface SubscriptionDataMap {
  taskService: TaskDTO;
}
```

<!-- example: packages/shared/src/contracts/examples.ts#types -->

```ts
// { id: string; title: string }
export type RenameInput = InputOf<typeof taskContract, "rename">;
// the entity, as the wire has it
export type Task = OutputOf<typeof taskContract, "get">;
// one item of the board
export type Card = ItemOf<typeof taskContract, "board">;
```

### `defineMethod` becomes `methods: { name: { access, handler } }`

The handler takes one argument, `{ input, ctx, db }`: the input after its
schema ran, the call's context (`ctx.principal`, `ctx.log`, `ctx.rooms`,
`ctx.signal`), and the tracked database client. The level and
`resolveEntryId` become the `access` form (see
[the access mapping](#the-access-mapping)); `schema` moves into the contract
as `input`.

<!-- example: ../../../codemod/test/guide-v4/apps/api/src/services/task.ts#methods -->

```ts
private initMethods(): void {
  this.defineMethod(
    "renameTask",
    "Moderate",
    async (payload, _ctx) => {
      const task = await this.update(payload.id, { title: payload.title });
      return task ? this.toDto(task) : null;
    },
    {
      schema: z.object({ id: z.string(), title: z.string().min(1) }),
      resolveEntryId: (p) => p.id,
    },
  );

  this.defineMethod("getTask", "Read", async (payload) => {
    const task = await this.prisma.task.findUnique({ where: { id: payload.id } });
    return task ? this.toDto(task) : null;
  });

  this.defineMethod("archiveAll", "Admin", async (payload) => {
    const { count } = await this.prisma.task.updateMany({
      where: { projectId: payload.projectId },
      data: { status: "archived" },
    });
    this.emitToRoom(serviceRoom("projectService", payload.projectId), "task:archived", {
      id: payload.projectId,
    });
    return { count };
  });

  this.verifyAllMethods(["renameTask", "getTask", "archiveAll"]);
}
```

The 5.0 methods are the `methods` object of the service above. Errors are
thrown as `QuickdrawError(code, message)`: anything else reaches the caller
as `INTERNAL` with a generic message, where 4.x sent the thrown message. The
codemod marks each `throw new Error(...)` in a handler `[error]`: give it the
code that fits wherever the caller should still see the message.

### `verifyAllMethods` is compile-time

`defineService` does not compile while a contract method is missing or an
extra one is present, and refuses them at run time too. Delete the call.

### `this.create`, `this.update`, `this.delete` and lifecycle hooks become `db` writes

The CRUD trio emitted the entity frame and the collection deltas and ran
the lifecycle hooks. In 5.0 every write through `db` is tracked: the frames
and deltas follow from the write itself, whatever method made it. Two
differences to keep in mind: `db.task.update` throws `NOT_FOUND` for a
missing row where `this.update` returned `null` (a method whose access is
`{ entry }` never gets that far: its caller is refused `FORBIDDEN` for a
row that does not exist, as for one they may not see), and nothing runs a
hook.
Move a hook's work into the methods that write, or into `affects` when it
only made another service's row send again.

<!-- example: ../../../codemod/test/guide-v4/apps/api/src/services/task.ts#writes -->

```ts
// Every write went through the CRUD trio, which emitted and ran the hooks
public async moveTask(id: string, projectId: string): Promise<boolean> {
  const moved = await this.update(id, { project: { connect: { id: projectId } } });
  return moved !== null;
}

protected override async afterUpdate(_before: Task | null, after: Task): Promise<void> {
  await this.prisma.project.update({ where: { id: after.projectId }, data: {} });
}

```

In the 5.0 service above, `renameTask` writes with `db.task.update` and
`affects` sends the project row again after each flush. Nested relation
writes (`project: { connect: ... }`), raw SQL and database cascades are not
tracked: write the foreign key itself, or record the rows with
`ctx.touch(model, ids)`. Jobs and scripts wrap their writes in `qd.run(fn)`.

### `emitUpdate`, `emitCollection*` and `notifyCollections` are gone

Frames and deltas are derived from tracked writes, so a hand emit sends
nothing 5.0 would not, and lint's `no-manual-emit` reports what remains.
Delete each one once its write goes through `db` and, for a collection, the
collection is declared. A reset is
`qd.collections.reset(contract, collection, scope)`, for a change tracked
writes cannot describe.

<!-- example: ../../../codemod/test/guide-v4/apps/api/src/services/task.ts#emits -->

```ts
public async touchTask(id: string): Promise<void> {
  const task = await this.prisma.task.update({ where: { id }, data: {} });
  this.emitUpdate(id, this.toDto(task));
  this.emitCollectionUpsert("byProject", task.projectId, this.toDto(task));
}
```

### `toDto`, `getProtectedFields` and `hasElevatedAccess` become projections and `fields`

Subscribers receive projections of the row: the entity, or a named
projection, selected by the projection's keys, with dates as ISO strings.
A computed field is a projection's `select` plus `map`. Protected fields
become the contract's `fields`, a minimum level per field, stripped per
subscriber after any shared run.

<!-- example: ../../../codemod/test/guide-v4/apps/api/src/services/task.ts#projection -->

```ts
protected override toDto(task: Task): TaskDTO {
  return {
    id: task.id,
    projectId: task.projectId,
    title: task.title,
    status: task.status,
    notes: task.notes,
    createdAt: task.createdAt.toISOString(),
  };
}

protected override getProtectedFields(): (keyof TaskDTO)[] {
  return ["notes"];
}
```

<!-- example: apps/api/src/services/examples/projections.ts#projections -->

```ts
import { crud, inherit } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  // answers "not modified" from the row's own time
  versionColumn: "updatedAt",
  // a write to a subtask sends its parent again
  affects: [{ service: task, id: "parentTaskId" }],
  project: {
    // a relation count: read with select, built by a pure, synchronous map. Read the relation's
    // ids, which Prisma fetches for the rows read only; its _count aggregates the whole TaskLabel
    // table (a GROUP BY over every row) on every snapshot and flush
    card: {
      select: { title: true, status: true, labels: { select: { id: true } } },
      map: (row: { id: string; title: string; status: string; labels: { id: string }[] }) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        labelCount: row.labels.length,
      }),
    },
  },
  methods: {
    // the kit's get reads the entity's keys only, and sends dates as ISO strings
    ...crud.handlers(task, { access: { get: { entry: "Read" } } }),
    // returns the database row `map` takes: the framework builds the card from it
    card: {
      access: { entry: "Read" },
      handler: ({ input, db }) =>
        db.task.findUniqueOrThrow({
          where: { id: input.id },
          select: { id: true, title: true, status: true, labels: { select: { id: true } } },
        }),
    },
  },
});
```

The 5.0 contract above declares `fields: { notes: "Moderate" }` where the
4.x service listed `notes` as protected. In the types a reader gets (the
data of `useEntity`, `useEntities` and `useCollection`, an `"entity"`
output, `EntityOf`, `ItemOf`), a tiered field is optional, since a reader
below its level receives the row without it: `task.notes` is
`string | null | undefined` there, so read it with a guard. A handler still
returns the whole row. A method whose output is a schema of its own sends
only the keys that schema declares, unstripped, so it must not declare a
tiered field: answer the entity or a projection instead. A 4.x DTO type
that kept protected fields optional by hand can become
`EntityOf<typeof taskContract>`.

A handler returns database rows for a projection output, and a Prisma `Json`
column, typed `JsonValue`, is accepted where the projection has an object,
an array or a record (`acl: [{ userId, level }]`); the output schema checks
its shape outside production.

### `checkAccess`, `checkEntryACL`, `checkBatchSubscriptionAccess` and `hasEntryACL` become policies

4.x decided row access in overridable methods, once for calls and again for
subscriptions. 5.0 asks one policy for every surface: method calls, entity
subscriptions, collection scopes, the kits' lists, searches, streams and
channels. The builders are `owner(field)`, `jsonAcl(field, { owner })`,
`members({ model, entry, user, level })`, `inherit({ from, via })`,
`anyOf(...)` and `resolver({ levelsFor, where, reads })` for anything else;
each answers a batch of rows in one query. A resolver declares what it reads
(`reads: { columns, memberships }`, or `"none"`), or its live rows are never
revoked when access changes, and the server warns
`[quickdraw:resolver-without-reads]`.

<!-- example: ../../../codemod/test/guide-v4/apps/api/src/services/task.ts#access -->

```ts
// Row access is the caller's role on the task's project
protected override async checkEntryACL(
  userId: string,
  taskId: string,
  requiredLevel: AccessLevel,
): Promise<boolean> {
  const task = await this.prisma.task.findUnique({
    where: { id: taskId },
    select: { project: { select: { members: { where: { userId }, select: { role: true } } } } },
  });
  const role = task?.project.members[0]?.role as AccessLevel | undefined;
  return role !== undefined && this.isLevelSufficient(role, requiredLevel);
}

protected override checkAccess(
  _userId: string,
  _entryId: string,
  _requiredLevel: AccessLevel,
  _socket: QuickdrawSocket,
): boolean {
  return false;
}
```

<!-- example: apps/api/src/services/examples/access.ts#access -->

```ts
import { anyOf, crud, custom, inherit, jsonAcl, members } from "@fitzzero/quickdraw-core/server";

export const projectService = qd.defineService(project, {
  // the Prisma model the rows live in
  model: "project",
  access: anyOf(
    // [{ userId, level }] plus Admin for the owner
    jsonAcl("acl", { owner: "ownerId" }),
    members({ model: "projectMember", entry: "projectId", user: "userId", level: "role" }),
  ),
  methods: {
    // the read/write kit's get: Read on the project itself
    ...crud.handlers(project, { access: { get: { entry: "Read" } } }),
    title: {
      // anyone may read any project's name by its id: the form is the whole check, on purpose
      access: "public",
      rowless: true,
      handler: async ({ input, db }) =>
        await db.project.findUniqueOrThrow({ where: { id: input.id }, select: { name: true } }),
    },
  },
});

export const taskService = qd.defineService(task, {
  model: "task",
  // the level on the task's project
  access: inherit({ from: project, via: "projectId" }),
  methods: {
    rename: {
      access: { entry: "Moderate" },
      handler: ({ input, db }) =>
        db.task.update({ where: { id: input.id }, data: { title: input.title } }),
    },
    // the kit's create: Moderate on the project the task goes into
    ...crud.handlers(task, {
      access: { create: { scope: "Moderate", of: project, id: "projectId" } },
    }),
    archiveAll: {
      access: { service: "Admin" },
      handler: async ({ db }) => (await db.task.updateMany({ data: { status: "archived" } })).count,
    },
    claim: {
      access: custom((ctx, input) => input.id.length > 0 && ctx.principal.kind === "user"),
      handler: ({ input, ctx, db }) =>
        db.task.update({ where: { id: input.id }, data: { assigneeId: ctx.principal.userId } }),
    },
  },
});
```

The 5.0 task service above replaces its `checkEntryACL` with
`inherit({ from: projectContract, via: "projectId" })`: the level on the
task's project, whose policy reads the membership table.

### `defineCollection` becomes contract `collections`

A collection is declared in the contract (`scope`, `item`, `order`, and for
boards `index` and `views`) and anchored in the service: the scope's
access comes from the anchor row's policy, or `scopeAccess: "self"` for a
scope that is the user's own id. Membership is declared, not computed, and
the deltas follow tracked writes; the snapshot, paging, resume and the
client's cache are the framework's.

<!-- example: ../../../codemod/test/guide-v4/apps/api/src/services/task.ts#collection -->

```ts
public registerBoard(): void {
  this.defineCollection("byProject", {
    resolveScopeId: (task) => task.projectId,
    checkScopeAccess: (userId, projectId) => this.isMember(userId, projectId),
    snapshot: (projectId, opts) => this.boardPage(projectId, opts),
  });
}

private async isMember(userId: string, projectId: string): Promise<boolean> {
  const member = await this.prisma.projectMember.findUnique({
    where: { projectId_userId: { projectId, userId } },
  });
  return member !== null;
}

private async boardPage(
  projectId: string,
  opts: { cursor: string | null; limit: number },
): Promise<CollectionSnapshotPage<TaskDTO>> {
  const rows = await this.prisma.task.findMany({
    where: { projectId },
    orderBy: { ordinal: "asc" },
    take: opts.limit,
  });
  return { items: rows.map((row) => this.toDto(row)), nextCursor: null, totalCount: rows.length };
}
```

The 5.0 contract above declares `byProject`, and the service anchors it on
the project. For a board, read [Boards](#boards-from-a-watched-query-to-a-collection).

### `kickFromCollection` is automatic revocation

A tracked write that lowers or removes someone's level on a scope's anchor
row removes their sockets from the scope and sends `qd:revoked`; the client
drops the scope. Delete the call.

<!-- example: ../../../codemod/test/guide-v4/apps/api/src/services/task.ts#kick -->

```ts
public async removeFromBoard(projectId: string, userId: string): Promise<void> {
  await this.prisma.projectMember.delete({
    where: { projectId_userId: { projectId, userId } },
  });
  await this.kickFromCollection("byProject", projectId, userId);
}
```

### `emitToRoom` and `QuickdrawEventMap` become contract `events`

A room event is declared in the contract with its payload schema, sent with
`ctx.rooms.emit(room, contract, event, payload)` (`emitToUser` for one
user) and received with `qd.<service>.<event>.useEvent(handler)`. Channels
(`defineChannel`) are declared the same way and handled in
`defineService`'s `channels`. A channel's `requireRoom` becomes
`requires: { room }` in the contract: `{ room: "world" }` for a fixed room,
`{ room: (payload) => ... }` for one the payload names, `{ room: { prefix:
"world:" } }` for any room with that prefix (the handler reads the matched
room as `ctx.room`). The sending socket must have joined that app room
through `ctx.rooms.join` in a method it called; a message that names no
room is dropped, where 4.x skipped the check. A room joined by a call
belongs to its socket, so a client joins again after every reconnect:
`useJoin(qd.game.watchWorld, input)` in React, where 4.x apps re-called
from an `isConnected` effect. 4.x's `unsubscribeSocket` and `unsubscribe`
overrides become the service's own `onRoomLeave(leave, ctx)` beside
`methods`, which every server the service runs in calls.

<!-- example: ../../../codemod/test/guide-v4/packages/shared/src/index.ts#events -->

```ts
declare module "@fitzzero/quickdraw-core" {
  interface QuickdrawEventMap {
    "task:archived": { id: string };
  }
}
```

The 5.0 contract above declares `events: { archived, cursorMoved }` and the
`cursor` channel; the service's `archiveAll` sends `archived`.

### `installAdminMethods` becomes the admin kit

`admin.contract({ entity })` in the contract and
`admin.handlers(contract, options)` in `methods`. Every admin method requires a service-wide `Admin`
grant; the field metadata comes from the entity's JSON Schema (Zod 4.2 or
later).

<!-- example: ../../../codemod/test/guide-v4/apps/api/src/services/task.ts#admin -->

```ts
public registerAdmin(): void {
  this.installAdminMethods({
    expose: { list: true, get: true, update: true },
    access: {
      list: "Admin",
      get: "Admin",
      create: "Admin",
      update: "Admin",
      delete: "Admin",
      setEntryACL: "Admin",
      getSubscribers: "Admin",
      reemit: "Admin",
      unsubscribeAll: "Admin",
    },
    displayName: "Tasks",
  });
}
```

<!-- example: packages/shared/src/kits/admin.ts -->

```ts
import { admin, defineContract } from "@fitzzero/quickdraw-core";
import { taskSchema } from "../schemas";

export const task = defineContract("taskService", {
  describe: "Tasks on a project's board.",
  // Zod 4.2 or later: the fields come from its JSON Schema
  entity: taskSchema,
  methods: {
    // adminList, adminGet, adminCreate, adminUpdate, adminDelete,
    // adminMeta, adminSubscribers, adminReemit; `expose` picks fewer
    ...admin.contract({ entity: taskSchema, filter: ["status"], sort: ["ordinal", "title"] }),
  },
});
```

<!-- example: apps/api/src/services/kits/admin.ts#service -->

```ts
import { admin, inherit } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  methods: {
    ...admin.handlers(task, {
      // the default: from the service name
      displayName: "Tasks",
      // never shown, returned or written
      hiddenFields: ["notes"],
      // the only fields adminCreate and adminUpdate write; the rest are read-only
      editable: ["title", "status"],
      fieldOverrides: { assigneeId: { type: "relation", relationService: "userService" } },
    }),
  },
});
```

### `ServiceRegistry` and `createQuickdrawServer` become `qd.createServer`

`qd.createServer({ app, services, db, auth })` attaches to the app's own
Express app and HTTP server and owns socket authentication, the user room,
the hello frame, disconnect cleanup and graceful shutdown. It never listens
or exits the process itself, and there is no default CORS origin.

<!-- example: ../../../codemod/test/guide-v4/apps/api/src/index.ts#server -->

```ts
import { ServiceRegistry } from "@fitzzero/quickdraw-core/server";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, { cors: { origin: "*" } });

const registry = new ServiceRegistry(io);
registry.registerService("taskService", new TaskService(prisma));
registry.registerService("healthService", new HealthService());

httpServer.listen(4000);
```

<!-- example: apps/api/src/services/migration/server.ts#server -->

```ts
// was new ServiceRegistry(io) plus registerService(...) per service
export const server = qd.createServer({
  app,
  services: [taskService, healthService],
  db,
  cors: { origin: ["https://app.example.com"], credentials: true },
  auth: { authenticate: ({ auth }) => verifySession(auth.token) },
  // 4.x clients keep calling `socket.emit("taskService:renameTask", ...)` until they update
  legacyWire: true,
});
```

### The client hooks become `qd.<service>.<member>`

One typed client, built from the contracts, replaces the string-named
hooks; a misspelled method, or a hook its kind does not have, is a compile
error. `useQuery` and `useMutation` are TanStack Query's, with
`QuickdrawError` as the error type. `<QuickdrawProvider client={qd} url auth>`
replaces the 4.x provider props (`serverUrl`, `authToken`, `autoConnect`).

<!-- example: ../../../codemod/test/guide-v4/apps/web/src/hooks.tsx#hooks -->

```tsx
import {
  useCollection,
  useService,
  useServiceQuery,
  useSubscription,
} from "@fitzzero/quickdraw-core/client";

export function TaskPanel({ taskId, projectId }: { taskId: string; projectId: string }) {
  const { data: task } = useSubscription<TaskDTO>("taskService", taskId);
  const { items } = useCollection<TaskDTO>("taskService", "byProject", projectId);
  const { data: health } = useServiceQuery<Record<string, never>, { at: string }>(
    "healthService",
    "ping",
    {},
  );
  const rename = useService<{ id: string; title: string }, TaskDTO | null>(
    "taskService",
    "renameTask",
  );
  return (
    <button type="button" onClick={() => rename.mutate({ id: taskId, title: "Renamed" })}>
      {`${task?.title ?? ""}: ${String(items.length)} on the board, up since ${health?.at ?? "?"}`}
    </button>
  );
}
```

<!-- example: apps/web/src/components/migration/TaskPanel.tsx#client -->

```tsx
import { createQuickdrawClient } from "@fitzzero/quickdraw-core/client";

// apps/web/src/lib/quickdraw.ts: keyed by service name, as the codemod writes it
export const qd = createQuickdrawClient({
  taskService: taskContract,
  healthService: healthContract,
});
```

<!-- example: apps/web/src/components/migration/TaskPanel.tsx#hooks -->

```tsx
export function TaskPanel({ taskId, projectId }: { taskId: string; projectId: string }) {
  // was useSubscription
  const { data: task } = qd.taskService.useEntity(taskId);
  // was useCollection
  const { items } = qd.taskService.byProject.useCollection(projectId);
  // was useServiceQuery
  const { data: health } = qd.healthService.ping.useQuery();
  // was useService
  const rename = qd.taskService.renameTask.useMutation();
  return (
    <button type="button" onClick={() => rename.mutate({ id: taskId, title: "Renamed" })}>
      {`${task?.title ?? ""}: ${String(items.length)} on the board, up since ${health?.at ?? "?"}`}
    </button>
  );
}
```

`useRoomEvents` and `useChannelSend` become members too:

<!-- example: ../../../codemod/test/guide-v4/apps/web/src/hooks.tsx#events -->

```tsx
import { useChannelSend, useRoomEvents } from "@fitzzero/quickdraw-core/client";

export function Board({ projectId }: { projectId: string }) {
  useRoomEvents({ "task:archived": (event) => console.info("archived", event.id, projectId) });
  const cursor = useChannelSend<{ projectId: string; x: number }>("taskService", "cursor");
  return <div onMouseMove={(event) => cursor.send({ projectId, x: event.clientX })} />;
}
```

<!-- example: apps/web/src/components/migration/TaskPanel.tsx#events -->

```tsx
export function Board({ projectId, onArchived }: { projectId: string; onArchived: () => void }) {
  // was useRoomEvents
  qd.taskService.archived.useEvent((event) => {
    if (event.projectId === projectId) {
      onArchived();
    }
  });
  // was useChannelSend
  const cursor = qd.taskService.cursor.useChannel();
  return <div onMouseMove={(event) => cursor.send({ projectId, x: event.clientX })} />;
}
```

### `invalidateOn` becomes `watch`

A query whose result follows writes declares `watch` in its contract: the
client joins that collection scope's change topic, and the invalidation
coordinator fetches the query again once per change, never cancelling a
read in flight. Live rows and collections need neither: frames keep them
current.

<!-- example: ../../../codemod/test/guide-v4/apps/web/src/hooks.tsx#invalidate -->

```tsx
export function Members({ projectId }: { projectId: string }) {
  const { data } = useServiceQuery<{ projectId: string }, { userId: string }[]>(
    "projectService",
    "getMembers",
    { projectId },
    { invalidateOn: ["project:members"] },
  );
  return <span>{data?.length ?? 0}</span>;
}
```

<!-- example: packages/shared/src/contracts/task.ts -->

```ts
import { crud, defineContract, mutation, query } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { cardSchema, taskSchema } from "../schemas";

export const taskContract = defineContract("taskService", {
  // what the service is for: MCP tools and the generated docs show it
  describe: "Tasks on a project's board.",
  // the full row; it must contain `id: string`
  entity: taskSchema,
  // lean shapes of the row
  projections: { card: cardSchema },
  // only callers with Admin on the task receive notes
  fields: { notes: "Admin" },
  methods: {
    // the read/write kit's get (one task by id) and create
    ...crud.contract({
      entity: taskSchema,
      get: true,
      // `id`: one the client may make (`newId()`), which the create keeps
      create: {
        input: z.object({ id: z.string().optional(), projectId: z.string(), title: z.string() }),
      },
    }),
    rename: mutation({
      input: z.object({ id: z.string(), title: z.string() }),
      output: "entity",
      describe: "Renames a task.",
    }),
    countOnBoard: query({
      input: z.object({ projectId: z.string() }),
      output: z.number(),
      // fetched again whenever the project's board changes
      watch: { collection: "board", scope: (input) => input.projectId },
      describe: "Counts the tasks on a project's board.",
    }),
  },
  collections: {
    // every task of a project, live, in board order
    board: {
      describe: "A project's tasks, in board order.",
      scope: "projectId",
      item: "card",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
      // sent for the whole board
      index: ["status", "ordinal", "assigneeId"],
      views: { mine: (row, who) => row.assigneeId === who.userId },
    },
  },
});
```

`countOnBoard` above is fetched again whenever the project's board
changes. A 4.x event that no collection scope stands for (a game's high
scores, which the game service writes beside its own rows) maps to the
service's topic, narrowed to the models the query reads:
`watch: { service: ["gameScore"] }` re-reads only after a write to those
models (`watch: "service"` after a write to any model the service has or
writes), and needs `watchAccess` on the service.

### `ServiceResponse` becomes `{ ok, d }` / `{ ok, e }` and `QuickdrawError`

Handlers return their result or throw `QuickdrawError(code, message)`; the
client resolves with the output or rejects with a `QuickdrawError`, whose
`code` is one of `UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`,
`VALIDATION`, `RATE_LIMITED`, `CANCELLED`, `TIMEOUT` or `INTERNAL`.

<!-- example: ../../../codemod/test/guide-v4/apps/web/src/hooks.tsx#errors -->

```tsx
import { ServiceCallError, useQuickdrawSocket } from "@fitzzero/quickdraw-core/client";
import type { ServiceResponse } from "@fitzzero/quickdraw-core";

export function useRename(): (id: string) => Promise<string> {
  const { socket } = useQuickdrawSocket();
  return (id) =>
    new Promise((resolve, reject) => {
      socket?.emit(
        "taskService:renameTask",
        { id, title: "x" },
        (reply: ServiceResponse<TaskDTO>) => {
          if (reply.success) {
            resolve(reply.data?.title ?? "");
          } else {
            reject(new ServiceCallError(reply.error ?? "failed", reply.code));
          }
        },
      );
    });
}
```

<!-- example: apps/web/src/components/migration/TaskPanel.tsx#errors -->

```tsx
import { QuickdrawError } from "@fitzzero/quickdraw-core";

export async function renameOrExplain(id: string): Promise<string> {
  try {
    const task = await qd.taskService.renameTask.call({ id, title: "Renamed" });
    return task?.title ?? "";
  } catch (error) {
    // was ServiceResponse { success, error, code } and ServiceCallError
    if (error instanceof QuickdrawError && error.code === "FORBIDDEN") {
      return "You may not rename this task.";
    }
    throw error;
  }
}
```

### `./eslint-plugin`, `./eslint-config` and core's `oxlint.base.jsonc` move to `@fitzzero/quickdraw-lint`

The lint rules are an oxlint plugin in their own package; see
[Lint, skills and agents](#lint-skills-and-agents) for the config and for
the 4.x rules that were removed.

### `./client/inputs` is removed

The socket-synced inputs are gone: keep your own input components and save
with a mutation. A mutation whose input has `id` and whose output is
`"entity"` updates the cached row optimistically.

<!-- example: ../../../codemod/test/guide-v4/apps/web/src/hooks.tsx#inputs -->

```tsx
import { SocketTextField } from "@fitzzero/quickdraw-core/client";

export function TitleField({ task }: { task: TaskDTO }) {
  const rename = useService<{ id: string; title: string }, TaskDTO | null>(
    "taskService",
    "renameTask",
  );
  return (
    <SocketTextField
      state={task}
      update={(patch: { title?: string }) =>
        rename.mutateAsync({ id: task.id, title: patch.title ?? "" })
      }
      property="title"
    />
  );
}
```

### Unchanged

The auth helpers, the Express rate limits, the socket rate limiter (apart
from its default, under "Defaults that changed"), the Redis adapter helper,
the env and encryption utilities, the client's token storage
(`getAuthToken`, `setAuthToken`, `clearAuthToken`) and its formatting
utilities. Some auth helpers moved to
`@fitzzero/quickdraw-core/server/auth` (and the MCP bridge to
`./server/mcp`); lint's `no-v4-api` names the new entry point of each. The
client's `getOAuthUrl`, `logout` and `logoutAllDevices` called routes the
auth routes kit does not serve, so they are replaced by `signInUrl`,
`signOut` and `signOutEverywhere` (below, "Hand-built auth to the auth
routes kit").

## Boards: from a watched query to a collection

The benchmark that compared 5.0 with 4.1 (`bench/reports/5.0.0.md`) ran a
board ported as most apps would port it first: one query that returns every
task of a project, grouped by status, with `watch`, so every viewer fetches
it again after every write.

<!-- example: apps/api/src/services/migration/board.ts#fat -->

```ts
export const boardContract = defineContract("taskService", {
  describe: "Tasks on a project's board.",
  entity: card.extend({ projectId: z.string() }),
  methods: {
    // every task of the project, grouped by status, fetched again after every write
    getTasksByStatus: query({
      input: z.object({ projectId: z.string() }),
      output: z.record(z.string(), z.array(card)),
      watch: { collection: "board", scope: (input) => input.projectId },
      describe: "Lists a project's tasks, grouped by status.",
    }),
  },
  collections: {
    board: {
      describe: "A project's tasks, by ordinal.",
      scope: "projectId",
      item: "entity",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
    },
  },
});

export const boardService = qd.defineService(boardContract, {
  model: "task",
  collections: { board: { anchor: projectContract } },
  methods: {
    getTasksByStatus: {
      access: { scope: "Read", of: projectContract, id: "projectId" },
      share: "all",
      handler: async ({ input, db }) => {
        const tasks = await db.task.findMany({
          where: { projectId: input.projectId },
          orderBy: { ordinal: "asc" },
          take: 5_000,
        });
        const byStatus: Record<string, typeof tasks> = {};
        for (const task of tasks) {
          (byStatus[task.status] ??= []).push(task);
        }
        return byStatus;
      },
    },
  },
});
```

Measured with 600 writes to a busy board, 5.0 cut the board query's p95 to
0.15× of 4.1 (122 to 19.0 ms), SQL per write to 0.36× and server CPU per
write to 0.53×, but bytes per write only to 0.89×: each board reply was
516 KB, and viewers fetched it about 20 times per write. Without those
replies, 5.0 sent about a fifth of what 4.1 did.

The 5.0 pattern is the collection: declare `index` (the small fields the
board orders and filters by, sent for the whole scope with the first page)
and `views` (named filters the client runs over the index), and read it
with `useCollection`. Writes then send each viewer one small delta, not the
board. Load items by window as the user scrolls, or all at once with
`load: "all"`. Keep `watch` for queries that compute something from many
rows, like a count.

<!-- example: packages/shared/src/contracts/task.ts -->

```ts
import { crud, defineContract, mutation, query } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { cardSchema, taskSchema } from "../schemas";

export const taskContract = defineContract("taskService", {
  // what the service is for: MCP tools and the generated docs show it
  describe: "Tasks on a project's board.",
  // the full row; it must contain `id: string`
  entity: taskSchema,
  // lean shapes of the row
  projections: { card: cardSchema },
  // only callers with Admin on the task receive notes
  fields: { notes: "Admin" },
  methods: {
    // the read/write kit's get (one task by id) and create
    ...crud.contract({
      entity: taskSchema,
      get: true,
      // `id`: one the client may make (`newId()`), which the create keeps
      create: {
        input: z.object({ id: z.string().optional(), projectId: z.string(), title: z.string() }),
      },
    }),
    rename: mutation({
      input: z.object({ id: z.string(), title: z.string() }),
      output: "entity",
      describe: "Renames a task.",
    }),
    countOnBoard: query({
      input: z.object({ projectId: z.string() }),
      output: z.number(),
      // fetched again whenever the project's board changes
      watch: { collection: "board", scope: (input) => input.projectId },
      describe: "Counts the tasks on a project's board.",
    }),
  },
  collections: {
    // every task of a project, live, in board order
    board: {
      describe: "A project's tasks, in board order.",
      scope: "projectId",
      item: "card",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
      // sent for the whole board
      index: ["status", "ordinal", "assigneeId"],
      views: { mine: (row, who) => row.assigneeId === who.userId },
    },
  },
});
```

<!-- example: apps/web/src/components/TaskBoard.tsx -->

```tsx
"use client";

import { qd } from "../lib/quickdraw";

export function TaskBoard({ projectId }: { readonly projectId: string }) {
  // Live: tasks added, changed, moved or removed by anyone show at once.
  const { items, isLoading } = qd.task.board.useCollection(projectId);
  const { data: count } = qd.task.countOnBoard.useQuery({ projectId });
  // Optimistic: the new title shows before the server answers.
  const rename = qd.task.rename.useMutation();

  if (isLoading) {
    return <p>Loading…</p>;
  }
  return (
    <section>
      <h2>{`${String(count ?? items.length)} tasks`}</h2>
      <ul>
        {items.map((task) => (
          <li key={task.id}>
            {task.title}
            <button type="button" onClick={() => rename.mutate({ id: task.id, title: "Done" })}>
              Rename
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
```

## Hand-built auth to the auth routes kit

A 4.x app built its own sign-in: a route pair per OAuth provider, a callback
that found or created the user, a `Session` row holding each JWT, a guest
route, `DELETE` routes to log out, and an `authenticate` that verified the
token and looked its row up. The codemod leaves this code alone. 5.0's auth
routes kit (`createAuthRoutes` on `./server/auth`, the README's "Auth routes
kit") serves the same flows as one Express middleware over a session store
the app owns, and `socketAuth` authenticates sockets and HTTP calls by those
sessions. Moving onto it takes a database migration, a new set of URLs for
the web app, and these steps.

**1. The `Session` table.** The kit's `SessionStore` creates, reads and
revokes sessions by id. A session's JWT names its row in its `sid` claim,
so the row no longer stores the token: drop the `token` column, and add how
the user signed in (`provider`) and, for a list of where a user is signed
in, the request's user agent and IP. 4.x tokens carry no `sid`, so every
existing session ends and everyone signs in once more; the migration
deletes the old rows:

```sql
-- A 4.x Session table ("sessions": id, user_id, token, expires_at, created_at)
DELETE FROM "sessions";
DROP INDEX "sessions_token_key";
ALTER TABLE "sessions"
  DROP COLUMN "token",
  ADD COLUMN "provider" TEXT NOT NULL,
  ADD COLUMN "user_agent" TEXT,
  ADD COLUMN "ip" TEXT;
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");
CREATE INDEX "sessions_expires_at_idx" ON "sessions"("expires_at");
```

```prisma
model Session {
  id        String   @id @default(cuid())
  userId    String   @map("user_id")
  // "google", "discord", "mock", "guest", or an app's own flow
  provider  String
  userAgent String?  @map("user_agent")
  ip        String?
  expiresAt DateTime @map("expires_at")
  createdAt DateTime @default(now()) @map("created_at")
  user      User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([expiresAt])
  @@map("sessions")
}
```

The store over it is four calls. Sessions are not live data, so write them
through the untracked client (or inside `qd.run`), and delete expired rows
now and then:

<!-- example: apps/api/src/auth/sessions.ts#store -->

```ts
import type { SessionStore } from "@fitzzero/quickdraw-core/server/auth";

/** The methods of Prisma's `db.session` delegate the store calls. */
interface SessionTable {
  create(args: { data: SessionMeta & { userId: string } }): Promise<AuthSession>;
  findUnique(args: { where: { id: string } }): Promise<AuthSession | null>;
  deleteMany(args: { where: { id: string } | { userId: string } }): Promise<unknown>;
}

export function prismaSessions(sessions: SessionTable): SessionStore {
  return {
    create: (userId, meta) => sessions.create({ data: { userId, ...meta } }),
    get: (id) => sessions.findUnique({ where: { id } }),
    revoke: (id) => sessions.deleteMany({ where: { id } }),
    revokeAll: (userId) => sessions.deleteMany({ where: { userId } }),
  };
}
```

**2. The routes.** Under `basePath` (default `/auth`), with the web app's
links and calls changed to match. Every POST needs
`Content-Type: application/json`; a failure answers
`{ error: <code>, message }` with the code's HTTP status:

| 4.x (hand-built)                                  | 5.0 (the kit)                                                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /auth/google`, `/auth/discord`, `/auth/mock` | `GET /auth/{provider}/start?returnTo=<page>`                                                        |
| `GET /auth/{provider}/callback`                   | the same path; register `{publicUrl}/auth/{provider}/callback` with the provider                    |
| `POST /auth/guest`                                | the same, with a JSON body; answers `{ userId, name? }` (and `token` with `guest({ token: true })`) |
| `DELETE /auth/logout`                             | `POST /auth/logout`: 204, revokes the session and clears the cookie                                 |
| `DELETE /auth/sessions` (every device)            | `POST /auth/logout-all`: 204, or 401 without a live session                                         |
| (none)                                            | `GET /auth/me`: `{ userId }`, or 401                                                                |

`returnTo` is only a page's origin, and only one `allowedOrigins` lists: the
sign-in lands on `{origin}{successPath}` with the session cookie set. A
failed one lands on `{origin}{errorPath}?error=<code>`, with new codes for
the login page to read:

| 4.x `?error=`   | 5.0 `?error=` | When                                                                             |
| --------------- | ------------- | -------------------------------------------------------------------------------- |
| `invalid_state` | `state`       | the OAuth state is missing, forged, expired, used twice, or for another provider |
| `no_code`       | `denied`      | the provider sent no code or an error (the user declined)                        |
| (none)          | `denied`      | `onLogin` returned `null`: the app refused the sign-in                           |
| `oauth_failed`  | `failed`      | the code exchange, `onLogin` (it threw) or creating the session failed           |

In the web app, `./client`'s helpers call these routes. 4.x's `getOAuthUrl`,
`logout` and `logoutAllDevices` called the hand-built ones (and sent only a
stored token, so with cookie sessions they signed nobody out); 5.0 replaces
them, and lint's `no-v4-api` reports the old names:

| 4.x (`./client`)                 | 5.0 (`./client`)                                                                                                   |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `getOAuthUrl(provider, apiUrl?)` | `signInUrl(provider, { apiUrl?, basePath?, returnTo? })`: the start route, back to the current page's origin       |
| `logout(apiUrl?)`                | `signOut({ apiUrl?, basePath? })`: `POST /auth/logout` with the cookie (and a stored token); rejects when refused  |
| `logoutAllDevices(apiUrl?)`      | `signOutEverywhere({ apiUrl?, basePath? })`: `POST /auth/logout-all`; resolves with nothing (4.x returned a count) |

Each POST sends the session cookie (`credentials: "include"`: allow the web
app's origin with credentials in the API's CORS) and forgets the stored
token. A socket keeps the user it signed in as until it connects again:
after `signOut()`, reconnect the provider's connection
(`useQuickdraw().connection.close()`, then `open()`), or load the next page.

**3. The callback becomes `onLogin`.** What 4.x's callback did after the code
exchange (find the user by the provider account, link one by a verified
email, create one, store the provider's tokens) moves into
`onLogin(profile, provider)`, which returns the user's id, or `null` to
refuse. `profile` carries `providerAccountId`, `email`, `emailVerified`,
`name`, `image`, the provider's `tokens` and its `raw` answer. Link an
existing user by email only when `emailVerified` is true.

**4. Wire it.** One `{ sessions, jwtSecret }` serves the routes, `socketAuth`
and the app's own REST routes. A provider without credentials in an
environment (development without a Google app) is left out in place with
`google.optional(...)`. 4.x's development sign-in by a user id in the
handshake becomes `socketAuth({ devCredentials })`, which cannot run in
production. `createRequireAuth({ getSession })` on REST routes becomes
`requireSession(keys)`, which verifies the JWT once; the route reads the
user with `sessionOf(req)` instead of `req.userId` (Express's `Request` type
has no such member), and calls the services as `sessionOf(req).principal`
through `qd.caller`, which loads the user's grants as a socket's handshake
does (the README's auth routes kit section shows such a route). Give
`requireSession` the `sessions` object the routes were given: it takes their
`allowedOrigins` by that same store object, and a second
`prismaSessions(...)` over the same table is another one. `onRevoke` ends
the sockets of a revoked session:

<!-- example: apps/api/src/auth/migrating.ts#wiring -->

```ts
import {
  createAuthRoutes,
  discord,
  google,
  mock,
  requireSession,
  sessionOf,
  socketAuth,
  type SessionKeys,
} from "@fitzzero/quickdraw-core/server/auth";

// `sessions`: a SessionStore over the Session table, `prismaSessions(db.session)`
const keys: SessionKeys = { sessions, jwtSecret: env.JWT_SECRET };
const allowedOrigins = [env.CLIENT_URL];

/** A development handshake's user (`auth: { userId }`): the Godot editor, load-test bots. */
async function devUser(userId: string): Promise<AppPrincipal | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true } });
  return user === null ? null : { userId: user.id, kind: "user" };
}

export const app: Express = express();
app.set("trust proxy", 1);
app.use(
  createAuthRoutes({
    ...keys,
    providers: [
      // each is left out where its credentials are not set
      google.optional({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }),
      discord.optional({
        clientId: env.DISCORD_CLIENT_ID,
        clientSecret: env.DISCORD_CLIENT_SECRET,
      }),
      mock({ listUsers: listSeededUsers }),
    ],
    // 4.x's callback tail: find or create the user (and its account row); null refuses
    onLogin: (profile) => upsertUser(profile),
    allowedOrigins,
    publicUrl: env.API_URL,
    // the web app's pages: /auth/callback signed in, /auth/login?error=state|denied|failed
    successPath: "/auth/callback",
    errorPath: "/auth/login",
    onRevoke: (userId, sessionId) =>
      server.access.disconnectUser(userId, sessionId === null ? {} : { sessionId }),
  }),
);

// the app's own REST routes: was createRequireAuth({ getSession }) and req.userId
app.post("/api/push/resubscribe", express.json(), requireSession(keys), (req, res) => {
  // the session's user and principal, typed; call the services as it (the README's REST example)
  const { userId } = sessionOf(req);
  res.json({ userId });
});

export const server = qd.createServer({
  app,
  services: [projectService, taskService],
  db,
  auth: {
    authenticate: socketAuth({
      ...keys,
      allowedOrigins,
      loadPrincipal: (userId): AppPrincipal => ({ userId, kind: "user" }),
      // never in production: socketAuth refuses it there
      devCredentials: env.ENABLE_DEV_CREDENTIALS === "true" ? devUser : undefined,
    }),
    loadServiceAccess: (userId) => loadGrants(userId),
    serviceAccessSource: { model: "user", column: "serviceAccess" },
  },
});
```

**5. Flows the kit does not redirect for.** A sign-in that is not a
redirect to a provider (a Discord Activity's embedded SDK, login codes)
stays an app route, ending in `issueSession`: an ordinary session that
`socketAuth`, `requireSession` and `/auth/me` accept like any other. Answer
the token in the body for a client that cannot keep the cookie, and set no
cookie its page does not use. A cookie is for a page that calls the API
with it: on the API's own site, `setSessionCookie(res, token)` (Lax);
`{ sameSite: "none" }` (always Secure) only for a page on another site
whose requests send `credentials: "include"`, with its origin in
`allowedOrigins`:

<!-- example: apps/api/src/auth/migrating.ts#activity -->

```ts
import { issueSession } from "@fitzzero/quickdraw-core/server/auth";

// A sign-in the kit's redirecting providers do not cover, such as a Discord Activity's embedded
// SDK handing the page a code: the app exchanges it, then starts an ordinary session, which
// socketAuth and requireSession accept like any other. The page sends the token as auth.token.
app.post("/auth/discord/activity", express.json(), (req, res) => {
  void (async () => {
    const { code } = req.body as { readonly code?: unknown };
    if (typeof code !== "string" || code === "") {
      res.status(422).json({ error: "VALIDATION", message: "Send the Activity's code" });
      return;
    }
    const userId = await upsertUser(await activityProfile(code));
    if (userId === null) {
      res.status(401).json({ error: "UNAUTHENTICATED", message: "Sign-in refused" });
      return;
    }
    const { token } = await issueSession(keys, userId, {
      provider: "discord-activity",
      userAgent: req.get("user-agent"),
      ip: req.ip,
    });
    // no cookie: an iframe on another site rarely keeps one, and this page never reads it
    res.json({ token });
  })();
});
```

**6. The cookie's name.** 4.x's `setSessionCookie` always wrote `session`.
5.0 writes `__Host-session` on a request over HTTPS (with no domain) and
reads only that name there, so an old `session` cookie no longer signs
anyone in over HTTPS; with the `sid` change above, nobody keeps a 4.x
session anyway. `COOKIE_DOMAIN` keeps the name `session` everywhere, and a
name of the app's own goes in all three places
(`createAuthRoutes({ cookie: { name } })`, `socketAuth({ cookieName })`,
`createServer({ http: { cookieName } })`); "Defaults that changed" has the
whole rule. A web app on another origin calls `/auth/*` with
`credentials: "include"` (the client's socket sends cookies already), and a
native client sends the token as `auth.token`.

## Defaults that changed

- **Access is closed.** A method without `access` does not compile. A
  `"Read"` method that names no row is no longer open to every signed-in
  user (the codemod writes `"authenticated"` to keep that, marked). A form
  naming both halves, `{ service, entry }`, passes on either. A service grant
  below `Admin` counts only where a form names `service`: a `Read` grant no
  longer opens every row to a subscriber, and a service without a policy
  can be subscribed to only with a service-wide `Admin` grant. The kits'
  single-row writes (`update`, `delete`, `reorder`) need the row level on
  the row, whatever their form says.
- **Invalidation never cancels a read.** The coordinator keeps one read in
  flight per query; an invalidation during it runs exactly one more when it
  settles. 4.x cancelled the read and issued it again.
- **A reconnect refetches less, and later.** 4.x invalidated every query at
  once after a reconnect. 5.0 resumes rows and collections by revision and
  refetches only the queries that are watched or stale, each after a random
  delay of up to 2,000 ms, so a fleet reconnecting after a restart does not
  refetch in one burst; cached data stays on screen meanwhile.
  `<QuickdrawProvider reconnectJitterMs={0}>` refetches them at once.
- **Timeouts are not retried.** A query that times out rejects with
  `TIMEOUT` once.
- **Mutations of an entity are optimistic.** A mutation whose input has `id`
  and whose output is `"entity"` shows its input over the cached row and its
  collection items until the server answers; `optimistic: false` turns that
  off.
- **The service topic is closed** unless the service declares `watchAccess`:
  `qd:watch` on a whole service is `FORBIDDEN` without it.
- **`logout-all` disconnects** the user's sockets (`createAuthRoutes` wires
  `onRevoke` to `server.access.disconnectUser`).
- **The socket rate limiter is on**: 600 events per minute per socket, not
  counting subscription events, channels and cancels, enough for a board
  whose watched query refetches four times a second. `createRateLimiter()`
  without `maxRequests` allows 600 too (4.x: 100). An app that built the
  limiter itself (`createRateLimiter` plus `applyRateLimitMiddleware`) drops
  that code and passes the same options as `rateLimit`, or `false`.
- **The client drops its cache when the user changes**: a hello naming
  another user removes everything quickdraw cached, so one user's rows never
  show to the next.
- **The session cookie is `__Host-session` over HTTPS.** `createAuthRoutes`,
  `setSessionCookie` (4.x: always `session`), `socketAuth`, the HTTP
  transport and `extractBearerOrCookieToken` follow one rule: a configured
  name; else `session` when the cookie has a domain; else `__Host-session`
  (Secure, `Path=/`, no domain) on a request over HTTPS (`req.secure`,
  `X-Forwarded-Proto: https` or an `https:` `Origin`) and `session` over
  plain HTTP. Each reads first the name it would set on the same request,
  and over HTTPS without a domain never reads a `session` cookie, which a
  sibling site could have planted. The OAuth state cookie is
  `__Host-qd_oauth` when it is Secure. A cookie shared with subdomains
  through `COOKIE_DOMAIN` (as 4.x apps set it) is `session` everywhere with
  nothing to configure, since the transports read `COOKIE_DOMAIN` too; a
  domain given only as `cookie.domain` needs
  `socketAuth({ cookieName: "session" })` and
  `createServer({ http: { cookieName: "session" } })`, and the routes warn
  at startup until it is named.
- **A session cookie on an HTTP call must come from an allowed page.**
  `socketAuth` applies its `allowedOrigins` to `/qd/...` calls that
  authenticate with the cookie, as it does to sockets: a call whose
  `Origin` is not listed is answered `FORBIDDEN` (403). A call without
  `Origin` (curl, server-side rendering that forwards the user's cookie)
  and a bearer token are unaffected. A page on another origin that calls
  `/qd` with the cookie needs its origin in `allowedOrigins`.
- **`setSessionCookie` sets SameSite=Lax** (4.x: `None` in production),
  as the auth routes' own cookie is, so the cookie never rides a request
  another site's page makes. A web app on another site, or a page in a
  third-party iframe, passes `{ sameSite: "none" }` (always Secure).
- **A method's output is sent as it declares it.** 4.x sent what a handler
  returned. A projection output (`"entity"`, a named projection) sends the
  projection's keys, stripped per caller, and a method whose output is a
  schema of its own sends only what that schema's JSON Schema declares
  (Zod 4.2 or later), on every transport: a handler may return the whole
  row, and the keys the schema leaves out never leave the server. An
  output schema without JSON Schema (Zod 3) is sent as returned.
- **No default CORS origin.** 4.1 allowed `*`; pass `cors`.
- **`validateRedirectOrigin` never allows a GitHub Codespaces origin**
  (since 5.0.1). 4.x allowed any `https://*-*-<port>.app.github.dev` unless
  `allowCodespaces: false`, in production too, so any Codespace page passed
  an app's CORS or cookie check that used it. `allowCodespaces` is now
  ignored; an app that wants one lists a pattern in `allowedPatterns`.
- **Errors that are not `QuickdrawError` reach callers as `INTERNAL`** with a
  generic message (the original is logged). A Prisma unique violation is
  `CONFLICT` and a missing row `NOT_FOUND`. A subscribe, or a method whose
  access names the row (`{ entry }`), answers a missing row `FORBIDDEN`,
  as it answers a row the caller may not see, so a stranger cannot tell
  which ids exist (only a service-wide `Admin` gets `NOT_FOUND`).
- **A mutation ignores its caller's cancel**: only its time limit (30 s by
  default) stops it.
- **MCP custom tools default to `access: "authenticated"`.**

## Running 4.x and 5.0 clients together

A 5.0 server refuses a 4.x client by default (`PROTOCOL_MISMATCH`). With
`legacyWire: true` (shown in the `qd.createServer` example above), a client
that connects without 5.0's handshake is served as a 4.x client instead:
`socket.emit("taskService:renameTask", payload, ack)` runs through the 5.0
pipeline, with the same validation, access and limits, and is answered in
4.x's `ServiceResponse` shape. The shim serves request and response calls
only, not subscriptions, collections or channels, and it logs each
service, method and kind of caller once, so the remaining 4.x clients can
be found.

A call through the shim sees the socket it arrived on: `ctx.socketId` is
its id, and `ctx.rooms.join(room)` puts the 4.x client in an app room,
which it leaves when it disconnects. A contract's events
(`ctx.rooms.emit`) reach only 5.0 sockets, so until those clients speak
protocol 5 the app delivers to 4.x listeners with its own raw emit to the
room (`server.io.to(room).emit(...)`), an item for the lint baseline.

To ship without a flag day: deploy the 5.0 server with `legacyWire: true`,
ship the 5.0 web and mobile clients, watch the log until no 4.x caller is
left, then remove `legacyWire`. Screens that depend on 4.x live data
(subscriptions, collections) stop updating on old clients in the meantime,
so ship the clients soon after the server.

## Lint, skills and agents

**`@fitzzero/quickdraw-lint`** is the oxlint plugin and base config every
5.0 app extends (an app built from the quickdraw template extends
`oxlint.template.jsonc` instead: it extends the base and adds the
design-system rules):

```jsonc
// .oxlintrc.json
{
  "extends": ["./node_modules/@fitzzero/quickdraw-lint/oxlint.base.jsonc"],
  "plugins": ["typescript", "import", "react", "nextjs", "jsx_a11y"],
  "ignorePatterns": ["**/dist/**", "**/node_modules/**"],
  "settings": { "quickdraw": { "baseline": ".quickdraw-lint-baseline.json" } },
}
```

`no-v4-api` reports every 4.x API that is left, with its replacement,
`no-todo-schema` every placeholder schema, `prefer-kit` (a warning)
every migrated method a kit implements (`getProject`, `listTasks`, ...;
the report lists them under "Methods a kit implements"): move it to the
kit, or keep it with a `// quickdraw: hand-written because <reason>`
comment above it. `require-describe` (a warning) reports every contract
member without a `describe`, which is all of them after the codemod.

Adopt it on the codemod's output with a baseline:
`quickdraw-lint baseline -c .oxlintrc.json` records every violation lint
reports now, the quickdraw rules' and oxlint's own (the 4.x hooks the
codemod keeps for review are unused functions until you delete them), and
`quickdraw-lint check`, the app's lint command in place of `oxlint` (per
package: `quickdraw-lint check -c ../../.oxlintrc.json src`), reports only
what is new. The quickdraw rules read the baseline themselves, so an editor
running oxlint leaves their recorded violations out too. A fixed violation
leaves an allowance unused, which `no-unused-baseline` reports: run the
baseline command again, so the file only shrinks. The 4.x rules were
removed (oxlint refuses a config that names them):

| 4.x rule                      | In 5.0                                                                                       |
| ----------------------------- | -------------------------------------------------------------------------------------------- |
| `require-zod-schema`          | every contract method has an `input` schema; `no-todo-schema` reports the placeholders       |
| `no-service-method-record`    | nothing to forbid: contracts type every method, with no escape hatch                         |
| `no-unsafe-payload-cast`      | nothing to forbid: handlers receive the parsed input's type                                  |
| `no-raw-service-room-string`  | entity, collection and topic rooms are the framework's; `no-manual-emit` reports `qd:` names |
| `no-manual-collection-events` | `no-manual-emit`                                                                             |
| `no-direct-prisma-mutations`  | reversed: write through the tracked `db`; `no-untracked-write` reports the untracked client  |
| `no-cross-service-mutations`  | `no-foreign-write`, with the models a service may write listed in `writes`                   |
| `no-raw-socket-emit`          | `no-raw-socket`                                                                              |
| `no-raw-socket-on`            | `no-raw-socket`                                                                              |

**`@fitzzero/quickdraw-skills`** ships agent rules (services, access, client,
tests) and skills (`quickdraw-new-service`, and `quickdraw-migrate-v5`,
which walks an agent through this guide). Link them into `.claude/` from
`prepare`, so every checkout gets the current ones:

```jsonc
// package.json
{
  "scripts": {
    "prepare": "quickdraw-skills link",
  },
}
```

An agent doing the migration can start from
[`UPGRADE-PROMPT.md`](UPGRADE-PROMPT.md).

## Splitting large services

4.1's README split a large service into an abstract `*ServiceCore`, method
modules calling `service.defineMethod(...)`, and a concrete subclass wiring
them. In 5.0 the method modules export typed method objects and the service
lists them; the core's helpers become module functions. This is what the
codemod writes, with `MethodOf` added to `apps/api/src/quickdraw.ts`:

<!-- example: apps/api/src/services/migration/split.ts#split -->

```ts
// apps/api/src/quickdraw.ts (the codemod writes MethodOf there): any form but "public"
export type MethodOf<C extends AnyContract, M extends MethodName<C>> = MethodImplementation<
  AppTypes,
  C,
  M,
  "authenticated"
>;

// apps/api/src/services/task/methods/rename.ts: one module per method, or per cluster
export const renameTask = {
  access: { service: "Moderate", entry: "Moderate", id: "id" },
  handler: ({ input, db }) =>
    db.task.update({ where: { id: input.id }, data: { title: input.title } }),
} satisfies MethodOf<typeof taskContract, "renameTask">;

// apps/api/src/services/task/index.ts: the service lists them
import { inherit } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(taskContract, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  collections: { byProject: { anchor: projectContract } },
  channels: { cursor: () => undefined },
  methods: {
    renameTask,
    // quickdraw: hand-written because it answers null for a missing task, as 4.x did
    getTask: {
      access: { service: "Read", entry: "Read", id: "id" },
      handler: ({ input, db }) => db.task.findUnique({ where: { id: input.id } }),
    },
    archiveAll: {
      access: { service: "Admin" },
      handler: async ({ input, db }) => {
        const { count } = await db.task.updateMany({
          where: { projectId: input.projectId },
          data: { status: "archived" },
        });
        return { count };
      },
    },
  },
});
```

## Order of the migrations

Within one app: contracts, access, emits, client, as in
[Work through the report](#work-through-the-report).

Across the apps on 4.x: quickdraw-chat went first (the template, and the
release gate for 5.0.0), and its pull requests are the worked example;
seneschal re-forks from it instead of migrating; then x-tokage-siege,
foundation, farseer and Conveyor. makiel (on 3.7) and quickdraw-sunfall
(on 3.9.1) stay on 3.x: the codemod reads 4.x code.

## Every removed 4.x name

<!-- removed-names:start -->

Generated from `@fitzzero/quickdraw-lint`'s `no-v4-api` rule, which reports each of these with the same text.

### Names no 5.0 entry point exports

| 4.x name                       | In 5.0                                                                                                                                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ServiceResponse`              | Handlers return their result or throw `QuickdrawError(code, message)`; the reply on the wire is `{ ok: true, d }` or `{ ok: false, e: { code, message, data? } }`, and the client throws `QuickdrawError`.                      |
| `ServiceMethodMap`             | Declare methods in a contract (`defineContract(name, { methods: { name: query({ input, output }) } })`), type them with `InputOf<C, M>` and `OutputOf<C, M>`, and implement them as `{ access, handler({ input, ctx, db }) }`.  |
| `ServiceMethodDefinition`      | Declare methods in a contract (`defineContract(name, { methods: { name: query({ input, output }) } })`), type them with `InputOf<C, M>` and `OutputOf<C, M>`, and implement them as `{ access, handler({ input, ctx, db }) }`.  |
| `ServiceMethodContext`         | Declare methods in a contract (`defineContract(name, { methods: { name: query({ input, output }) } })`), type them with `InputOf<C, M>` and `OutputOf<C, M>`, and implement them as `{ access, handler({ input, ctx, db }) }`.  |
| `ExtractPayload`               | Declare methods in a contract (`defineContract(name, { methods: { name: query({ input, output }) } })`), type them with `InputOf<C, M>` and `OutputOf<C, M>`, and implement them as `{ access, handler({ input, ctx, db }) }`.  |
| `ExtractResponse`              | Declare methods in a contract (`defineContract(name, { methods: { name: query({ input, output }) } })`), type them with `InputOf<C, M>` and `OutputOf<C, M>`, and implement them as `{ access, handler({ input, ctx, db }) }`.  |
| `ServiceChannelMap`            | Declare channels in the contract (`channels: { name: { payload } }`), handle them in `qd.defineService(contract, { channels })`, and send with `qd.<service>.<channel>.useChannel()`.                                           |
| `ServiceChannelDefinition`     | Declare channels in the contract (`channels: { name: { payload } }`), handle them in `qd.defineService(contract, { channels })`, and send with `qd.<service>.<channel>.useChannel()`.                                           |
| `ServiceChannelContext`        | Declare channels in the contract (`channels: { name: { payload } }`), handle them in `qd.defineService(contract, { channels })`, and send with `qd.<service>.<channel>.useChannel()`.                                           |
| `CHANNEL_EVENT_PREFIX`         | Channels travel on the single `qd:ch` event, which the socket rate limiter already skips: send with `qd.<service>.<channel>.useChannel()`.                                                                                      |
| `channelEventName`             | Channels travel on the single `qd:ch` event, which the socket rate limiter already skips: send with `qd.<service>.<channel>.useChannel()`.                                                                                      |
| `QuickdrawEventMap`            | Declare room events in the contract (`events: { name: { payload } }`), send them with `ctx.rooms.emit(room, contract, event, payload)`, and listen with `qd.<service>.<event>.useEvent(handler)`.                               |
| `QuickdrawEventName`           | Declare room events in the contract (`events: { name: { payload } }`), send them with `ctx.rooms.emit(room, contract, event, payload)`, and listen with `qd.<service>.<event>.useEvent(handler)`.                               |
| `QuickdrawEventData`           | Declare room events in the contract (`events: { name: { payload } }`), send them with `ctx.rooms.emit(room, contract, event, payload)`, and listen with `qd.<service>.<event>.useEvent(handler)`.                               |
| `QuickdrawUser`                | The principal's type is the app's own, given to `initQuickdraw<{ db, principal }>()`; handlers read it as `ctx.principal`.                                                                                                      |
| `ACLEntity`                    | A row shared through a JSON access list uses the `jsonAcl(field, { owner })` policy on `qd.defineService(contract, { access })`; the sharing kit (`sharing.contract({ mode: "acl" })`) edits the list.                          |
| `AdminCreatePayload`           | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `AdminDeletePayload`           | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `AdminDeleteResponse`          | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `AdminGetPayload`              | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `AdminGetSubscribersPayload`   | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `AdminListPayload`             | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `AdminListResponse`            | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `AdminMetaPayload`             | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `AdminMetaResponse`            | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `AdminReemitPayload`           | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `AdminReemitResponse`          | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `AdminSetACLPayload`           | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `AdminSubscribersResponse`     | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `AdminUnsubscribeAllPayload`   | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `AdminUnsubscribeAllResponse`  | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `AdminUpdatePayload`           | The admin kit's methods are ordinary contract entries (`admin.contract({ entity })`, implemented by `admin.handlers(contract)`): type them with `InputOf<C, "adminList">` and `OutputOf<C, "adminList">`, and so on per method. |
| `SubscribePayload`             | Subscribe to rows with `qd.<service>.useEntity(id)` or `useEntities(ids)`; the client sends protocol v5's `qd:sub` itself.                                                                                                      |
| `UnsubscribePayload`           | Subscribe to rows with `qd.<service>.useEntity(id)` or `useEntities(ids)`; the client sends protocol v5's `qd:sub` itself.                                                                                                      |
| `CollectionSubscribePayload`   | Declare collections in the contract and read them with `qd.<service>.<collection>.useCollection(scope)`; the client sends protocol v5's `qd:col:sub` itself and holds a `CollectionState`.                                      |
| `CollectionUnsubscribePayload` | Declare collections in the contract and read them with `qd.<service>.<collection>.useCollection(scope)`; the client sends protocol v5's `qd:col:sub` itself and holds a `CollectionState`.                                      |
| `CollectionSnapshotPage`       | Declare collections in the contract and read them with `qd.<service>.<collection>.useCollection(scope)`; the client sends protocol v5's `qd:col:sub` itself and holds a `CollectionState`.                                      |
| `CollectionSnapshotResponse`   | Declare collections in the contract and read them with `qd.<service>.<collection>.useCollection(scope)`; the client sends protocol v5's `qd:col:sub` itself and holds a `CollectionState`.                                      |
| `serviceRoom`                  | Entity rooms are per access tier (`entityRoom(service, id, level)`) and joined by `useEntity`; join an app room with `ctx.rooms.join(room)` and reach one user with `ctx.rooms.emitToUser(userId, ...)`.                        |
| `serviceFullRoom`              | Entity rooms are per access tier (`entityRoom(service, id, level)`) and joined by `useEntity`; join an app room with `ctx.rooms.join(room)` and reach one user with `ctx.rooms.emitToUser(userId, ...)`.                        |
| `collectionEventName`          | Collection deltas all travel on the `qd:c` event and are applied by `qd.<service>.<collection>.useCollection(scope)`.                                                                                                           |
| `BaseService`                  | Declare services with `qd.defineService(contract, { model, access, methods: { name: { access, handler } } })`; there are no service classes.                                                                                    |
| `BaseRpcService`               | A service without rows is a contract without `entity`, implemented by `qd.defineService(contract, { methods })` without `model`.                                                                                                |
| `BaseServiceInstance`          | `qd.defineService(contract, definition)` returns a `Service`; its options are the `ServiceDefinition` object.                                                                                                                   |
| `BaseServiceOptions`           | `qd.defineService(contract, definition)` returns a `Service`; its options are the `ServiceDefinition` object.                                                                                                                   |
| `ServiceRegistry`              | Pass the services to `qd.createServer({ app, services: [...], db, auth })`.                                                                                                                                                     |
| `ServiceRegistryInstance`      | Pass the services to `qd.createServer({ app, services: [...], db, auth })`.                                                                                                                                                     |
| `ServiceRegistryOptions`       | Pass the services to `qd.createServer({ app, services: [...], db, auth })`.                                                                                                                                                     |
| `createQuickdrawServer`        | Create the server with `qd.createServer({ app, services, db, auth })` (`qd = initQuickdraw<{ db, principal }>()`); it attaches to the app's own Express app and HTTP server.                                                    |
| `QuickdrawServerOptions`       | Create the server with `qd.createServer({ app, services, db, auth })` (`qd = initQuickdraw<{ db, principal }>()`); it attaches to the app's own Express app and HTTP server.                                                    |
| `QuickdrawServerResult`        | Create the server with `qd.createServer({ app, services, db, auth })` (`qd = initQuickdraw<{ db, principal }>()`); it attaches to the app's own Express app and HTTP server.                                                    |
| `QuickdrawIdentity`            | `qd.createServer({ auth: { authenticate } })`'s `authenticate` returns a principal, a user id string, or nothing for an anonymous caller.                                                                                       |
| `CollectionManager`            | Declare collections in the contract (`collections: { name: { scope, item, order } }`) and anchor them in `qd.defineService(contract, { collections: { name: { anchor } } })`; their deltas follow tracked writes.               |
| `CollectionDefinition`         | Declare collections in the contract (`collections: { name: { scope, item, order } }`) and anchor them in `qd.defineService(contract, { collections: { name: { anchor } } })`; their deltas follow tracked writes.               |
| `CollectionWriteEvent`         | Declare collections in the contract (`collections: { name: { scope, item, order } }`) and anchor them in `qd.defineService(contract, { collections: { name: { anchor } } })`; their deltas follow tracked writes.               |
| `InstallAdminMethodsOptions`   | Use the admin kit: `...admin.contract({ entity })` in the contract and `...admin.handlers(contract, { displayName, hiddenFields })` in `methods`.                                                                               |
| `PrismaDelegate`               | Handlers write through the tracked client, `db.<model>`, from their `{ input, ctx, db }` argument.                                                                                                                              |
| `zodToAdminFields`             | The admin kit's `adminMeta` derives the fields from the entity's JSON Schema; adjust them with `admin.handlers(contract, { fieldOverrides, hiddenFields })`.                                                                    |
| `getDefaultEntityFields`       | The admin kit's `adminMeta` derives the fields from the entity's JSON Schema; adjust them with `admin.handlers(contract, { fieldOverrides, hiddenFields })`.                                                                    |
| `mergeWithDefaultFields`       | The admin kit's `adminMeta` derives the fields from the entity's JSON Schema; adjust them with `admin.handlers(contract, { fieldOverrides, hiddenFields })`.                                                                    |
| `ZodToAdminFieldsOptions`      | The admin kit's `adminMeta` derives the fields from the entity's JSON Schema; adjust them with `admin.handlers(contract, { fieldOverrides, hiddenFields })`.                                                                    |
| `createMcpRoutes`              | Mount `createMcpHttpRouter({ registry })` from "@fitzzero/quickdraw-core/server/mcp".                                                                                                                                           |
| `McpHttpRoutesOptions`         | Mount `createMcpHttpRouter({ registry })` from "@fitzzero/quickdraw-core/server/mcp".                                                                                                                                           |
| `generateToolMetadata`         | MCP tools are generated from the contracts: `createMcpRegistry({ services, dispatcher })` and `describeTools` from "@fitzzero/quickdraw-core/server/mcp".                                                                       |
| `GenerateToolMetadataOptions`  | MCP tools are generated from the contracts: `createMcpRegistry({ services, dispatcher })` and `describeTools` from "@fitzzero/quickdraw-core/server/mcp".                                                                       |
| `ServiceToolSpec`              | MCP tools are generated from the contracts: `createMcpRegistry({ services, dispatcher })` and `describeTools` from "@fitzzero/quickdraw-core/server/mcp".                                                                       |
| `MethodSpec`                   | MCP tools are generated from the contracts: `createMcpRegistry({ services, dispatcher })` and `describeTools` from "@fitzzero/quickdraw-core/server/mcp".                                                                       |
| `ServiceInfo`                  | MCP tools are generated from the contracts: `createMcpRegistry({ services, dispatcher })` and `describeTools` from "@fitzzero/quickdraw-core/server/mcp".                                                                       |
| `ServiceMethodInfo`            | MCP tools are generated from the contracts: `createMcpRegistry({ services, dispatcher })` and `describeTools` from "@fitzzero/quickdraw-core/server/mcp".                                                                       |
| `McpToolDefinition`            | MCP tools are generated from the contracts: `createMcpRegistry({ services, dispatcher })` and `describeTools` from "@fitzzero/quickdraw-core/server/mcp".                                                                       |
| `McpMethodDefinition`          | MCP tools are generated from the contracts: `createMcpRegistry({ services, dispatcher })` and `describeTools` from "@fitzzero/quickdraw-core/server/mcp".                                                                       |
| `McpMethodContext`             | MCP tools are generated from the contracts: `createMcpRegistry({ services, dispatcher })` and `describeTools` from "@fitzzero/quickdraw-core/server/mcp".                                                                       |
| `McpServiceInstance`           | MCP tools are generated from the contracts: `createMcpRegistry({ services, dispatcher })` and `describeTools` from "@fitzzero/quickdraw-core/server/mcp".                                                                       |
| `McpRegistryInstance`          | MCP tools are generated from the contracts: `createMcpRegistry({ services, dispatcher })` and `describeTools` from "@fitzzero/quickdraw-core/server/mcp".                                                                       |
| `useService`                   | Call methods through the typed client: `qd.<service>.<method>.useMutation()`, or `.useQuery(input)` for a query (`qd = createQuickdrawClient(contracts)`).                                                                      |
| `useServiceMethod`             | Call methods through the typed client: `qd.<service>.<method>.useMutation()`, or `.useQuery(input)` for a query (`qd = createQuickdrawClient(contracts)`).                                                                      |
| `UseServiceOptions`            | Call methods through the typed client: `qd.<service>.<method>.useMutation()`, or `.useQuery(input)` for a query (`qd = createQuickdrawClient(contracts)`).                                                                      |
| `UseServiceResult`             | Call methods through the typed client: `qd.<service>.<method>.useMutation()`, or `.useQuery(input)` for a query (`qd = createQuickdrawClient(contracts)`).                                                                      |
| `useServiceQuery`              | Read with `qd.<service>.<method>.useQuery(input)`; a query that must follow writes declares `watch` in its contract.                                                                                                            |
| `UseServiceQueryOptions`       | Read with `qd.<service>.<method>.useQuery(input)`; a query that must follow writes declares `watch` in its contract.                                                                                                            |
| `UseServiceQueryResult`        | Read with `qd.<service>.<method>.useQuery(input)`; a query that must follow writes declares `watch` in its contract.                                                                                                            |
| `useSubscription`              | Subscribe to a row with `qd.<service>.useEntity(id)` (`useEntities(ids)` for several).                                                                                                                                          |
| `UseSubscriptionOptions`       | Subscribe to a row with `qd.<service>.useEntity(id)` (`useEntities(ids)` for several).                                                                                                                                          |
| `UseSubscriptionResult`        | Subscribe to a row with `qd.<service>.useEntity(id)` (`useEntities(ids)` for several).                                                                                                                                          |
| `useCollection`                | Collections are members of the typed client: `qd.<service>.<collection>.useCollection(scope, { view, load })`.                                                                                                                  |
| `useRoomEvents`                | Listen to a contract event with `qd.<service>.<event>.useEvent(handler)`.                                                                                                                                                       |
| `UseRoomEventsOptions`         | Listen to a contract event with `qd.<service>.<event>.useEvent(handler)`.                                                                                                                                                       |
| `QuickdrawRoomEventHandlers`   | Listen to a contract event with `qd.<service>.<event>.useEvent(handler)`.                                                                                                                                                       |
| `useChannelSend`               | Send on a channel with `qd.<service>.<channel>.useChannel()`.                                                                                                                                                                   |
| `UseChannelSendResult`         | Send on a channel with `qd.<service>.<channel>.useChannel()`.                                                                                                                                                                   |
| `useQuickdrawSocket`           | Read the connection with `useQuickdraw()` (`connection`, `status`, `userId`, `serviceAccess`), and talk to the server through the typed client rather than the socket.                                                          |
| `QuickdrawSocketContextValue`  | Read the connection with `useQuickdraw()` (`connection`, `status`, `userId`, `serviceAccess`), and talk to the server through the typed client rather than the socket.                                                          |
| `getOAuthUrl`                  | Link to `signInUrl(provider, { returnTo })` from `./client`: the auth routes kit starts a sign-in at `GET /auth/{provider}/start`.                                                                                              |
| `logout`                       | Call `signOut()` from `./client`: `POST /auth/logout` with the session cookie (and a stored token) revokes the session; it rejects when refused.                                                                                |
| `logoutAllDevices`             | Call `signOutEverywhere()` from `./client`: `POST /auth/logout-all` revokes every session of the user; it resolves with nothing.                                                                                                |
| `ServiceCallError`             | Failed calls throw `QuickdrawError`: branch on `error.code` (`FORBIDDEN`, `NOT_FOUND`, `VALIDATION`, `CONFLICT`, ...).                                                                                                          |
| `ClientServiceMethodMap`       | The typed client infers every type from the contracts passed to `createQuickdrawClient(contracts)`.                                                                                                                             |
| `SubscriptionDataMap`          | The typed client infers every type from the contracts passed to `createQuickdrawClient(contracts)`.                                                                                                                             |
| `applySnapshot`                | Renamed `applyCollectionSnapshot`; the collection helpers work on `CollectionState`; `liveDataOf(connection, queryClient)` holds the live collections.                                                                          |
| `applyPage`                    | Renamed `applyCollectionPage`; the collection helpers work on `CollectionState`; `liveDataOf(connection, queryClient)` holds the live collections.                                                                              |
| `applyDelta`                   | Use `applyCollectionDeltas`, which applies a batch; the collection helpers work on `CollectionState`; `liveDataOf(connection, queryClient)` holds the live collections.                                                         |
| `applyDeltas`                  | Use `applyCollectionDeltas`, which applies a batch; the collection helpers work on `CollectionState`; `liveDataOf(connection, queryClient)` holds the live collections.                                                         |
| `createEmptyEntry`             | Use `emptyCollection()`; the collection helpers work on `CollectionState`; `liveDataOf(connection, queryClient)` holds the live collections.                                                                                    |
| `CollectionCacheEntry`         | The collection state is `CollectionState`; the collection helpers work on `CollectionState`; `liveDataOf(connection, queryClient)` holds the live collections.                                                                  |
| `SocketTextField`              | The socket inputs were removed: keep your own input components and save with `qd.<service>.<method>.useMutation()` (a mutation with `id` and an `"entity"` output updates the cached row optimistically).                       |
| `SocketTextFieldProps`         | The socket inputs were removed: keep your own input components and save with `qd.<service>.<method>.useMutation()` (a mutation with `id` and an `"entity"` output updates the cached row optimistically).                       |
| `SocketCheckbox`               | The socket inputs were removed: keep your own input components and save with `qd.<service>.<method>.useMutation()` (a mutation with `id` and an `"entity"` output updates the cached row optimistically).                       |
| `SocketCheckboxProps`          | The socket inputs were removed: keep your own input components and save with `qd.<service>.<method>.useMutation()` (a mutation with `id` and an `"entity"` output updates the cached row optimistically).                       |
| `SocketSelect`                 | The socket inputs were removed: keep your own input components and save with `qd.<service>.<method>.useMutation()` (a mutation with `id` and an `"entity"` output updates the cached row optimistically).                       |
| `SocketSelectProps`            | The socket inputs were removed: keep your own input components and save with `qd.<service>.<method>.useMutation()` (a mutation with `id` and an `"entity"` output updates the cached row optimistically).                       |
| `SocketSlider`                 | The socket inputs were removed: keep your own input components and save with `qd.<service>.<method>.useMutation()` (a mutation with `id` and an `"entity"` output updates the cached row optimistically).                       |
| `SocketSliderProps`            | The socket inputs were removed: keep your own input components and save with `qd.<service>.<method>.useMutation()` (a mutation with `id` and an `"entity"` output updates the cached row optimistically).                       |
| `SocketSwitch`                 | The socket inputs were removed: keep your own input components and save with `qd.<service>.<method>.useMutation()` (a mutation with `id` and an `"entity"` output updates the cached row optimistically).                       |
| `SocketSwitchProps`            | The socket inputs were removed: keep your own input components and save with `qd.<service>.<method>.useMutation()` (a mutation with `id` and an `"entity"` output updates the cached row optimistically).                       |
| `useSocketInput`               | The socket inputs were removed: keep your own input components and save with `qd.<service>.<method>.useMutation()` (a mutation with `id` and an `"entity"` output updates the cached row optimistically).                       |
| `UseSocketInputOptions`        | The socket inputs were removed: keep your own input components and save with `qd.<service>.<method>.useMutation()` (a mutation with `id` and an `"entity"` output updates the cached row optimistically).                       |
| `UseSocketInputResult`         | The socket inputs were removed: keep your own input components and save with `qd.<service>.<method>.useMutation()` (a mutation with `id` and an `"entity"` output updates the cached row optimistically).                       |
| `CommitMode`                   | The socket inputs were removed: keep your own input components and save with `qd.<service>.<method>.useMutation()` (a mutation with `id` and an `"entity"` output updates the cached row optimistically).                       |

### Names that moved

| 4.x import                                                          | In 5.0                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `AuthRequest` from `@fitzzero/quickdraw-core/server`                | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `AuthResponse` from `@fitzzero/quickdraw-core/server`               | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `CookieResponse` from `@fitzzero/quickdraw-core/server`             | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `CookieSettings` from `@fitzzero/quickdraw-core/server`             | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `DEFAULT_MOCK_PATH_PREFIX` from `@fitzzero/quickdraw-core/server`   | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `DiscordUser` from `@fitzzero/quickdraw-core/server`                | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `GoogleUser` from `@fitzzero/quickdraw-core/server`                 | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `JWTPayload` from `@fitzzero/quickdraw-core/server`                 | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `MockOAuthProviderOptions` from `@fitzzero/quickdraw-core/server`   | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `MockOAuthRouter` from `@fitzzero/quickdraw-core/server`            | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `MockOAuthUser` from `@fitzzero/quickdraw-core/server`              | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `OAUTH_RETURN_ORIGIN_COOKIE` from `@fitzzero/quickdraw-core/server` | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `OAuthConfig` from `@fitzzero/quickdraw-core/server`                | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `OAuthProvider` from `@fitzzero/quickdraw-core/server`              | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `OAuthTokenResponse` from `@fitzzero/quickdraw-core/server`         | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `RegisterMockOAuthOptions` from `@fitzzero/quickdraw-core/server`   | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `RequireAuthOptions` from `@fitzzero/quickdraw-core/server`         | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `SESSION_COOKIE` from `@fitzzero/quickdraw-core/server`             | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `SessionCookieOptions` from `@fitzzero/quickdraw-core/server`       | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `ValidateOriginOptions` from `@fitzzero/quickdraw-core/server`      | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `clearSessionCookie` from `@fitzzero/quickdraw-core/server`         | Moved: import it from "@fitzzero/quickdraw-core/server/auth". Without a `cookieName` it clears the name `setSessionCookie` sets on the same request.                                                                                                                           |
| `createJWT` from `@fitzzero/quickdraw-core/server`                  | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `createMockOAuthProvider` from `@fitzzero/quickdraw-core/server`    | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `createOAuthURL` from `@fitzzero/quickdraw-core/server`             | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `createRequireAuth` from `@fitzzero/quickdraw-core/server`          | Moved: import it from "@fitzzero/quickdraw-core/server/auth". Without a `cookieName` it reads the names `setSessionCookie` sets on the same request (only `__Host-session` over HTTPS when the cookie has no domain).                                                          |
| `discordProvider` from `@fitzzero/quickdraw-core/server`            | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `exchangeOAuthCode` from `@fitzzero/quickdraw-core/server`          | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `extractBearerOrCookieToken` from `@fitzzero/quickdraw-core/server` | Moved: import it from "@fitzzero/quickdraw-core/server/auth". Without a `cookieName` it reads the names `setSessionCookie` sets on the same request (only `__Host-session` over HTTPS when the cookie has no domain).                                                          |
| `getDiscordAvatarUrl` from `@fitzzero/quickdraw-core/server`        | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `googleProvider` from `@fitzzero/quickdraw-core/server`             | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `isMockOAuthEnabled` from `@fitzzero/quickdraw-core/server`         | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `registerMockOAuthProvider` from `@fitzzero/quickdraw-core/server`  | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `setSessionCookie` from `@fitzzero/quickdraw-core/server`           | Moved: import it from "@fitzzero/quickdraw-core/server/auth". Without a `cookieName` it sets the name the auth routes give the response's request (`__Host-session` over HTTPS when the cookie has no domain, else `session`), which `socketAuth` and the HTTP transport read. |
| `validateRedirectOrigin` from `@fitzzero/quickdraw-core/server`     | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `verifyJWT` from `@fitzzero/quickdraw-core/server`                  | Moved: import it from "@fitzzero/quickdraw-core/server/auth".                                                                                                                                                                                                                  |
| `bootstrapMcpServer` from `@fitzzero/quickdraw-core/server`         | Moved: import it from "@fitzzero/quickdraw-core/server/mcp".                                                                                                                                                                                                                   |
| `createMcpStdioServer` from `@fitzzero/quickdraw-core/server`       | Moved: import it from "@fitzzero/quickdraw-core/server/mcp".                                                                                                                                                                                                                   |
| `McpStdioServerOptions` from `@fitzzero/quickdraw-core/server`      | Moved: import it from "@fitzzero/quickdraw-core/server/mcp".                                                                                                                                                                                                                   |
| `McpRegistryOptions` from `@fitzzero/quickdraw-core/server`         | Moved: import it from "@fitzzero/quickdraw-core/server/mcp".                                                                                                                                                                                                                   |
| `McpRegistry` from `@fitzzero/quickdraw-core/server`                | Moved to "@fitzzero/quickdraw-core/server/mcp", where the registry is created with `createMcpRegistry({ services, dispatcher })` (`McpRegistry` is now its type, not a class).                                                                                                 |
| `QuickdrawSocket` from `@fitzzero/quickdraw-core/server`            | The server's socket type is gone: handlers receive `ctx` (`ctx.principal`, `ctx.rooms`, `ctx.transport`) instead of the socket.                                                                                                                                                |

### Entry points

| 4.x entry point                                  | In 5.0                                                                                                                                                                                                                |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@fitzzero/quickdraw-core/server/testing`        | Use `createTestApp({ services, db })` from "@fitzzero/quickdraw-core/testing" (`app.as(principal)` calls in process, `app.connect(principal)` opens a real socket); `emitWithAck` and `waitForEvent` moved there too. |
| `@fitzzero/quickdraw-core/server/testing/prisma` | Moved to "@fitzzero/quickdraw-core/testing/prisma", with the same functions.                                                                                                                                          |
| `@fitzzero/quickdraw-core/client/testing`        | Use `createMockClient(contracts)` or `renderWithQuickdraw(ui, { app, as })` from "@fitzzero/quickdraw-core/testing/client".                                                                                           |
| `@fitzzero/quickdraw-core/eslint-plugin`         | The lint rules moved to the oxlint plugin "@fitzzero/quickdraw-lint", which its `oxlint.base.jsonc` loads.                                                                                                            |
| `@fitzzero/quickdraw-core/eslint-config`         | Extend "@fitzzero/quickdraw-lint/oxlint.base.jsonc" from the app's oxlint config instead.                                                                                                                             |

### Service methods

| 4.x method                       | In 5.0                                                                                                                                                                                                            |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineMethod()`                 | Implement methods in `qd.defineService(contract, { methods: { name: { access, handler } } })`.                                                                                                                    |
| `verifyAllMethods()`             | `qd.defineService` checks at compile time that `methods` implements every method of the contract.                                                                                                                 |
| `emitUpdate()`                   | Entity frames follow tracked writes: write through `db.<model>`, or record a write the client cannot see with `ctx.touch(model, ids)`.                                                                            |
| `emitCollectionUpsert()`         | Collection deltas follow tracked writes: write through `db.<model>`, or record a write the client cannot see with `ctx.touch(model, ids)`.                                                                        |
| `emitCollectionRemove()`         | Collection deltas follow tracked writes: write through `db.<model>`, or record a write the client cannot see with `ctx.touch(model, ids)`.                                                                        |
| `emitCollectionMove()`           | Collection deltas follow tracked writes: write through `db.<model>`, or record a write the client cannot see with `ctx.touch(model, ids)`.                                                                        |
| `notifyCollections()`            | Collection deltas follow tracked writes: write through `db.<model>`, or record a write the client cannot see with `ctx.touch(model, ids)`.                                                                        |
| `emitCollectionReset()`          | Send one scope a reset with `qd.collections.reset(contract, collection, scope)`.                                                                                                                                  |
| `kickFromCollection()`           | Revocation is automatic: a tracked write that lowers someone's access removes their sockets from the scope and sends `qd:revoked`.                                                                                |
| `emitToRoom()`                   | Declare the event in the contract's `events` and send it with `ctx.rooms.emit(room, contract, event, payload)`.                                                                                                   |
| `emitToUserRoom()`               | Send to one user with `ctx.rooms.emitToUser(userId, contract, event, payload)`.                                                                                                                                   |
| `emitToRoomVolatile()`           | Declare a stream with `volatile: true` in the contract's `streams` and push with `qd.stream(contract, name).push(...)`.                                                                                           |
| `defineCollection()`             | Declare collections in the contract (`collections: { name: { scope, item, order } }`) and anchor them in `qd.defineService(contract, { collections: { name: { anchor } } })`; their deltas follow tracked writes. |
| `defineChannel()`                | Declare channels in the contract (`channels: { name: { payload } }`), handle them in `qd.defineService(contract, { channels })`, and send with `qd.<service>.<channel>.useChannel()`.                             |
| `installAdminMethods()`          | Use the admin kit: `...admin.contract({ entity })` in the contract and `...admin.handlers(contract, options)` in `methods`.                                                                                       |
| `setDelegate()`                  | Name the service's model in `qd.defineService(contract, { model: "chat" })`; handlers write through `db.<model>`.                                                                                                 |
| `checkEntryACL()`                | Row access comes from a policy on `qd.defineService(contract, { access })` (`owner`, `jsonAcl`, `members`, `inherit`, `everyone`, `anyOf`, `resolver`) and each method's `access` form.                           |
| `checkBatchSubscriptionAccess()` | Row access comes from a policy on `qd.defineService(contract, { access })` (`owner`, `jsonAcl`, `members`, `inherit`, `everyone`, `anyOf`, `resolver`) and each method's `access` form.                           |
| `ensureAccessForMethod()`        | Row access comes from a policy on `qd.defineService(contract, { access })` (`owner`, `jsonAcl`, `members`, `inherit`, `everyone`, `anyOf`, `resolver`) and each method's `access` form.                           |
| `getProtectedFields()`           | Field tiers are declared in the contract's `fields` (`fields: { notes: "Admin" }`) and stripped per caller.                                                                                                       |
| `hasElevatedAccess()`            | Field tiers are declared in the contract's `fields` (`fields: { notes: "Admin" }`) and stripped per caller.                                                                                                       |

### Option keys

| 4.x option     | In 5.0                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `invalidateOn` | Give the query a `watch` in its contract (`query({ input, output, watch: { collection, scope } })`): it is refetched when that scope changes. |
| `hasEntryACL`  | Declare the row policy in `qd.defineService(contract, { access: jsonAcl("acl", { owner: "ownerId" }) })`.                                     |

### QuickdrawProvider props

| 4.x prop            | In 5.0                                                                                                                                                                 |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `serverUrl`         | Pass `url`, and the typed client as `client`: `<QuickdrawProvider client={qd} url={url} auth={token}>`.                                                                |
| `authToken`         | Pass the credentials as `auth`: a token string or handshake fields.                                                                                                    |
| `autoConnect`       | The provider connects when it mounts; render it once the credentials are known, or change `auth`.                                                                      |
| `withCredentials`   | Pass Socket.IO options in `socketOptions`: `socketOptions={{ withCredentials: true }}`.                                                                                |
| `socketPath`        | Pass Socket.IO options in `socketOptions`: `socketOptions={{ path }}`.                                                                                                 |
| `reconnectBehavior` | Removed: after a reconnect only watched or stale queries refetch, each after a random delay of up to `reconnectJitterMs` (2,000 ms by default; `0` refetches at once). |

<!-- removed-names:end -->
