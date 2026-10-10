# @fitzzero/quickdraw-core

Typed real-time fullstack services on Socket.IO, TanStack Query and Prisma.
A service is declared once, as a contract in the app's shared package; the
server implements it and the client is typed from it. Writes are tracked, so
every subscriber's live rows, lists and cached queries follow them without a
single hand-written event.

- **Contracts**: methods, projections, field tiers, collections, streams,
  channels and events, as plain data plus schemas (Standard Schema; Zod 4.2
  or later where JSON Schema is needed).
- **Services**: `qd.defineService(contract, { ... })`, one handler per
  method, access declared and failing closed, row policies shared by every
  surface.
- **Live data**: tracked Prisma writes become entity frames, collection
  deltas and change topics, with revisions, resume after reconnect, and
  revocation when access is lost.
- **Client**: `qd.<service>.<member>` hooks over TanStack Query, live
  entities and collections, optimistic mutations, one invalidation
  coordinator.
- **Kits**: read/write, search, sharing and membership, admin, presence and
  streams, auth routes.
- **Transports**: Socket.IO (protocol 5), HTTP, in process, MCP, and a shim
  for 4.x clients.
- **Testing**: a real test server, access matrices, performance budgets that
  count statements and bytes, strict development warnings.

Design record: [`docs/rfcs/0003-v5.md`](docs/rfcs/0003-v5.md).

## Install

```bash
bun add @fitzzero/quickdraw-core zod
bun add express socket.io @prisma/client                   # the server
bun add socket.io-client @tanstack/react-query react        # the web app
bun add -d @fitzzero/quickdraw-lint @fitzzero/quickdraw-skills oxlint
```

Node 24 or later. Every peer dependency is optional: install the ones the
entries you import need.

| Entry                                   | Needs                                                                   |
| --------------------------------------- | ----------------------------------------------------------------------- |
| `.` (contracts, errors, protocol types) | a Standard Schema library: Zod 4.2 or later where JSON Schema is needed |
| `./server`, `./server/mcp`              | `socket.io`; an Express 4 or 5 app (or none) for the HTTP transport     |
| `./server/auth`                         | `express-rate-limit` for its default sign-in limits                     |
| `./server/express`                      | `express-rate-limit`                                                    |
| `./server/otel`                         | `@opentelemetry/api`                                                    |
| `./prisma`                              | `@prisma/client` 7                                                      |
| `./client`                              | `socket.io-client`, `@tanstack/react-query` 5, `react` 19               |
| `./utils`, `./parser`                   | nothing more                                                            |
| `./testing`                             | `socket.io`, `socket.io-client`                                         |
| `./testing/client`                      | the `./client` peers, and `@testing-library/react`                      |
| `./testing/prisma`                      | `pg` or `@electric-sql/pglite`                                          |

## Quick start

A board of tasks in the quickdraw template's layout: contracts in
`packages/shared`, the server in `apps/api`, the web app in `apps/web`. The
examples in this README compile: they are copies of
[`packages/core/test/readme/`](https://github.com/fitzzero/quickdraw/tree/main/packages/core/test/readme),
which the package's typecheck builds. The pieces the quick start imports
without showing (the schemas, the auth helpers, the Prisma models) are under
[The example app](#the-example-app).

### 1. The contract

`packages/shared/src/contracts/task.ts`. The shared package exports the
contracts, and a map of them for the client:
`contracts = { label, project, task }`.

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

### 2. The service

The app states its types once, with one tracked database client.

<!-- example: apps/api/src/db.ts -->

```ts
import { trackPrisma } from "@fitzzero/quickdraw-core/prisma";
import { prisma } from "@project/db";

// Every write through `db` is tracked: subscribers see it. Apply trackPrisma
// last, after any other client extension.
export const db = trackPrisma(prisma);
```

<!-- example: apps/api/src/quickdraw.ts -->

```ts
import { initQuickdraw, type Principal } from "@fitzzero/quickdraw-core/server";
import type { contracts } from "@project/shared";
import type { db } from "./db";

/** Who calls: a signed-in user, or an agent acting for one. */
export interface AppPrincipal extends Principal {
  readonly kind: "user" | "agent";
}

// The app's types, stated once: every service, handler and caller is typed from them.
export const qd = initQuickdraw<{
  db: typeof db;
  principal: AppPrincipal;
  contracts: typeof contracts;
}>();
```

`apps/api/src/services/task.ts` implements every method of the contract,
each with its access: the read/write kit's `get` and `create` in one spread,
and a handler for each of the others:

<!-- example: apps/api/src/services/task.ts -->

```ts
import { crud, inherit } from "@fitzzero/quickdraw-core/server";
import { projectContract, taskContract } from "@project/shared";
import { qd } from "../quickdraw";

export const taskService = qd.defineService(taskContract, {
  // the Prisma model its rows live in
  model: "task",
  // the level on the task's project
  access: inherit({ from: projectContract, via: "projectId" }),
  // a board opens with Read on its project
  collections: { board: { anchor: projectContract } },
  methods: {
    // the kit implements get and create; each names who may call it
    ...crud.handlers(taskContract, {
      access: {
        get: { entry: "Read" },
        create: { scope: "Moderate", of: projectContract, id: "projectId" },
      },
    }),
    rename: {
      access: { entry: "Moderate" },
      // return the row: the framework sends the projection's fields, dates as ISO strings
      handler: ({ input, db }) =>
        db.task.update({ where: { id: input.id }, data: { title: input.title } }),
    },
    countOnBoard: {
      access: { scope: "Read", of: projectContract, id: "projectId" },
      // identical concurrent calls by one user run once
      share: "caller",
      handler: ({ input, db }) => db.task.count({ where: { projectId: input.projectId } }),
    },
  },
});
```

### 3. The server

`apps/api/src/index.ts`: the services on the app's own Express app.

<!-- example: apps/api/src/index.ts -->

```ts
import { socketAuth } from "@fitzzero/quickdraw-core/server/auth";
import express, { type Express } from "express";
import { jwtSecret, loadGrants, sessions } from "./auth";
import { db } from "./db";
import { qd, type AppPrincipal } from "./quickdraw";
import { labelService } from "./services/label";
import { projectService } from "./services/project";
import { taskService } from "./services/task";

// the web app's origins: CORS, and the pages that may open a socket with the session cookie
const webOrigins = ["http://localhost:3000"];

export const app: Express = express();

export const server = qd.createServer({
  // the HTTP transport is mounted on it: POST /qd/{service}/{method}
  app,
  services: [labelService, projectService, taskService],
  db,
  cors: { origin: webOrigins, credentials: true },
  auth: {
    // the session cookie the auth routes set, else a bearer token (`auth.token`); none is anonymous
    authenticate: socketAuth({
      sessions,
      jwtSecret,
      allowedOrigins: webOrigins,
      loadPrincipal: (userId): AppPrincipal => ({ userId, kind: "user" }),
    }),
    loadServiceAccess: (userId) => loadGrants(userId),
    // a tracked write to User.serviceAccess refreshes that user's open sockets
    serviceAccessSource: { model: "user", column: "serviceAccess" },
  },
  // close on SIGTERM and SIGINT; the process is never exited
  handleSignals: true,
});

server.httpServer.listen(4000);
```

### 4. The client

<!-- example: apps/web/src/lib/quickdraw.ts -->

```ts
import { createQuickdrawClient } from "@fitzzero/quickdraw-core/client";
import { contracts } from "@project/shared";

// One typed client for the app: qd.task and qd.project, from the contracts.
export const qd = createQuickdrawClient(contracts);
```

<!-- example: apps/web/src/app/providers.tsx -->

```tsx
"use client";

import { QuickdrawProvider } from "@fitzzero/quickdraw-core/client";
import type { ReactNode } from "react";
import { qd } from "../lib/quickdraw";

export function Providers({ children }: { readonly children: ReactNode }) {
  // Cookie sessions need no `auth`; a bearer token is `auth={token}`.
  return (
    <QuickdrawProvider client={qd} url="http://localhost:4000">
      {children}
    </QuickdrawProvider>
  );
}
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

When another user adds, renames or moves a task, the board changes at once,
and `countOnBoard` is fetched again because it watches the board.

### The example app

The quick start is part of a small app in the template's layout, whose
every file compiles with the package:
[`packages/core/test/readme/`](https://github.com/fitzzero/quickdraw/tree/main/packages/core/test/readme).
The label and project services the server registers are there, with the
other sections' examples. These are the pieces the quick start imports
without showing, which an app writes itself.

The schemas the contracts are built on, `packages/shared/src/schemas.ts`
(the shared package exports them beside the contracts):

<!-- example: packages/shared/src/schemas.ts -->

```ts
import { z } from "zod";

export const projectSchema = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });

export const taskSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.string(),
  ordinal: z.number(),
  assigneeId: z.string().nullable(),
  notes: z.string().nullable(),
});

/** The lean shape a board shows. */
export const cardSchema = taskSchema.omit({ notes: true });
```

The sessions, the secret and the grants the server reads,
`apps/api/src/auth.ts`. Sessions are issued by the auth routes, mounted on
the same `app` (see the [auth routes kit](#auth-routes-kit)):

<!-- example: apps/api/src/auth.ts -->

```ts
// The app's sessions, token check and grants, for the README's server examples.

import type { AccessLevel } from "@fitzzero/quickdraw-core";
import { createMemorySessionStore, verifyJWT } from "@fitzzero/quickdraw-core/server/auth";
import { db } from "./db";
import type { AppPrincipal } from "./quickdraw";

/** Signs the session JWTs: one secret for the auth routes and `socketAuth`, 32 characters or more. */
export const jwtSecret = process.env.JWT_SECRET ?? "";

/** The sessions the auth routes issue. In production, a store over the database (see the auth routes kit). */
export const sessions = createMemorySessionStore();

/** The user a bearer token signs in, or `null` for no token. */
export async function verifySession(token: unknown): Promise<AppPrincipal | null> {
  if (typeof token !== "string") {
    return null;
  }
  const payload = await verifyJWT(token, jwtSecret);
  return payload === null ? null : { userId: payload.userId, kind: "user" };
}

/** A user's service-wide grants, as stored in `User.serviceAccess`. */
export async function loadGrants(userId: string): Promise<Record<string, AccessLevel>> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { serviceAccess: true } });
  const stored: unknown = user?.serviceAccess;
  return typeof stored === "object" && stored !== null
    ? (stored as Record<string, AccessLevel>)
    : {};
}
```

The Prisma models of `@project/db` (`packages/db/prisma/schema.prisma`),
`User.serviceAccess` among them, which `loadGrants` reads and
`serviceAccessSource` watches:

<!-- example: ../prisma/schema.prisma#models -->

```prisma
model User {
  id            String          @id @default(cuid())
  email         String          @unique
  name          String
  // Service-wide grants, as 4.x apps store them: { "taskService": "Admin" }.
  serviceAccess Json?
  ownedProjects Project[]
  memberships   ProjectMember[]
  assigned      Task[]
}

model Project {
  id        String          @id @default(cuid())
  name      String
  ownerId   String
  // A JSON access list, [{ userId, level }].
  acl       Json?
  archived  Boolean         @default(false)
  owner     User            @relation(fields: [ownerId], references: [id])
  members   ProjectMember[]
  tasks     Task[]
  labels    Label[]
}

// A membership table: role holds an access level ("Read" | "Moderate" | "Admin").
model ProjectMember {
  id        String  @id @default(cuid())
  projectId String
  userId    String
  role      String
  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)
  user      User    @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@unique([projectId, userId])
  @@index([userId])
}

model Task {
  id           String      @id @default(cuid())
  projectId    String
  parentTaskId String?
  status       String      @default("open")
  ordinal      Int         @default(0)
  title        String
  assigneeId   String?
  notes        String?
  // A flag and a JSON column: every field type the admin kit edits.
  pinned       Boolean     @default(false)
  details      Json?
  createdAt    DateTime    @default(now())
  updatedAt    DateTime    @updatedAt
  project      Project     @relation(fields: [projectId], references: [id], onDelete: Cascade)
  parent       Task?       @relation("Subtasks", fields: [parentTaskId], references: [id], onDelete: SetNull)
  subtasks     Task[]      @relation("Subtasks")
  assignee     User?       @relation(fields: [assigneeId], references: [id], onDelete: SetNull)
  labels       TaskLabel[]

  @@index([projectId, status, ordinal])
}

model Label {
  id        String      @id @default(cuid())
  projectId String
  name      String
  project   Project     @relation(fields: [projectId], references: [id], onDelete: Cascade)
  tasks     TaskLabel[]
}

model TaskLabel {
  id      String @id @default(cuid())
  taskId  String
  labelId String
  task    Task   @relation(fields: [taskId], references: [id], onDelete: Cascade)
  label   Label  @relation(fields: [labelId], references: [id], onDelete: Cascade)

  @@unique([taskId, labelId])
  @@index([labelId])
}
```

## Contracts

A contract is plain data plus schemas, so browser code imports it without
any server code (design: `docs/rfcs/0003-v5.md`, section 2).

<!-- example: packages/shared/src/contracts/examples.ts#outputs -->

```ts
export const labelContract = defineContract("labelService", {
  describe: "Labels a project puts on its tasks.",
  entity: labelSchema,
  projections: { chip: z.object({ id: z.string(), name: z.string() }) },
  methods: {
    find: query({
      input: z.object({ name: z.string() }),
      output: nullable("entity"),
      describe: "Finds a label by its name, or null.",
    }),
    chips: query({
      input: z.object({ projectId: z.string() }),
      output: listOf("chip"),
      describe: "Lists a project's labels as chips.",
    }),
    usage: query({
      input: z.undefined(),
      output: z.record(z.string(), z.number()),
      describe: "Counts the tasks of each label.",
    }),
  },
});

// No entity: an RPC-only service, with no projections, field tiers or collections.
export const healthContract = defineContract("healthService", {
  describe: "Tells a caller the server is up.",
  methods: {
    ping: query({
      input: z.undefined(),
      output: z.literal("pong"),
      describe: "Answers pong while the server runs.",
    }),
  },
});
```

- Every method is a `query` or a `mutation`, with an `input` and an
  `output`. The kind decides request sharing, cancellation, the concurrency
  cap, the MCP read-only hint and which client hook exists.
- Every member takes a `describe`, a sentence or two for people and agents:
  the contract itself (what the service is for), each method (its MCP tool's
  description), collection, stream, channel and event. `quickdraw-docs`
  leads each section of the API docs with it. It is optional in the types;
  lint's `require-describe` (a warning) lists each member without one.
- `output` is a schema, or a projection: `"entity"`, a named projection,
  `nullable("entity")` or `listOf("card")`. A handler returns database rows
  for a projection output, and the framework projects them.
- `entity` and every projection contain `id: string`. A contract without an
  `entity` is an RPC-only service.
- Only a query may `watch` (`{ collection, scope: (input) => scopeId }`): the
  client joins that scope's change topic and fetches the query again when it
  changes.
- Methods, collections, streams, channels and events share one namespace,
  because the client exposes each as `qd.<service>.<name>`. `subscribe`,
  `unsubscribe`, `call`, `then`, `useEntity`, `useEntities`, `admin` and
  names starting with `$` are reserved.
- Schemas are any Standard Schema. A projection's keys, admin field
  metadata, MCP tool schemas and `quickdraw-docs` read Standard JSON Schema,
  which Zod 4.2 or later provides; a projection whose schema cannot describe
  itself declares `keys` in the service's `project` option.

Types come from the contract too:

<!-- example: packages/shared/src/contracts/examples.ts#types -->

```ts
// { id: string; title: string }
export type RenameInput = InputOf<typeof taskContract, "rename">;
// the entity, as the wire has it
export type Task = OutputOf<typeof taskContract, "get">;
// one item of the board
export type Card = ItemOf<typeof taskContract, "board">;
```

`InputOf`, `ParsedInputOf`, `OutputOf`, `EntityOf`, `ProjectionOf`,
`ItemOf`, `ScopeOf`, `IndexRowOf`, `ViewName` and the rest are exported from
the package root. `FullProjectionOf<C, P>` is a projection's full row (what
a handler builds, every tiered field present), and `ReceivedRow<C, Row>`
makes a row's tiered fields optional, as a reader receives it.

## Services

`qd.defineService(contract, definition)` implements a contract (design:
section 3). `methods` must implement exactly the contract's methods; each is
`{ access, handler }`, plus `timeoutMs`, and for a query `share`, `ttlMs` and
`version`.

<!-- example: apps/api/src/services/examples/handlers.ts#handler -->

```ts
export const taskService = qd.defineService(task, {
  model: "task",
  methods: {
    assign: {
      access: { service: "Moderate" },
      // instead of the dispatcher's callTimeoutMs (30 s)
      timeoutMs: 5_000,
      handler: async ({ input, ctx, db }) => {
        const found = await db.task.findUnique({ where: { id: input.id } });
        if (found === null) {
          // the caller receives the code
          throw new QuickdrawError("NOT_FOUND", "No such task");
        }
        ctx.log.info("assigning", { by: ctx.principal.userId, transport: ctx.transport });
        return db.task.update({ where: { id: input.id }, data: { assigneeId: input.assigneeId } });
      },
    },
  },
});
```

- A handler receives `{ input, ctx, db }`: the input after its schema ran,
  the call's context, and the tracked database client. `ctx` holds
  `principal` (`userId`, `kind`, `claims`, `serviceAccess`; `null` only in a
  `"public"` method called anonymously), `signal` (aborts on cancel or time
  limit), `log`, `requestId`, `transport` (`"socket"`, `"http"`, `"mcp"`,
  `"internal"` or `"legacy"`), `touch` (below), `rooms` and `presence`
  (realtime, below), `mcp` (the MCP bridge's context) and `services`.
- `ctx.services` calls the app's services in process, as the same
  principal, by service name: `await ctx.services.projectService.get({ id })`.
  Each call runs the whole pipeline with transport `"internal"` (input
  check, access, handler, output check), so access is checked on the inner
  call too; its writes join the calling method's unit of work, so both
  flush together once; and it is cancelled with `ctx.signal`. It is typed
  by the `contracts` of `initQuickdraw`'s types, as `qd.caller` is.
- `share: "caller"` runs identical concurrent calls of one principal once,
  `share: "all"` across principals (not with `custom` access); `ttlMs` keeps
  a shared result. Callers of a shared run whose levels hide the same fields
  get one copy of its result, encoded once for all of their sockets.
  `version(input, ctx)` answers "not modified" for a query whose result the
  caller already holds.
- Every call runs a pipeline: look up, concurrency (16 queries in flight per
  socket and 64 queued, then `RATE_LIMITED`; mutations are not queued behind
  queries), input validation, access, "not modified", sharing, the handler
  under a time limit (30 s by default), the result shaped to its output
  (below), output validation outside production, the reply, the flush, and
  one completion record (`onCall`). A mutation ignores the caller's cancel:
  only its time limit stops it.
- A method's output is sent as it declares it, on every transport and in
  production too, so a handler may return the whole row: a projection
  output (`"entity"`, a named projection) sends the projection's keys,
  stripped per caller (below), and an output schema of the method's own
  sends what its JSON Schema declares (Zod 4.2 or later). An object keeps
  the keys its `properties` declare, and every key only where
  `additionalProperties` allows them (`z.looseObject`, `.catchall`) or it is
  a record; an array keeps its items, each reduced by its item schema; a
  union keeps what any branch declares; a value the schema allows to be
  anything (`z.unknown()`, a `Date`) goes as it is. An output schema
  without JSON Schema (Zod 3) is sent as the handler returns it.

Errors are `QuickdrawError(code, message, data?)`. Anything else a handler
throws reaches the caller as `INTERNAL` with a generic message, and is
logged; Prisma's unique violation becomes `CONFLICT` and its missing row
`NOT_FOUND`.

| Code              | HTTP | Meaning                                            |
| ----------------- | ---- | -------------------------------------------------- |
| `UNAUTHENTICATED` | 401  | no principal                                       |
| `FORBIDDEN`       | 403  | access denied                                      |
| `NOT_FOUND`       | 404  | unknown service, method or row                     |
| `CONFLICT`        | 409  | unique or state conflict                           |
| `VALIDATION`      | 422  | input failed its schema; `data.issues` lists paths |
| `RATE_LIMITED`    | 429  | limiter or queue overflow; `data.retryAfterMs`     |
| `CANCELLED`       | 499  | the caller cancelled                               |
| `TIMEOUT`         | 504  | the handler ran past its time limit                |
| `INTERNAL`        | 500  | everything else                                    |

An app adds its own fields to every `ctx` once, through `initQuickdraw`:

<!-- example: apps/api/src/services/examples/context.ts#context -->

```ts
interface AppContext {
  /** The tenant every query of this call is scoped to. */
  readonly tenantId: string;
}

export const qd = initQuickdraw<{ db: typeof db; principal: Principal; context: AppContext }>({
  // runs once per call, before access is checked, so custom checks see it too
  context: (base) => ({ tenantId: String(base.principal?.claims?.tenant ?? "public") }),
});
```

## Access control

Each method declares who may call it, and a service with rows declares one
access policy that says how a principal's level on a row is found (design:
section 4). Everything fails closed: a method without `access` does not
compile, and a missing grant, an unknown level, a missing id, a row that does
not exist or a malformed access list denies.

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

- Forms: `"public"`, `"authenticated"`, `{ service: L }` (the user's
  service-wide grant), `{ entry: L, id? }` (the policy's level on the row;
  `id` defaults to `input.id`), `{ service: L1, entry: L2 }` (either),
  `{ scope: L, of, id }` (the level on a row of another service) and
  `custom(fn)`. Without a principal every form but `"public"` answers
  `UNAUTHENTICATED`; a principal that fails gets `FORBIDDEN`. The levels,
  lowest first, are `Public`, `Read`, `Moderate` and `Admin`.
- On a service with a policy, a method whose input has `id` under a form
  that checks no row (`"public"`, `"authenticated"`, `{ service: L }` below
  `Admin`) would let anyone that form admits reach any row by its id, so
  `defineService` refuses it, naming the method and the two ways out: a form
  the policy decides (`{ entry: L }`, or `{ service: L, entry: L }` to keep
  the grant), or `rowless: true` on the method when every such caller may
  reach any row on purpose (the `title` method above; public profiles,
  lookups by an id that tells nothing). A kit's methods take it as
  `rowless: ["get"]` in the kit's options. The input's keys come from its
  JSON Schema: an `id` in any branch of a union counts, and so does one
  beside a value JSON Schema cannot write (a `Date`, a `Set`). Not checked:
  an input without JSON Schema (Zod 3), one that is no object (a bare string
  that is the id itself) and a row named by another key (`ids`, `taskId`, a
  nested `where.id`).
- A service-wide `Admin` grant passes every check on its service
  (`adminBypass: false` turns that off). A grant below `Admin` counts only
  where the form names `service`: a `Read` grant does not read every row.
- Grants come from `principal.serviceAccess`, as `authenticate` returns it or
  `createServer({ auth: { loadServiceAccess } })` loads it for a principal
  that carries none: at a socket's handshake, for each HTTP call, and for
  an in-process caller (`qd.caller`) at its first call. With
  `auth.serviceAccessSource: { model: "user", column: "serviceAccess" }`, a
  tracked write to that column refreshes the user's open sockets
  (`qd:access`), and in-process callers load the grants again.
- Policies: `owner(field)`, `jsonAcl(field, { owner? })`,
  `members({ model, entry, user, level, levels? })`, `inherit({ from, via })`,
  `anyOf(...)`, `resolver({ levelsFor, where?, reads })` and `everyone(level)`
  (every signed-in user has `level` on every row, reading nothing: public
  profiles are `anyOf(owner("id"), everyone("Read"))`; unlike `rowless: true`
  on a method, it covers subscriptions and lists too). A `resolver` is app
  code, so it says what its levels depend on: `reads: { columns, memberships }`
  names columns of the service's model and membership tables as `members`
  takes them (`entry` holding this service's row id), and tracked writes to
  them re-check what it decided, as for the other policies; `reads: "none"`
  says nothing a tracked write changes can change a level (the principal's
  grants alone, say). A resolver with neither is never re-checked, and the
  server warns `[quickdraw:resolver-without-reads]` when it starts. Their
  column and table names are checked against the Prisma client's models at
  compile time. A lookup is one batched query per table, memoized for the
  call, so checking 60 ids costs what checking one does. `entry` access
  needs a policy; a service without `model` may only use `"public"`,
  `"authenticated"`, `{ service }` and `custom`. `inherit` uses the
  parent's policy only: grants on the parent's service do not flow down.
- One policy decides every surface: method calls, entity subscriptions,
  collection scopes, the kits' lists and searches, streams and channels.
- When a tracked write lowers or removes someone's access, their sockets
  leave the rooms anchored on that row and get `qd:revoked`; a changed level
  moves them to that level's room. In a cluster the change is broadcast to
  every node.
- `server.dispatcher.access` gives the same answers to other code:
  `levelsFor(service, principal, ids)`, `accessWhere(service, principal, level)`
  (a `where` filter for `findMany`, or `"none"`) and `onAccessChanged(listener)`.
- `createServer({ access: { cacheMs: 30_000 } })` keeps policy lookups across
  requests; tracked writes to the columns and membership tables the policies
  read evict them. Writes the tracked client cannot see are picked up only
  when the time passes, so the cache is off by default.

## Tracked writes

`@fitzzero/quickdraw-core/prisma` wraps the app's Prisma client so the
framework sees every write made through it (design: section 5). Pass the
tracked client as `db`; the server finds the rest on it.

- Every handler runs in a unit of work. Each `create`, `update`, `upsert`,
  `delete`, `createMany`, `updateMany` and `deleteMany` made through `db` is
  recorded with its row ids, merged per row, and handed to the flush sinks
  once the response has been sent, with one revision per flush. A handler
  may return `db.task.update(...)` without awaiting it.
- A write that certainly changed nothing is not recorded, so it sends no
  frame, no collection delta, no topic change and no `refreshEntry`: an
  `updateMany`, `updateManyAndReturn` or `deleteMany` that matched no row,
  and a `data` (or an upsert's `update`) with nothing to write, `{}`. An
  upsert with `update: {}` ("make sure this row exists") reads the row
  first in its place: one statement when the row is there, and the upsert
  after it when it is not. Every other write is recorded, one that sets a
  column to the value it already held too: the values the framework reads
  before a write cannot prove it changed nothing, since another write may
  land between that read and the write.
- Writes inside `db.$transaction` join the unit only when it commits; a
  rollback drops them. Prefer the interactive form
  (`db.$transaction(async (tx) => ...)`): an array-form
  `db.$transaction([...])` has no transaction client, so the rows a
  `deleteMany` or `updateMany` in it reads first, and the old values an
  `update` that moves a row or changes who may see it reads first, are read
  outside the batch, and rows its earlier statements changed may be missed
  (a development warning names the model and operation).
- Write many rows in one statement when every row gets the same data
  (`updateMany`, `createMany`). When each row's data differs (moving tasks
  to different projects, say), write each row by id inside an interactive
  transaction: inside `db.$transaction(async (tx) => ...)`, loop over the
  rows and await `tx.task.update({ where: { id }, data })` for each. Neither
  the N+1 warning nor `no-db-call-in-loop` counts those writes.
- A service lists the other models its handlers write
  (`writes: ["taskLabel"]`); the `no-foreign-write` lint rule checks it.
- Jobs, scripts and webhooks wrap their writes in `qd.run(fn)`, which
  flushes before it returns. A write made outside any unit of work flushes
  on its own on the next tick, with a development warning. Inside a
  handler `qd.run` joins the handler's unit; background work the reply does
  not wait for (a push sent after a message, pruning what it reports dead)
  runs in `qd.run(fn, { detached: true })`, a unit of its own that flushes
  when `fn` settles (catch what the promise rejects with: nothing awaits it).
  Before any server exists (a seed at boot, before `createServer`),
  `qd.run(fn)` still runs `fn` in a unit of its own, and its writes reach no
  one: no socket can be subscribed yet (behind a cluster, write after
  `createServer` when other nodes' subscribers must hear of it).

<!-- example: apps/api/src/jobs/overdue.ts#run -->

```ts
export async function markStale(before: Date): Promise<number> {
  // a job's writes flush to subscribers when qd.run settles, as a method's do
  const { count } = await qd.run(() =>
    db.task.updateMany({
      where: { status: "open", updatedAt: { lt: before } },
      data: { status: "stale" },
    }),
  );
  return count;
}
```

- Not seen: nested writes (`{ labels: { create: [...] } }`, which warn in
  development), raw SQL and database cascades. Record raw SQL with
  `ctx.touch("task", ids)`, or `{ removed: true }` for deleted rows. A job
  gets the same `touch` from `qd.run`, whose `fn` receives
  `{ touch, log, principal: null }`:

<!-- example: apps/api/src/jobs/overdue.ts#touch -->

```ts
export async function spreadOrdinals(projectId: string): Promise<void> {
  await qd.run(async (ctx) => {
    const rows = await db.$queryRaw<{ id: string }[]>`
      UPDATE "Task" SET "ordinal" = "ordinal" * 2 WHERE "projectId" = ${projectId} RETURNING "id"`;
    // raw SQL is invisible to the tracked client: record the rows it changed
    ctx.touch(
      "task",
      rows.map((row) => row.id),
    );
  });
}
```

- Tracked models need a string `id` column; writes to other models pass
  through untracked, with one warning.
- `createServer({ flushSink })` adds the app's own sinks (an audit log, say);
  `createRecordingSink()` on `./testing` records what is flushed, for tests.

## Projections and entity subscriptions

A projection is the wire shape of a row (design: section 6). Its keys decide
what a read selects, so a row is never read wider than what is sent:

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

- A count over a relation reads the relation's ids (`labels: { select: { id: true } }`)
  and counts them in `map`: Prisma reads them for the rows read only (a
  second SQL query, `WHERE "taskId" IN (...)`). Its `_count` compiles to a
  `GROUP BY` over the whole relation table, joined in, on every snapshot,
  page and flush that reads the projection. For a relation too large to read
  (a chat's members), keep a counter column that the writes maintain.
- A projection's keys come from its schema's JSON Schema (Zod 4.2 or later),
  or from `project: { <name>: { keys } }`; a service whose projection has
  neither fails when it is defined. A handler returning a projection returns
  rows (a `Date` is fine where the wire has a string, a Prisma `Json` column
  (`JsonColumnValue`) where it has an object, an array or a record, and
  extra columns are dropped); with `map`, it returns what `map` takes.
- Fields the contract's `fields` map puts above the caller's level on a row
  are stripped from that caller's copy, after any shared run. Only a
  projection output is stripped per caller (`"entity"`, a named projection,
  and `nullable(...)` or `listOf(...)` of one): a method whose output is a
  schema of its own sends what that schema declares to every caller its
  access admits, so a tiered key the schema declares, at any depth (`email`
  in a hand-written `{ id, name, email }`, or in `{ user: { id, email } }`),
  reaches callers below its level. When a server is made, each such method
  raises the development warning `[quickdraw:tiered-field-in-output]`
  (thrown by `createTestApp({ strictWarnings: true })`, so the test app
  fails to start): answer `"entity"` or a projection, or drop the key from
  the schema. Not warned: a method whose access admits no caller below the
  field's level (`{ service: "Admin" }` with the Admin bypass on,
  `{ entry: L }` with `L` at the field's level or above), and a kit's
  methods, which strip their own replies. An output without JSON Schema
  (Zod 3) cannot be reduced, so in development each tiered key its replies
  carry raises the warning when a reply first carries it.
- `affects` names rows of other services a write changes too
  (`{ service, id: column }`, or `{ service, id: (row) => ids, columns }`);
  they are sent again after the flush, one hop.
- `qd.<service>.useEntity(id)` subscribes with `qd:sub { s, ids, revs? }` (up
  to 500 ids per batch), which authorizes every id in one lookup, reads the
  allowed rows in one query and joins the room of each row found for the
  subscriber's level. A socket is never in the room of a row it could not
  read.
- After each flush, subscribers get `qd:e`: `{ t: "u", s, id, rev, d }` with
  the whole row (a create, a touch, a projection with `map`, an `affects` row),
  `{ t: "p", s, id, rev, d }` with the changed fields only (an update of plain
  projection fields), or `{ t: "r", s, id, rev }` (a delete). One read per
  service per flush, none when no room has subscribers, and each frame is
  stripped once per subscriber tier.
- "Not modified" (for `qd:sub` and for queries returning one projection row
  by `id`) comes from `versionColumn`, or from an in-process change log of
  recent flushes. The change log sees only this process's writes: an app
  running several processes without a Socket.IO cluster adapter declares
  `versionColumn`s or passes `changeLog: false`.
- Revisions are microseconds since the epoch: a flush takes
  `max(Date.now() * 1000, last + 1)`. Clients compare them as numbers.
- Behind a cluster adapter (`setupRedisAdapter`), every touched row is read
  (deleted ones too) and sent, whole, decided by the row as read at flush
  time, since other nodes' rooms are not visible and frames from two nodes
  can arrive out of order; access changes and refreshed grants are
  broadcast to every node, and a flush sends its frames once every node
  applied them (without waiting while a node does not answer, fail-open).
  Flushes take their revisions from a counter in the cluster's Valkey, on
  Valkey's clock in microseconds, so revisions from all nodes are one order;
  its key needs persistence or replication. A node whose Valkey connection
  comes back has its clients reconnect to catch up.
  [docs/deploying.md](docs/deploying.md) has the wiring, what holds across
  nodes, what it costs, and what happens when a node or Valkey stops
  answering.

## Collections and change topics

A collection is the rows of one service grouped by a scope value (design:
section 7). The contract declares it; the service says whose policy
authorizes a scope:

<!-- example: apps/api/src/services/examples/collections.ts#contract -->

```ts
export const task = defineContract("taskService", {
  describe: "Tasks on a project's board.",
  entity: taskSchema,
  projections: { card: cardSchema },
  methods: { ...crud.contract({ entity: taskSchema, get: true }) },
  collections: {
    byProject: {
      describe: "A project's open tasks, in board order.",
      // a column holding the scope value
      scope: "projectId",
      // the projection each item is sent as
      item: "card",
      // membership: only open tasks
      where: { status: "open" },
      // ends in "id": the keyset cursor
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
      // sent for the whole scope
      index: ["ordinal", "assigneeId"],
      views: { mine: (row, who) => row.assigneeId === who.userId },
    },
    // each user's own
    assigned: {
      describe: "The tasks assigned to a user.",
      scope: "assigneeId",
      item: "card",
      order: [["id", "asc"]],
    },
  },
});
```

<!-- example: apps/api/src/services/examples/collections.ts#service -->

```ts
import { crud, inherit } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  // derived from the anchor
  access: inherit({ from: projectContract, via: "projectId" }),
  collections: {
    // Read on the project opens its scope
    byProject: { anchor: projectContract },
    // a user opens only the scope that is their id
    assigned: { scopeAccess: "self" },
  },
  // opens the service topic to Read grants; closed without it
  watchAccess: { service: "Read" },
  methods: { ...crud.handlers(task, { access: { get: { entry: "Read" } } }) },
});
```

- `scope` is a string column, or `via({ model, entry, scope })` for scopes
  that come from a junction table (a chat in each member's list). `order`
  ends in `id`; `limit` (default 100) and `maxLimit` (default 500) size its
  pages; `where` is an equality filter on membership; `access` is the level
  needed on the anchor (default `Read`).
- A junction write adds or removes its entry in the one scope it links.
  When the item reads the junction (a chat's `memberCount`), declare
  `via({ model, entry, scope, refreshEntry: true })`: every junction write
  then also sends the entry again, `updated`, to each scope that still
  holds it, for one more read of the item per flush.
- `qd:col:sub { s, c, scope }` authorizes the scope through its anchor's
  policy, then answers a page and joins the scope's room; flushes send `qd:c`
  deltas to it (`added`, `updated`, `patched`, `removed`, or `reset` for more
  than `bulkThreshold` rows, default 200). A `"self"` scope is the
  subscriber's own user id: its items are stripped at `Read`, and it may not
  declare a higher `access`.
- Items are visible to everyone in the scope: no per-row policy or field
  tier applies inside a collection. Derive the item service's own access
  from the anchor (`inherit` from it, as above): a per-row policy on the item
  service (an owner column, a row's access list) is not applied to
  collection items, so a row it would hide still reaches everyone in its
  scope.
- `index` sends one small row per member (`[id, rev, ...fields]`, up to
  50,000) with the first page, so the client knows the whole membership and
  order at once; `views` are pure predicates over index rows the client runs.
  When a collection declares `index`, every `order` column but `id` must be
  an index field.
- A deleted anchor row (a project, for its tasks) closes its scopes with
  `qd:revoked`; `qd.collections.reset(contract, collection, scope)` resets a
  scope after a change tracked writes cannot describe.
- `qd:watch { s, topic }` joins a change topic: `{collection}:{scope}`,
  authorized like a subscribe to that scope, or `service`, which changes
  whenever any row of the service does, or a row of a model it lists in
  `writes` (a game's high scores, which no service owns). A query declares
  `watch: "service"` to be invalidated by it. A query over some of those
  models names them, `watch: { service: ["gameScore"] }` (type
  `ServiceModelsWatch`; the service's `model` and models in its `writes`;
  `defineService` refuses others), and
  is invalidated only after a flush that wrote one of them: high scores are
  not read again when a chat membership the same service writes changes.
  It is the same topic: its `qd:changed` frame names the models that
  changed it (`models`). The service topic is closed
  (`FORBIDDEN`) unless the service declares `watchAccess` (`"public"`,
  `"authenticated"` or `{ service: level }`). A watcher that loses access
  leaves the topic after one last `qd:changed`.
- The socket rate limiter does not count subscription events; each socket
  runs `qd:sub`, `qd:col:sub`, `qd:col:items` and `qd:watch` in a lane
  instead: `limits.subscriptions` (8 at once, 64 waiting), then
  `RATE_LIMITED`.

## The server and its transports

`qd.createServer` attaches to the Express app and HTTP server the app already
owns, never listens or exits the process itself, and serves every service
over three transports (design: sections 3, 8 and 10):

- **Socket.IO** (protocol 5): a client connects with
  `auth: { token, qd: { protocol: 5, client } }`, receives `qd:hello` with the
  server's limits, who it acts for and the server's id (`serverId`, new
  each time a server starts: a reconnect that brings another one reached a
  restarted server, or another node), and calls through `qd:call` and
  `qd:cancel`. Every socket gets the same few listeners however many methods
  the services have. The JSON-only parser is the default; `binary: true`
  restores the stock one. The socket rate limiter is on by default (600
  events per minute per socket; channels, cancels and subscription events not
  counted); configure it with `rateLimit`, or turn it off with
  `rateLimit: false`. There is no default CORS origin: pass `cors`.
- **HTTP**: `POST /qd/{service}/{method}` with the input as a JSON body and
  `Content-Type: application/json` (required, even without a body, so a
  cross-site page cannot use a session cookie without a CORS preflight). The
  principal comes from the session cookie (`__Host-session` over HTTPS,
  `session` over plain HTTP or with `COOKIE_DOMAIN`, as the auth routes name
  it) or an `Authorization: Bearer` token through the same
  `authenticate`, which is told which one it was (`request.credential`):
  `socketAuth` answers a cookie sent from a page outside `allowedOrigins`
  with `FORBIDDEN`, as it refuses such a socket; the reply is `{ ok: true, d }` or
  `{ ok: false, e: { code, message, data? } }` with the code's HTTP status.
  Works on Express 4 and 5, and on a bare Node server. Move it with
  `http: { path }`, turn it off with `http: false`, or mount
  `createHttpRouter({ dispatcher, auth })` yourself. It has no rate limit of
  its own: on Express, set `http: { rateLimit: createCallLimiter() }` (from
  `./server/express`), which refuses with the `RATE_LIMITED` reply.
- **In process**: `server.dispatcher.caller(principal)` or
  `qd.caller(principal)`: `await qd.caller(user).taskService.rename(input)`,
  typed by the `contracts` of `initQuickdraw`'s types. A principal that
  carries no `serviceAccess` gets the grants `auth.loadServiceAccess`
  loads, as a socket's handshake and an HTTP call do: at the caller's first
  call, and again at its next call after the server applied new grants to
  a user (`server.access.refresh`, a tracked write to
  `auth.serviceAccessSource`). One that carries grants (even `{}`) keeps
  exactly those. A load that fails rejects the call with `INTERNAL`.

`authenticate` takes one request (`{ transport, auth, headers, socket | req }`)
for both transports and returns a principal, a user id, or nothing for an
anonymous caller; throwing `QuickdrawError("UNAUTHENTICATED", ...)` refuses.
Pass your own HTTP server as `httpServer` together with the `app` it was
created from (or with `http: false`).

`server.close()` disconnects every socket, waits for the calls still in
flight (a mutation runs to its end) and closes the HTTP server, giving up
after `shutdownTimeoutMs` (default 10 s); behind a cluster adapter it
disconnects its own sockets first, while the adapter still reaches the other
nodes, so their rooms hear `left`, and waits for that presence work (at most
`cluster.timeoutMs`), so the app can close its Valkey clients next.
`handleSignals: true` calls it on SIGTERM and SIGINT. `server.rotate({ withinMs })` asks clients to reconnect
within a window; `server.access.refresh(userId)` reloads a user's grants,
pushes `qd:access` and resolves the user's entity subscriptions again;
`server.access.disconnectUser(userId, { sessionId? })` ends a user's (or one
session's) sockets, on every node behind a cluster adapter.

### The 4.x legacy shim

With `legacyWire: true`, a client that connects without `auth.qd` is served
as a 4.x client instead of being refused with `PROTOCOL_MISMATCH`. The shim
serves request/response calls only: `socket.emit("taskService:get", payload, ack)`
runs through the 5.0 pipeline and is answered in the 4.x `ServiceResponse`
shape, `{ success: true, data }` or `{ success: false, error, code }`, with
the HTTP status of the error code as `code`. 4.x subscriptions, collections
and channels are not served. Each service, method and principal kind that
calls through the shim is logged once at `warn`, so the remaining 4.x
clients can be found.

### MCP bridge

`@fitzzero/quickdraw-core/server/mcp` serves the services to AI agents as MCP
tools generated from their contracts at startup: one tool per method, named
`{service}_{method}`, described by the method's `describe` text (without
one, by `service.method (kind)`, which tells an agent nothing), with the
input schema's JSON Schema as its arguments and `readOnlyHint` on every
query. The API docs print each method's default tool name and its read-only
hint. Every tool call goes through the dispatcher with transport `"mcp"`,
so input validation, access checks and limits apply exactly as on a socket.
A method whose input cannot describe itself as JSON Schema stops the
registry at startup, naming the method, unless it is excluded.

<!-- example: apps/api/src/mcp.ts#mcp -->

```ts
import {
  createMcpHttpRouter,
  createMcpRegistry,
  createMcpStdioServer,
} from "@fitzzero/quickdraw-core/server/mcp";

const summarizeInput = z.object({ projectId: z.string() });

const registry = createMcpRegistry({
  services: [projectService, taskService],
  dispatcher: server.dispatcher,
  // who a stdio session or an HTTP bearer token stands for; nothing is anonymous
  principal: (request) =>
    verifySession(request.transport === "http" ? request.token : process.env.AGENT_TOKEN),
  // handlers read it as ctx.mcp
  context: () => ({ scopes: ["tasks"] }),
  // or include: [...]; name: (service, method) => ...
  exclude: ["projectService.invite"],
  customTools: [
    {
      name: "summarize",
      description: "Counts the tasks of a project.",
      // validated before the handler runs, and types `arguments`
      inputSchema: summarizeInput,
      // access: "authenticated" is the default; "public" lets anonymous callers in
      handler: async ({ arguments: { projectId }, caller }) =>
        `${String(await caller.taskService.countOnBoard({ projectId }))} tasks`,
    },
  ],
});

// GET /mcp/tools, POST /mcp/invoke
app.use(createMcpHttpRouter({ registry }));
// in an MCP client's process
createMcpStdioServer({ registry, name: "my-app", version: "1.0.0" });
```

- **stdio** speaks JSON-RPC (MCP protocol version 2024-11-05). One process is
  one session: its queries share one concurrency lane, and
  `notifications/cancelled` cancels a call. When stdin ends, the calls still
  running finish and their replies are written before `closed` resolves
  (`server.close()` cancels them instead). Start its module through
  `bootstrapMcpServer(new URL("./mcp-server.js", import.meta.url))`, which
  sends console output to stderr so only the protocol reaches stdout.
- **HTTP**: `GET /mcp/tools` and `POST /mcp/invoke`, which takes
  `{ name, arguments }` and answers `{ success: true, data }`, or
  `{ success: false, error, code, data? }` with the code's HTTP status.
- An anonymous caller (the `principal` hook returned nothing) may call
  `"public"` methods, and custom tools that declare `access: "public"`; any
  other tool answers `UNAUTHENTICATED` before it runs. A failed call reaches
  the agent as a tool error carrying the code.
- The tool list is the registry's, the same for every caller: `tools/list`
  and `GET /mcp/tools` are not filtered by the principal, so an agent sees
  tools it may not call (and its call is refused). Keep a tool out of the
  list with `exclude` or `include`, per registry, and serve agents of
  different reach from separate registries.

`bind` fills chosen arguments from who is calling instead of from the agent,
so an agent bound to one project cannot name another in its calls. Here an
agent's token names its project as a verified claim (`principal.claims`):

<!-- example: apps/api/src/mcp.ts#bind -->

```ts
// agents bound to one project: an agent's token names it as a verified claim
const projectAgents = createMcpRegistry({
  services: [taskService],
  dispatcher: server.dispatcher,
  // agent tokens only: anyone else is anonymous, and every tool here refuses them
  principal: (request) =>
    verifyAgentToken(request.transport === "http" ? request.token : process.env.AGENT_TOKEN),
  // filled from the claim on every call, and left out of every tool's arguments
  bind: { projectId: ({ principal }) => principal.claims?.projectId },
  include: ["taskService.create", "taskService.countOnBoard"],
  // the tools' public names: create_task and count_tasks
  name: (_service, method) => (method === "create" ? "create_task" : "count_tasks"),
});

// beside the first registry, at a path of its own: GET /agents/tools, POST /agents/invoke
app.use(createMcpHttpRouter({ registry: projectAgents, path: "/agents" }));
```

- Each bound argument is left out of the `inputSchema` of every method's tool
  whose object input has it: `create_task` lists `id` and `title`, and
  `count_tasks` takes no arguments. Every call of such a tool gets the
  binder's value before its input is validated, through `tools/call` and both
  shapes of `POST /mcp/invoke` alike.
- A call fails closed, before the method runs: `UNAUTHENTICATED` for an
  anonymous caller, and `FORBIDDEN` when the binder returns `undefined` or
  `null`, or when the agent sent the argument with another value. A binder
  that throws fails the call with `INTERNAL`, or with the code of the
  `QuickdrawError` it threw.
- `createMcpRegistry` throws at startup when a bound argument is in no
  selected method's object input (a misspelled name would leave the real
  argument to the agent), and when it is a property of an input that is not
  an object, which it names: leave that method out, or make its input an
  object.
- Custom tools are never bound, and neither are the calls their `caller`
  makes: a custom tool reads `principal` itself. `describeTools` and the API
  docs list the inputs as the contracts declare them, with nothing bound.
- Binding is not access control. The same principal reaches the method over a
  socket or HTTP with nothing bound, so the method's access must still
  confine it to its project.

Two more needs are met by the options above, with nothing added:

- **A tool set per kind of caller.** Make one registry per kind, each with its
  own `include`, `bind` and `principal`, and serve each at its own `path` or
  from its own stdio entry, as above. A registry's `principal` hook refuses
  the other kinds: throwing fails their calls with `UNAUTHENTICATED`.
- **Frozen public tools.** `name` gives a method's tool any public name, as
  `create_task` above. When agents depend on tool names and argument shapes
  that must never change, give that surface a contract of its own: its
  methods' inputs and `describe` texts are the frozen shapes, its handlers
  call the app's services through `ctx.services`, and a registry with
  `name: (_service, method) => method` serves it. The bridge never reshapes a
  tool's arguments on the way in: such a tool would be invisible to the API
  docs and to lint, which read the contracts.

## The client

`createQuickdrawClient(contracts)` builds one typed client from the
contracts: `qd.<key>.<member>` for each method, collection, stream, channel
and event, plus `useEntity` and `useEntities` for a contract with an entity
(design: section 11). Nothing is generated: a misspelled method, or a hook
the method's kind does not have, is a compile error.
`<QuickdrawProvider client={qd} url auth>` owns the socket and the TanStack
`QueryClient` (5-minute stale time by default), and works without DOM
globals (React Native).

| Member                                                                    | Gives                                                                                           |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `qd.task.get.useQuery(input, options)`                                    | TanStack's `useQuery`; errors are `QuickdrawError` with a `code`                                |
| `qd.task.rename.useMutation(options)`                                     | TanStack's `useMutation`; `mutate` returns nothing, `mutateAsync` the output                    |
| `qd.task.useEntity(id)`, `useEntities(ids)`                               | live rows at the user's level: `{ data, isLoading, isRemoved, error }`                          |
| `qd.task.board.useCollection(scope, { view, load, limit })`               | a live scope: `{ items, index, byId, pending, totalCount, hasMore, isLoading, loadMore, ... }`  |
| `qd.task.get.call(input)`, `.key(input)`, `.prefetch(queryClient, input)` | a call over the mounted provider's connection, the cache key, a prefetch                        |
| `qd.invalidate(qd.task.get, input?)`                                      | invalidates through the coordinator: a read in flight is never cancelled                        |
| `qd.task.get.setData(input, updater)`                                     | writes a cached result an event carries, at once; a read in flight is followed by one more      |
| `useQuickdraw()`                                                          | `{ connection, status, isConnected, isKnown, reconnecting, userId, serviceAccess, hello, ... }` |

<!-- example: apps/web/src/components/TaskDetail.tsx#detail -->

```tsx
export function TaskDetail({ id }: { readonly id: string }) {
  // live, at the user's level
  const { data: task, isRemoved, error } = qd.task.useEntity(id);
  const rename = qd.task.rename.useMutation({
    // the default for a mutation with `id` and an "entity" output, written out
    optimistic: (input, cache) => cache.patchEntity(input.id, { title: input.title }),
  });
  if (error?.code === "FORBIDDEN") {
    return <p>You cannot see this task.</p>;
  }
  if (isRemoved) {
    return <p>This task was deleted.</p>;
  }
  // notes reach Admins only (the contract's fields), so its type is optional: guard it
  return (
    <div>
      <h1>{task?.title}</h1>
      {task?.notes === undefined ? null : <p>{task.notes}</p>}
      <button type="button" onClick={() => rename.mutate({ id, title: "Renamed" })}>
        Rename
      </button>
      {rename.error === null ? null : <p>{`Refused: ${rename.error.code}`}</p>}
    </div>
  );
}
```

- A row that does not exist is refused the way a row the reader may not
  see is: `FORBIDDEN`, for a subscribe and for a method whose access names
  the row (`{ entry }`), since a policy that cannot find the row grants
  nothing (fail closed), and telling the two apart would tell a stranger
  which ids exist (a service-wide `Admin` grant, which needs no row to
  pass, gets `NOT_FOUND`). So a page cannot tell "deleted" from "no access" by the
  refusal: it learns of a delete while it holds the row, live: the `r`
  frame sets `useEntity`'s `isRemoved` (as above), and a collection's
  `removed` delta takes the item out of `items`. A page opened after the
  delete (a link, a reload, a reconnect after the row went) gets only
  `FORBIDDEN`; where the difference matters, say "not found or not shared
  with you", or ask a method of the parent row (a list of the project's
  tasks) that can answer without leaking.
- A field the contract's `fields` map tiers (`notes` here) is optional in
  every row type a reader gets (`useEntity`, collection items, `"entity"`
  outputs, `EntityOf`, `ItemOf`), because a reader below its level receives
  the row without it. Handlers still return the full row.
- A mutation whose input has `id` and whose output is `"entity"` is
  optimistic by default: its input's fields show over the cached row and its
  collection items from the moment it is sent, are dropped if it fails, and
  give way to the server's frame. `optimistic: false` turns that off;
  `optimistic: (input, cache) => ...` writes its own layers with
  `patchEntity`, `removeEntity` and `patchItem`, and adds rows with
  `addItem` and `addEntity` (below).
- Live rows and collections need no refetching: frames keep them current,
  and after a reconnect they resume by revision. A query whose result
  follows writes declares `watch` in its contract; the coordinator fetches
  it again once per change, with at most one read in flight per key. Do not
  call `refetch` or `invalidateQueries` on quickdraw keys after a mutation.
- An event that carries a query's new result (a room's roster, a score)
  writes it with `qd.<service>.<query>.setData(input, updater)` rather than
  refetching: the hooks show it at once, under the overlays of optimistic
  mutations, and a read of that key already in flight (which may predate
  the event) is followed by one more, never cancelled.
- After a reconnect, the queries that are watched (they missed the changes
  meanwhile) or stale are refetched, each after a random delay of up to
  `reconnectJitterMs` (2,000 ms by default), so clients that reconnect
  together, after a server restart say, do not refetch in one burst; cached
  data stays on screen until then. `reconnectJitterMs={0}` refetches them at
  once; a client without React passes `jitterMs` to the coordinator's
  `refetchAfterReconnect`.
- `useCollection` holds one scope: its index (the members, in order), the
  items loaded, and `loadMore`/`loadItems`; `view` filters the members by a
  view of the contract, for the user the server's hello names; `load: "all"`
  keeps every page loaded. A `null` scope holds nothing; `enabled: false`
  subscribes to nothing. A scope the server refused shows its `error`
  (`FORBIDDEN`) and is loaded once more each time the user's access may
  have changed: on a connect, on new service grants (`qd:access`), and when
  another scope the client holds gets an `added` delta for the scope's
  anchor row (an invite adds the chat to the user's own list of chats, and
  the chat's messages open). A row-level grant with neither sends nothing
  the client could notice: remount the view, or call `refresh()`.
- The cache follows the user: a hello naming another user removes everything
  quickdraw cached; new credentials for the same user refetch it; new grants
  (`qd:access`) refetch every query.
- A protocol mismatch reloads the page once per session by default
  (`onProtocolMismatch`); `RATE_LIMITED` answers back off with jitter per
  kind of work.
- Server rendering: a server never connects, so `useQuickdraw()`,
  `usePresence`, streams and overlays render the state a new connection has
  (nobody known, no rooms, nothing loaded), and the browser hydrates that
  same state even where the provider connected first (a Suspense boundary
  that hydrates late), then renders the live one.

A create shows its row before the server answers with `cache.addItem(collection,
scope, item)`: the item appears in the scope at once, in its place by the
collection's `order` (give it the order's fields; without them it goes
last), and `useCollection`'s `pending` names it while the call is in flight.
A refused call removes it, unless it was added with `{ onRefused: "keep" }`
(`cache.addItem(collection, scope, item, { onRefused: "keep" })`, or the
same for `addEntity`): it then leaves `items` for `useCollection`'s
`refused`, each `{ item, error, dismiss(), retry() }`, in the render that
shows the mutation's error, until the app dismisses it or sends the same
call again with `retry()` (through the mutation hook that sent it, so its
`isPending` and callbacks follow; it shows the item `pending` again, and
never rejects: a second refusal shows in `refused` again), so a chat shows
a failed message with "retry" without a copy of its own. A call whose outcome is unknown is not refused: when the
connection drops after the call was sent, or it times out, the server may
have made the write (`isUnknownOutcome(error)` on `./client` says so). Its
items stay, `pending`, and `useCollection`'s `checking` names them until
the scope's next load (the reconnect's resume, or a load asked for at once
while the socket is up): a load that holds an item's id ends it, its own
copy shown, and one sent after the failure that answers without it refuses
it (into `refused` with `onRefused: "keep"`). Only an id the client made,
which the server keeps, can be found that way, and only with one is
`retry()` safe after an unknown outcome: the second call fails `CONFLICT`
instead of writing a second row. A refused item ends too once its scope
holds its id. The reply's `id` (the created row's) and values
replace the item's own, and once the scope's own copy arrives (its `added`
delta, or a load) that copy shows in its place: never both, never a gap.
`cache.addEntity(row)` adds a row to every collection of entity rows whose
scope column (and `where`) it matches; a collection of a projection takes
`addItem`. The item may give its own `id`, one the client made and the
server keeps: `newId()` from `./client` makes one, a version 4 UUID from
`crypto.randomUUID()`, or from `crypto.getRandomValues()` on a page over
plain http, which browsers do not give `randomUUID`:

<!-- example: apps/web/src/components/AddTask.tsx#add -->

```tsx
export function TaskList({ projectId }: { readonly projectId: string }) {
  const { items, pending } = qd.task.board.useCollection(projectId);
  const create = qd.task.create.useMutation({
    // the new card shows at once, last on the board (its ordinal), until the server's arrives
    optimistic: (input, cache) =>
      cache.addItem("board", input.projectId, {
        // the id the client made: after a lost answer the board's next load finds the card
        id: input.id,
        projectId: input.projectId,
        title: input.title,
        status: "open",
        ordinal: Number.MAX_SAFE_INTEGER,
        assigneeId: null,
      }),
  });
  return (
    <>
      <ul>
        {items.map((task) => (
          // pending: the create is on its way; the card is the server's once it answers
          <li key={task.id} style={{ opacity: pending.has(task.id) ? 0.5 : 1 }}>
            {task.title}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => create.mutate({ id: newId(), projectId, title: "New task" })}
      >
        Add
      </button>
      {create.error === null ? null : <p>{`Not added: ${create.error.code}`}</p>}
    </>
  );
}
```

`useQuickdraw()` says who the connection acts for. `userId` is `null` both
for an anonymous socket and before the server's hello, so a gate waits for
`isKnown` (the hello on the current credentials arrived; false again from
new credentials until theirs). `isConnected` turns true before the hello and
false while the connection reconnects; `reconnecting` says the user and the
page stay meanwhile:

<!-- example: apps/web/src/components/AuthGate.tsx#gate -->

```tsx
export function AuthGate({ children }: { readonly children: ReactNode }) {
  // isKnown: the server's hello named the user, so userId is final (null: signed out)
  const { isKnown, userId, reconnecting } = useQuickdraw();
  if (!isKnown) {
    return <p>Connecting…</p>;
  }
  if (userId === null) {
    return <SignIn />;
  }
  // a reconnect keeps the user and the page: say so, unmount nothing
  return (
    <>
      {reconnecting ? <p role="status">Reconnecting…</p> : null}
      {children}
    </>
  );
}
```

### Server components and other runtimes

`./client` begins with `"use client"`, so a React server component imports
`createServerCaller` from `@fitzzero/quickdraw-core/utils` instead. It calls
over the HTTP transport, and `prefetch` fills the keys the hooks read:

<!-- example: apps/web/src/app/tasks/page.tsx#page -->

```tsx
import { createServerCaller } from "@fitzzero/quickdraw-core/utils";
import { contracts } from "@project/shared";

export async function TasksPage({ projectId, cookie }: { projectId: string; cookie: string }) {
  // forwards the user's session cookie to the API's HTTP transport
  const caller = createServerCaller(contracts, { url: "http://api:4000", headers: { cookie } });
  const queryClient = new QueryClient();
  // the key useQuery reads
  await caller.task.countOnBoard.prefetch(queryClient, { projectId });
  return (
    <HydrationBoundary state={dehydrate(queryClient)}>
      <TaskBoard projectId={projectId} />
    </HydrationBoundary>
  );
}
```

A script, a worker or a React Native module without hooks uses the
connection directly:

<!-- example: apps/api/scripts/report.ts#script -->

```ts
import { callData, createQuickdrawConnection } from "@fitzzero/quickdraw-core/client";

const connection = createQuickdrawConnection({
  url: "http://localhost:4000",
  // sent as auth.token
  auth: process.env.API_TOKEN,
});
connection.open();
const count = await callData<number>(connection, {
  service: "taskService",
  method: "countOnBoard",
  input: { projectId: process.argv[2] },
});
process.stdout.write(`${String(count)} tasks\n`);
connection.close();
```

`liveDataOf(connection, queryClient)` holds live rows and collections for
such code, and `createInvalidationCoordinator(queryClient)` invalidates as
the hooks do.

A client in another language (a Godot game, a native app) speaks the wire
itself: [`docs/protocol-v5.md`](docs/protocol-v5.md) is its specification,
generated from the protocol's source, and [`examples/godot`](examples/godot)
holds a GDScript client written from it. [`docs/clients.md`](docs/clients.md)
compares the three ways in.

## Kits

The methods most services write by hand, as one-line opt-ins (design:
section 12). Each kit's contract half comes from the package root and makes
ordinary contract entries; its handlers come from `./server`. Lint's
`prefer-kit` reports a method written by hand that a kit implements (`get`,
`list`, `create`, `getTask`, ...) in a service that uses no kit, and one
that duplicates what a kit spread beside it serves (a `getNote` beside
`crud.handlers(note, { access: { get } })`); one that must stay
hand-written says why in a `// quickdraw: hand-written because ...`
comment above it.

### Read/write kit

`crud.contract` returns entries for exactly the methods it names, and
`crud.handlers` implements exactly those, each with the access form it is
given:

<!-- example: packages/shared/src/kits/crud.ts -->

```ts
import { crud, defineContract, mutation } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { cardSchema, taskSchema } from "../schemas";

const newTaskSchema = z.object({ projectId: z.string(), title: z.string() });
// every field optional
const taskPatch = z.object({ title: z.string(), status: z.string() }).partial();

export const task = defineContract("taskService", {
  describe: "Tasks on a project's board.",
  entity: taskSchema,
  projections: { card: cardSchema },
  methods: {
    ...crud.contract({
      entity: taskSchema,
      get: true,
      getMany: true,
      list: { item: cardSchema, filter: ["projectId", "status"], sort: ["ordinal", "title"] },
      create: { input: newTaskSchema },
      // the kit adds `id`
      update: { input: taskPatch },
      delete: true,
      reorder: { column: "ordinal", within: "projectId" },
      // the kit adds `ids`
      bulkUpdate: { input: taskPatch },
      bulkDelete: true,
    }),
    archive: mutation({
      input: z.object({ id: z.string() }),
      output: "entity",
      describe: "Archives a task, which leaves its board.",
    }),
  },
});
```

<!-- example: apps/api/src/services/kits/crud.ts#service -->

```ts
import { crud, inherit, nextOrdinal } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  methods: {
    ...crud.handlers(task, {
      access: {
        get: { entry: "Read" },
        getMany: "authenticated",
        list: "authenticated",
        create: { scope: "Moderate", of: projectContract, id: "projectId" },
        update: { entry: "Moderate" },
        delete: { entry: "Admin" },
        reorder: { entry: "Moderate" },
        bulkUpdate: "authenticated",
        bulkDelete: "authenticated",
      },
      // what `create` writes: columns from the principal, the next ordinal
      prepare: async (input, ctx, db) => ({
        ...input,
        assigneeId: ctx.principal.userId,
        ordinal: await nextOrdinal(db, "task", { projectId: input.projectId }),
      }),
    }),
    archive: {
      access: { entry: "Admin" },
      handler: ({ input, db }) =>
        db.task.update({ where: { id: input.id }, data: { status: "archived" } }),
    },
  },
});
```

- `prepare` gets the app's database client as `db`; annotate it with the
  client's type (`db: AppDb`) to use it typed, and the handlers spread into
  `qd.defineService` refuse a type that is not the service's client (the
  sharing kit's `resolveUser` and `onChange` take `db` the same way).
- Each method needs a form: one missing from `access` does not compile.
  `get`, `update`, `delete` and `reorder` act on `input.id`, which
  `{ entry: L }` checks; a write on one row also needs the row level
  (`Moderate`, or the form's `entry`) on that row whatever its form, so
  `update: "authenticated"` edits no row. `list`, `getMany`, `bulkUpdate`
  and `bulkDelete` act on many rows, so they also keep only the rows the
  service's policy gives the caller at the form's `entry` or `scope` level
  (else `Read` for reads and `Moderate` for writes): a list never shows a
  row `get` would refuse. A service-wide `Admin` grant reaches every row,
  and a grant a `{ service: L }` form names is a row level of the grant on
  every row (the read is not filtered, and its rows are stripped at the
  grant). A `"public"` read's rows are not filtered (a public bulk write
  still needs a level on each row), nor are any on a service without a
  policy, where the form is the whole check: there these methods (and
  `search`) must be `"public"` or `{ service }`, or the service is refused
  when it is defined.
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
  the `within` list in steps of 1,024 when no gap is left, in a transaction
  given 5 s plus 10 ms per row of the list. Moves run SERIALIZABLE: two at
  once into one gap fail one of them with `CONFLICT` (try again).
- The generated inputs carry JSON Schema, so the kit's methods are MCP tools
  too. For hand-written handlers, `./server` has `requireRow(row, message?)`
  (`NOT_FOUND` for a missing row) and `nextOrdinal(db, model, where)`.

The typed client has no hook for infinite scroll. Page through `list` with
TanStack's `useInfiniteQuery`, keyed by the list's own `key` (with a suffix,
since pages are not one list result) and fetching with its `call`, so
`qd.invalidate(qd.task.list)` refetches the pages too. `no-untyped-client`
accepts this form for the hooks the typed client has none of
(`useInfiniteQuery`, `useSuspenseQuery`, `useQueries`, `queryOptions` and
their variants):

<!-- example: apps/web/src/components/kits/TaskPages.tsx#component -->

```tsx
export function TaskPages({ projectId }: { readonly projectId: string }) {
  const filter = { projectId };
  // the list's own key (plus a suffix: pages are not one list result) and call,
  // so qd.invalidate(qd.task.list) refetches these pages too
  const pages = useInfiniteQuery({
    queryKey: [...qd.task.list.key({ filter }), "pages"],
    queryFn: ({ pageParam, signal }) =>
      qd.task.list.call({ filter, cursor: pageParam, limit: 50 }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const cards = pages.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <>
      <ul>
        {cards.map((card) => (
          <li key={card.id}>{card.title}</li>
        ))}
      </ul>
      {pages.hasNextPage ? (
        <button type="button" onClick={() => void pages.fetchNextPage()}>
          More
        </button>
      ) : null}
    </>
  );
}
```

### Search kit

`search.contract` makes one query, `search`, and `search.handlers`
implements it; on the client, its member gets `useSearch`:

<!-- example: packages/shared/src/kits/search.ts -->

```ts
import { defineContract, search } from "@fitzzero/quickdraw-core";
import { cardSchema, taskSchema } from "../schemas";

export const task = defineContract("taskService", {
  describe: "Tasks on a project's board.",
  entity: taskSchema,
  projections: { card: cardSchema },
  methods: {
    // looks in title and notes; a call may keep to one scope of byProject
    ...search.contract({
      entity: taskSchema,
      // a scoped search's results are its collection's items
      item: cardSchema,
      fields: ["title", "notes"],
      scope: "byProject",
    }),
  },
  collections: {
    byProject: {
      describe: "A project's tasks, in board order.",
      scope: "projectId",
      item: "card",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
    },
  },
});
```

<!-- example: apps/api/src/services/kits/search.ts#service -->

```ts
import { inherit, search } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  collections: { byProject: { anchor: projectContract } },
  methods: { ...search.handlers(task, { access: "authenticated" }) },
});
```

<!-- example: apps/web/src/components/kits/TaskSearch.tsx#component -->

```tsx
export function TaskSearch({ projectId }: { readonly projectId: string }) {
  const [text, setText] = useState("");
  // debounced, superseded searches cancelled, results live while the board is open
  const { items, isSearching } = qd.task.search.useSearch(text, { scope: projectId });
  return (
    <>
      <input value={text} onChange={(event) => setText(event.target.value)} />
      {isSearching ? <p>Searching…</p> : null}
      <ul>
        {items.map((card) => (
          <li key={card.id}>{card.title}</li>
        ))}
      </ul>
    </>
  );
}
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
  below the collection's `access` on its anchor). A `via` scope is searched
  among at most its collection's `maxLimit` links, the first by row id.
  Identical concurrent searches by one caller run once (`share: "caller"`).
  For a contract with several search methods, `method` names the one a
  `search.handlers` call implements.
- `strategy` replaces how rows are found; the kit still adds the access
  filter, the scope and paging. `where(q, ctx)` returns a filter;
  `ids(q, ctx, { limit })` returns ranked ids from an index of your own,
  which the kit reads, keeps to the rows the caller may read (so a page can
  hold fewer than `limit`) and returns in that order as one page. Postgres
  full-text search through a `tsvector` column the app maintains (a
  generated column or a trigger, with a GIN index):

<!-- example: apps/api/src/services/kits/search.ts#fulltext -->

```ts
export const fullTextSearch = search.handlers(task, {
  access: "authenticated",
  strategy: {
    // Prisma cannot filter on a tsvector column: find the ids with SQL. Keep
    // to the caller's rows (here, their projects' tasks) before LIMIT, so
    // other users' matches never fill the 1,000; the kit's access filter
    // still applies to what comes back.
    where: async (q, ctx) => {
      const rows = await db.$queryRaw<{ id: string }[]>`
        SELECT t.id FROM "Task" t
        JOIN "ProjectMember" m ON m."projectId" = t."projectId"
        WHERE m."userId" = ${ctx.principal.userId}
          AND t."searchVector" @@ websearch_to_tsquery('english', ${q})
        LIMIT 1000`;
      return { id: { in: rows.map((row) => row.id) } };
    },
  },
});
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

`sharing.contract` makes the methods for one of the two ways a policy shares
rows, and `sharing.handlers` implements them on the access list or the
membership table the service's own policy reads:

<!-- example: packages/shared/src/kits/sharing.ts -->

```ts
import { defineContract, sharing, via } from "@fitzzero/quickdraw-core";
import { z } from "zod";

const projectSchema = z.object({ id: z.string(), name: z.string() });

export const project = defineContract("projectService", {
  describe: "Projects and the people they are shared with.",
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
      describe: "The projects a user is a member of.",
      scope: via({ model: "projectMember", entry: "projectId", scope: "userId" }),
      item: "entity",
      order: [["id", "asc"]],
    },
  },
});
```

<!-- example: apps/api/src/services/kits/sharing.ts#service -->

```ts
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
        (await db.user.findFirst({ where: name === undefined ? { email } : { name } }))?.id,
      // runs inside the change's transaction: its writes commit with it, a throw undoes it
      onChange: (change, ctx) => {
        ctx.log.info("sharing changed", { kind: change.kind, id: change.id, user: change.userId });
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
  method's form. Whatever the form, no caller shares, sets or invites at a
  level above their own on the row (`FORBIDDEN`; a service-wide grant
  counts where the form names `service`), and each change reads the
  caller's level again inside its transaction, refusing one lowered by a
  concurrent change (`FORBIDDEN`).
- The kit changes the list or the table the service's policy reads, alone
  or inside `anyOf`, and takes their names from it: a service whose policy
  has none for a mode the contract uses (or two) fails when it is defined.
  Roles are the policy's `levels` keys, or the level names `Read`,
  `Moderate` and `Admin` without it; another role is `VALIDATION`, and
  `invite` without a role gives the lowest one that can read the row.
- The owner's access never changes (`CONFLICT`). A row keeps its last
  Admin, counted across every policy of an `anyOf`: an owner column, an
  `Admin` entry of the access list, an `Admin` member (so a project's owner
  may remove its only Admin member). Taking the last one away, by
  `unshare`, a lower level, `remove`, `leave` or `setRole`, is `CONFLICT`.
  An access list the policy cannot read is `CONFLICT` and left as it is; an
  entry's other keys are kept. Inviting a member is `CONFLICT`, an unknown
  user `NOT_FOUND`, and a change to the level or role a user has already
  writes nothing.
- Each change reads and writes in one SERIALIZABLE transaction, so two
  changes to one row at once cannot lose one or both remove the last two
  Admins: the database fails the second, which answers `CONFLICT` (try
  again). The writes go through the tracked client, so the flush revokes
  the live subscriptions of whoever lost access (`qd:revoked`) and sends
  the `via` collections over the table `added` and `removed`; the kit sends
  nothing itself. The by-name methods tell a row's owner whether an account
  exists; list them only where that is acceptable.

### Admin kit

Back-office methods for every row of a service, only for service
administrators, with the screen's fields derived from the entity (design:
section 12.4). `admin.contract` makes ordinary, typed entries, and
`admin.handlers` implements them:

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

<!-- example: apps/web/src/components/kits/AdminTasks.tsx#component -->

```tsx
export function AdminTasks() {
  // [{ key: "task", serviceName, displayName }]
  const { services } = useAdminServices(qd);
  const { data } = qd.task.admin.adminList.useQuery({ page: 1, sort: { field: "title" } });
  const update = qd.task.admin.adminUpdate.useMutation({
    // adminList is a query, not live data: read the page again after this screen's own write
    onSuccess: () => qd.invalidate(qd.task.admin.adminList),
  });
  return (
    <table aria-label={services[0]?.displayName}>
      <tbody>
        {data?.items.map((row) => (
          <tr key={row.id}>
            <td>{row.title}</td>
            <td>
              <button
                type="button"
                onClick={() => update.mutate({ id: row.id, data: { status: "done" } })}
              >
                Done
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
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
- `adminGet({ id })` returns the row; `adminCreate({ data })` and
  `adminUpdate({ id, data })` write the entity's fields through the tracked
  client, so subscribers and collections get the same frames as for any
  other write; `adminDelete({ id })` returns `null`. `id`, `createdAt` and
  `updatedAt` are never writable, nor are hidden fields, those an override
  made read-only or those `editable` leaves out (`VALIDATION`); without a
  service-wide `Admin` grant, nor are the columns the policy reads, and a
  row moves to another parent only with the row level on it (`FORBIDDEN`,
  as for the read/write kit); each value is checked by the entity schema
  itself, and a value the database refuses is `VALIDATION`. A missing row
  is `NOT_FOUND`.
- `editable: ["title", "status"]` names the only fields `adminCreate` and
  `adminUpdate` write: `adminMeta` reports every other field
  `editable: false`, so a generic form leaves it read-only, and a write
  naming one is `VALIDATION` ("is not editable"). Each must be a field the
  kit shows, never `id` or a timestamp, and a `fieldOverrides` entry may
  not say otherwise. `admin.contract({ entity, editable })` takes the same
  list, so the writes' input checks, types and JSON Schema (and the MCP
  tools made from it) name only those fields; given to both halves, the
  two lists must name the same fields. Without either list the kit writes
  what it wrote in 5.0.0: every field it shows but `id` and the timestamps,
  less those an override made read-only.
- `adminMeta()` returns `{ serviceName, displayName, fields }`, one
  `{ name, type, label, required, editable, showInTable, sortable, filterable, enumValues?, relationService?, kind?, showInForm? }`
  per field: `type` is
  `string`, `number`, `boolean`, `date` (an ISO string with a date format),
  `enum` or `json` from the field's JSON Schema, and `relation` by override;
  `sortable` and `filterable` are the declared fields (`filterable` is
  optional in the `AdminFieldConfig` type, default `false`, so field
  configurations written for 4.x still type); `id` and the
  timestamps come first and are not editable; `acl`, `serviceAccess` and
  `service_access` are hidden.
- Grants: on a users service, `admin.handlers(user, { grants: true })`
  shows and writes the entity's `serviceAccess` (a `json` field the entity
  schema checks), so the admin screen edits grants through `adminUpdate`.
  Only a caller whose own service-wide grant on that service is `Admin`
  reads or writes it, whatever `access` gives the method: anyone else gets
  rows without it and `FORBIDDEN` for a write, filter or sort naming it.
  The write is tracked, so with `auth.serviceAccessSource` naming the column
  the user's open sockets get the new grants at once, on every node. Such
  an Admin can grant any service, themself included. The field's
  configuration says `kind: "grants"`, so a screen with a grants editor of
  its own finds it without its name, and
  `fieldOverrides: { serviceAccess: { showInForm: false } }` keeps it out
  of a generic create or edit form (a form shows the fields whose
  `showInForm` is not `false`); the kit still reads and writes it.
- `admin.handlers(contract, { onWrite })` runs `onWrite({ method, id,
before?, after }, ctx, db)` after each `adminCreate`, `adminUpdate` and
  `adminDelete`, in one transaction with the write (`db` is the
  transaction's tracked client; a throw undoes the write and fails the
  call): what an admin edit must set off, such as a game reloading its
  tunables, without wrapping the kit's handlers. The rows are the entity,
  every field. `onCommitted({ method, id, before?, after }, ctx)` runs once
  the write has committed (after `onWrite`'s transaction), in a detached
  unit of work of its own: the reply does not wait for it, its writes flush
  on their own, and a throw is logged, the write standing. Apply an edit to
  what runs in memory (a game's simulation) there, so an edit that rolled
  back is never applied. Without either hook the kit opens no transaction.
  Each handler `admin.handlers` returns resolves with its method's output
  type (`AdminOutputOf<C, M>`), so a wrapper reads the row and returns it
  with no cast.
- `adminSubscribers({ id })` counts the sockets subscribed to a row per
  access level (`{ id, count, levels, complete }`; behind a Redis adapter
  the counts are this server's and `complete` is `false`), and
  `adminReemit({ id })` touches the row so the flush sends it again to every
  subscriber.
- `qd.<service>.admin` holds the kit's members (there is no top-level
  `qd.admin`, since `admin` is reserved per service). `useAdminServices(qd)`
  lists the client's services whose `adminMeta` answers the user, with their
  display names, sharing the cache of `qd.<service>.admin.adminMeta.useQuery()`.
  It asks only the services the user's grants (from the server's hello)
  allow: `Admin` by default, what the kit's methods require;
  `useAdminServices(qd, { requires: "Moderate" })` for an `adminMeta` given
  another form, `requires: null` for every service. A service that refused
  is not asked again until the user's grant on it changes, reconnects
  included.
- The kit's rows are not live: `adminList` and `adminGet` are queries that
  watch nothing, so a screen reads them again after its own writes (the
  `onSuccess` above), and sees other admins' writes when it next reads.
- A screen that serves every service from its metadata (the route names the
  service) takes `adminOf(qd, key)`: the same members, keyed by what the kit
  made them for and typed by field name (`AdminScreen`: rows are
  `AdminRow`, `adminList` takes `{ page, pageSize, filter, sort: { field, direction } }`
  with names read from `adminMeta`), so no cast is needed over a union of
  keys; a method the contract does not expose is absent.

### Presence, streams and channels

Who is online, feeds that start with recent history and then append (logs,
metrics), fast one-way input (cursors, typing) and typed room events
(design: section 12.5). All four are declared in the contract; they share
`qd.<service>.<name>` with the methods and collections:

<!-- example: packages/shared/src/kits/realtime.ts -->

```ts
import { defineContract, mutation } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { taskSchema } from "../schemas";

const cursorSchema = z.object({ projectId: z.string(), taskId: z.string(), x: z.number() });
const logLineSchema = z.object({ line: z.string() });

export const task = defineContract("taskService", {
  describe: "Tasks on a project's board.",
  entity: taskSchema,
  methods: {
    enterBoard: mutation({
      input: z.object({ projectId: z.string() }),
      output: z.boolean(),
      describe: "Joins the caller's socket to a project's board room.",
    }),
  },
  streams: {
    // one feed per task; a subscriber needs Read on the task, and first gets the latest 50 lines
    logs: {
      item: logLineSchema,
      scope: "taskId",
      seed: 50,
      access: { entry: "Read" },
      describe: "A task's log lines, as its job writes them.",
    },
    // one feed for everyone
    load: {
      item: z.number(),
      volatile: true,
      access: "authenticated",
      describe: "The server's load, sampled every second.",
    },
  },
  channels: {
    // 20 a second per socket; only from a socket in the board's room, which enterBoard joined
    cursor: {
      describe: "Where a user's cursor is on a task card.",
      payload: cursorSchema,
      ratePerSecond: 20,
      requires: { room: (cursor) => `board:${cursor.projectId}` },
    },
  },
  events: {
    cursorMoved: { payload: cursorSchema, describe: "Another user's cursor moved." },
    // a user's last socket left a board: `onRoomLeave` sends it
    leftBoard: {
      payload: z.object({ projectId: z.string(), userId: z.string() }),
      describe: "A user left a project's board.",
    },
  },
});
```

<!-- example: apps/api/src/services/kits/realtime.ts#service -->

```ts
import { inherit } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  methods: {
    enterBoard: {
      access: { scope: "Read", of: projectContract, id: "projectId" },
      handler: ({ input, ctx }) => ctx.rooms.join(`board:${input.projectId}`),
    },
  },
  channels: {
    // relay each cursor to the board's room
    cursor: (payload, ctx) => {
      ctx.rooms.emit(`board:${payload.projectId}`, task, "cursorMoved", payload);
    },
  },
  // once per socket that leaves app rooms, in every server this service runs in, in a unit of its own
  onRoomLeave: ({ principal, rooms }) => {
    for (const { room, last } of rooms) {
      // last: no socket of the user is in the room any more (a second tab keeps it false)
      if (principal !== null && last && room.startsWith("board:")) {
        const projectId = room.slice("board:".length);
        qd.rooms.emit(room, task, "leftBoard", { projectId, userId: principal.userId });
      }
    }
  },
});

// in handlers, jobs and timers
export function logLine(taskId: string, line: string): void {
  qd.stream(task, "logs").push(taskId, { line });
}

export async function isOnline(userId: string): Promise<boolean> {
  // also ctx.presence and server.presence
  return await qd.presence.isOnline(userId);
}
```

<!-- example: apps/web/src/components/kits/TaskRoom.tsx#component -->

```tsx
export function TaskRoom({
  projectId,
  taskId,
}: {
  readonly projectId: string;
  readonly taskId: string;
}) {
  // the socket is in the board's room on every connection: a reconnect is a new socket in no room
  const board = useJoin(qd.task.enterBoard, { projectId });
  const { items } = qd.task.logs.useStream(taskId, { max: 200 });
  const { send, isReady } = qd.task.cursor.useChannel();
  const [lastX, setLastX] = useState(0);
  qd.task.cursorMoved.useEvent((cursor) => setLastX(cursor.x));
  // user ids, once enterBoard joined the room
  const here = usePresence(`board:${projectId}`);
  const move = (x: number) => isReady && board.isJoined && send({ projectId, taskId, x });
  return (
    <div onMouseMove={(event) => move(event.clientX)}>
      <p>{`${String(here.length)} here; a cursor at ${String(lastX)}`}</p>
      <pre>{items.map((item) => item.line).join("\n")}</pre>
    </div>
  );
}
```

- Streams: `push` checks each item against the stream's schema (a mismatch
  throws `INTERNAL` and nothing is sent; what is kept and sent is the
  validated item, so keys the schema does not name are stripped), keeps the
  latest `seed` items per scope in memory on that process (at most 1,000 per
  scope and 10,000 scopes per stream; a restart empties them, and durable
  history is the app's: store the rows and expose a collection), and sends
  `qd:stream [service, stream, scope, item]` (`scope` null for a global
  stream; positional, so a fast stream's frames carry no key names) to the
  feed's subscribers, volatile when the stream says so. `pushMany(scope, items)`
  (`pushMany(items)` for a global stream) pushes several items to one feed
  at once: every item is checked before any is kept or sent, and each goes
  out as its own frame, in order; use it rather than `push` in a loop
  (`no-emit-in-loop`). `qd:stream:sub` is authorized with the
  stream's `access` through the access engine, the scope being the row an
  `entry` or `scope` form checks; `access: { room }` (a name, `{ prefix }`,
  or for a scoped stream a function of the scope) opens it to the sockets
  in that app room instead, signed in or not, and a socket that leaves the
  room, or is taken out, leaves the feed; a stream without `access` is
  closed. The answer is the seed; `useStream` then appends, keeps the
  latest `max` (default 500), and subscribes again after a reconnect, when
  the seed replaces what it held. A socket holds at most 500 feeds. A
  subscriber whose access is lowered is authorized again; one refused
  leaves the feed and gets
  `qd:revoked { kind: "stream", reason: "access", s, stream, scope? }`, and
  `useStream` shows `FORBIDDEN` until the next connect.
- A service's `streams: { <name>: { seed, validate } }` (type
  `StreamImplementation`) computes a stream's seed per subscriber, `seed: (scope, ctx) => items` (the current state,
  where the items that follow are deltas; on whichever node the subscriber
  is on, under its principal, in the tick it joins the feed; a contract
  `seed: n` and a seed function cannot both be declared), and
  `validate: "development"` checks pushed items only while the dispatcher
  checks outputs (`outputValidation`, off in production), for a hot stream:
  unchecked, an item goes out as pushed, extra keys included.
- Channels: each message is `qd:ch [service, channel, payload]`, sent
  volatile and never answered. Per socket and channel a token bucket
  (`ratePerSecond`, default 30; `burst`, default twice that) drops what is
  over the rate, and a socket whose drops within 10 s pass 100 times the
  rate is disconnected. A message from an anonymous socket, one that fails
  its schema, one without the service grant `{ access: { service }, handler }`
  names, or one whose `requires` the socket does not hold (`{ entity }`: a
  `qd:sub` of that row; `{ collection, scope }`: a `qd:col:sub` of that
  scope; `{ room }`: the app room, a name like `"world"` or a function of
  the payload, which a call over that same socket joined) is dropped.
  Nothing is logged per message; a handler's error is. The socket rate
  limiter does not count channels. `{ room: { prefix: "world:" } }` takes
  a socket in any app room whose name starts with the prefix (a game of many
  worlds), and every room form gives the handler the room it matched as
  `ctx.room` (typed `ChannelRoomOf<C, Name>`: `string` for a channel that
  requires a room, else `undefined`), so the payload need not repeat it. Every requirement is the
  sending socket's own: a room another socket of the user joined does not
  count, a reconnected socket must join again, and behind a cluster the
  check runs on the node the socket is connected to, with no round trip.
- Presence: `isOnline`, `lastSeen` (now while online, else when the user's
  last socket on this process disconnected), `count` and `users` (each user
  once, anonymous sockets left out; app rooms only) come from this process's
  sockets, and from every node's (`fetchSockets`) behind a Redis adapter.
  `ctx.rooms.join(room)` and `leave` put the calling socket in an app room
  (calls without a socket get `false`; names starting with `qd:` or `user:`
  are refused with `VALIDATION`; at most 100 per socket; a method that shares
  its runs, `share`, may not join or leave with its caller's socket:
  `INTERNAL`), and the room's sockets get `qd:presence` frames: the list on
  joining, then who joins and who leaves. `usePresence(room)` shows them.
- Events: `ctx.rooms.emit(room, contract, event, payload)` and
  `emitToUser(userId, ...)` check the payload first (`INTERNAL`, nothing
  sent, when it fails), then send the validated payload as
  `qd:event [service, event, payload]`; `useEvent` hears them.
- Rooms belong to a socket: a reconnect (a lost network, `qd:rotate`, new
  credentials) is a new socket in no room, which hears none of its events
  and whose channel messages requiring it are dropped. `useJoin(member,
input, { enabled?, onJoined? })` (from `./client`) runs the joining call
  (`enterBoard` above) on every `qd:hello` and when its input changes by
  value, never on a re-render, and shows `status` (`idle` with no socket to
  join with, `joining`, `joined`, `error`), `isJoined`, `data` and `error`;
  a refusal stands until the next hello or `retry()` (which runs the call
  again at once on the current socket, and does nothing while there is
  none or `enabled` is false), `RATE_LIMITED` is tried again after its
  backoff, and it never leaves the room itself.
  `connection.onHello(listener)` is the same hook without React.

Code that is not a handler (a game loop, a timer, a job) reaches rooms
through `qd.rooms` (also `server.rooms`); the service's `onRoomLeave` (above)
hears sockets leave:

<!-- example: apps/api/src/services/kits/rooms.ts#rooms -->

```ts
const boardRoom = (projectId: string): string => `board:${projectId}`;

// a timer or a game loop's tick, outside any handler: every socket in the room, on every node
export function showCursor(projectId: string, taskId: string, x: number): void {
  qd.rooms.emit(boardRoom(projectId), task, "cursorMoved", { projectId, taskId, x });
}

// a member removed from the project: their sockets leave its board on every node, so they hear
// nothing more of it and its cursor channel drops their messages (also ctx.rooms.leave)
export async function removeFromBoard(projectId: string, userId: string): Promise<void> {
  await qd.rooms.leave(boardRoom(projectId), { userId });
}

// a tick loop's "is anyone watching?", at its tick rate: this node's sockets in the room,
// anonymous ones too, with no promise (presence.count asks every node for users)
export function hasAudience(projectId: string): boolean {
  return qd.rooms.size(boardRoom(projectId)) > 0;
}
```

- `qd.rooms.emit` and `emitToUser` are `ctx.rooms`' own, from anywhere,
  reaching every node behind a cluster adapter.
- `rooms.size(room)` (on `qd.rooms`, `server.rooms` and `ctx.rooms`) counts
  the sockets in an app room on this node, anonymous ones included, at once:
  a game loop can ask it every tick. It is local by design; `presence.count`
  counts users on every node. A handler's `ctx.socketId` names the socket
  its call arrived on (`undefined` over HTTP, MCP or in process).
- `leave(room, { userId })` (on `qd.rooms`, and on `ctx.rooms` beside the
  calling socket's own `leave(room)`) takes every socket of the user out of
  an app room, on every node: they hear nothing more of it, a channel that
  `requires` the room drops their messages, each gets
  `qd:presence { room, users: [] }`, and the room hears `left`. Behind a
  cluster it is broadcast and answered, so await it before sending what the
  user must not receive. Joining again is the app's to refuse.
- A service's `onRoomLeave` runs once per socket that leaves app rooms, in
  every server the service runs in (`createTestApp` and a benchmark's
  server included, with nothing to wire), beside every other service's and
  `createServer({ onRoomLeave })`, the app's own; each runs in a unit of
  work of its own, and one that throws stops none of the others. It hears
  every app room a socket leaves, so check the room's name. It runs on
  the node that held the socket: its own `leave` (`reason: "leave"`), a
  removal (`"removed"`), or a disconnect, which leaves every app room it was
  in (`"disconnect"`; `qd:rotate` reconnects with a new socket). Each room
  (a `RoomLeft`) comes with `last`: true when no socket of that user is in
  the room any more, on any node, which is what a game's `playerLeft` waits
  for. It runs
  in a unit of work of its own (never the unit of the handler that left), a
  throw is logged, and `close()` waits for it. Behind a cluster `last` is
  decided by asking every node once the socket left, so two sockets of one
  user leaving two nodes at the same moment may both see the other (a
  removal never misses: each node reports its own last socket).

### Auth routes kit

Sign-in for Google, Discord, a development mock and guests, as one Express
middleware (design: section 12.6). The app supplies how a provider's profile
becomes its user (`onLogin`, returning the user's id) and where sessions are
stored (a `SessionStore`); `socketAuth` then authenticates the server's
sockets and HTTP calls by those sessions:

<!-- example: apps/api/src/auth/routes.ts#routes -->

```ts
import {
  createAuthRoutes,
  createMemorySessionStore,
  discord,
  google,
  guest,
  mock,
  socketAuth,
} from "@fitzzero/quickdraw-core/server/auth";
import { createCallLimiter } from "@fitzzero/quickdraw-core/server/express";

// the web app's origins: one list for both
const allowedOrigins = [env.CLIENT_URL];
// in production: a store over your database (below)
const sessions = createMemorySessionStore();

export const app: Express = express();
// behind a proxy, so the rate limits see the client's IP; with none, a client would pick its own
app.set("trust proxy", env.TRUST_PROXY);
// a web app on another origin also needs CORS with credentials on these routes
app.use(
  createAuthRoutes({
    providers: [
      // nothing without its credentials: the routes skip it
      google.optional({ clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET }),
      discord({ clientId: env.DISCORD_CLIENT_ID, clientSecret: env.DISCORD_CLIENT_SECRET }),
      // served only while isMockOAuthEnabled()
      mock({ listUsers: listSeededUsers }),
      guest({ createUser: (input) => createGuestUser(input) }),
    ],
    sessions,
    // 32 characters or more
    jwtSecret: env.JWT_SECRET,
    // the user's id, or null to refuse
    onLogin: (profile) => upsertUser(profile),
    allowedOrigins,
    // redirect URIs: {publicUrl}/auth/{provider}/callback
    publicUrl: env.API_URL,
    successPath: "/auth/callback",
    errorPath: "/auth/login",
    // a revoked session's open sockets: logout ends its own, logout-all every one of the user
    onRevoke: (userId, sessionId) =>
      server.access.disconnectUser(userId, sessionId === null ? {} : { sessionId }),
  }),
);

export const server = qd.createServer({
  app,
  services,
  db,
  auth: {
    authenticate: socketAuth({
      sessions,
      jwtSecret: env.JWT_SECRET,
      allowedOrigins,
      loadPrincipal: (userId): AppPrincipal => ({ userId, kind: "user" }),
    }),
    loadServiceAccess: (userId) => loadGrants(userId),
  },
  // the HTTP transport has no limit of its own
  http: { rateLimit: createCallLimiter() },
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
| `POST /guest`                          | `createUser(body)`, then `{ userId, name? }` with the session cookie (and `token` with `guest({ token: true })`)      |
| `GET /providers`                       | `{ providers: [{ id, name, kind }] }`: the sign-ins served now (`routes.providers()` on the server)                   |
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
  site; `COOKIE_DOMAIN` (or `cookie.domain`) shares it with subdomains. Its
  name is `cookie.name`; else `session` when it has a domain; else
  `__Host-session` on a request that came over HTTPS (`req.secure`,
  `X-Forwarded-Proto: https`, the `Origin` of an `https:` page, or for an
  OAuth callback an `https:` return origin), which a browser keeps only as
  a Secure, host-only cookie on `/`, so no other site under the same parent
  domain can plant or replace it; else, over plain HTTP, `session`.
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
  An HTTP call (`/qd/...`) that sends the cookie is checked the same way
  and answered `FORBIDDEN` (403) from an `Origin` outside `allowedOrigins`,
  besides needing its JSON content type. One without `Origin` is accepted:
  a browser sends `Origin` with every POST, so it comes from curl or a
  server rendering a page with the user's forwarded cookie (refused only
  when `Sec-Fetch-Site` names another site). Bearer tokens need no Origin
  on either transport. An app's own `authenticate` learns where an HTTP
  call's token came from in `request.credential` (`"cookie"` or
  `"bearer"`, type `HttpCredentialSource`), applies the same rule with
  `cookieOriginAllowed(request, allowedOrigins)`, and a
  `QuickdrawError("FORBIDDEN")` it throws on HTTP is answered as it is.
- `socketAuth({ devCredentials })` signs a socket in by the user id its
  handshake names (`auth: { userId }`, no token), as the function answers
  (the principal, or `null` to refuse): for a game editor or load-test bots
  in development. `socketAuth` throws when it is given while `NODE_ENV` is
  `production`, and refuses such a handshake there anyway; pass it only
  behind the app's own flag.
- `google.optional(...)` and `discord.optional(...)` build nothing when
  neither credential is set (only one is a misconfiguration, refused), and
  `providers` skips `undefined`, `null` and `false` entries, so an
  environment without a provider's app leaves it out in place.
- A guest's `createUser` may return `{ userId, name }` when the name it gave
  differs from the one asked (a numbered one after a collision), and the
  route answers it; `guest({ createUser, token: true })` also answers the
  session's token, for clients that keep no cookies (a game engine, a page
  in a third-party iframe), at the cost of the token being readable by the
  page's scripts.
- `requireSession({ sessions, jwtSecret }, { loadPrincipal?, allowedOrigins?, logger? })`
  guards the app's own REST routes (below): the credential is read as `/me`
  reads it, the JWT verified once and the session checked in the store;
  otherwise 401 `{ error: "UNAUTHENTICATED", message }`. The session cookie
  gets the `/qd` calls' Origin rule: from an `Origin` outside
  `allowedOrigins` (by default the list of the `createAuthRoutes` writing to
  the same store object, `sessions`: a second store over the same table is
  another object) it answers 403 `{ error: "FORBIDDEN", message }`, so
  another site's form cannot post to a route as the user; a request without
  `Origin` is accepted unless `Sec-Fetch-Site` names another site, and a
  bearer token needs none. With neither list no page may use the cookie
  there: the first refusal logs an error naming both fixes (to `logger`,
  default the console), and a page in development is told them in the 403.
  4.1's `createRequireAuth` stays for token-keyed sessions.
- Rate limits: the sign-in routes share `createAuthLimiter({ max: 60 })` (60
  requests per 15 minutes per IP), the session routes
  `createAuthStatusLimiter()` (120), and `GET /providers` has
  `createPublicApiLimiter()` (60 per minute) to itself, so the login pages
  loaded from one address cannot use up its sign-outs; pass
  `rateLimit: { signIn, session, providers }` to replace them (a shared
  store across instances, say; one left out keeps its default) or `false`.
  The defaults need the optional peer `express-rate-limit`. The HTTP transport
  (`/qd`) is not limited unless `http.rateLimit` is set;
  `createCallLimiter()` (300 calls per minute per IP) refuses in the
  transport's own `RATE_LIMITED` reply. A web server that prefetches for
  many users calls from one address: give it its own `keyGenerator` or a
  higher `max`.
- The mock provider is mounted only while `isMockOAuthEnabled()`
  (`ENABLE_MOCK_OAUTH=true` and `NODE_ENV` other than `production`), and
  every request checks again. Set `mock({ internalUrl })` where the API
  cannot reach itself at `publicUrl`. Routes made with nothing that can
  sign anyone in (only a mock that is off) warn when they are made.
- `publicUrl` is where providers send the browser back, so a deployment
  must set it to the API's public URL. A loopback `publicUrl`
  (`http://localhost:4000`, the usual fallback for an unset `API_URL`)
  warns when the routes are made if every allowed origin is a page on
  another machine, and the first request that arrives for another host
  (`X-Forwarded-Host`, else `Host`) logs an error naming it, once.
- One rule names the session cookie, written and read: the routes,
  `setSessionCookie`, `socketAuth` and the HTTP transport give a request
  the same name, and read first the name they would set on it. Without a
  domain, a request over HTTPS reads only `__Host-session`, never
  `session`: another site under the same parent domain can set that cookie
  for the whole domain, and while the user holds no `__Host-session` it
  would sign them in as whoever set it. A plain HTTP request reads
  `session`, then `__Host-session`. A configured name is read as it is, on
  any request, so a changed name goes in all three places:
  `createAuthRoutes({ cookie: { name } })`, `socketAuth({ cookieName })`
  and `createServer({ http: { cookieName } })`. The transports see the
  cookie's domain through `COOKIE_DOMAIN` only: share the cookie with
  subdomains by setting `COOKIE_DOMAIN`; a `cookie.domain` given only to
  the routes needs `cookieName: "session"` on the other two, and the routes
  warn at startup until the cookie is named. Behind a proxy that ends TLS,
  have it send `X-Forwarded-Proto`, which every request carries, so the
  name does not depend on which requests carry an `Origin`.
- A socket keeps the principal it authenticated with until it reconnects,
  so a revoked session's open sockets are ended with
  `server.access.disconnectUser(userId, { sessionId?, reason? })`: every
  socket of the user, or those `socketAuth` recorded for one session
  (`recordSocketSession` on `./server` for an app's own `authenticate`), on
  every node behind a cluster adapter. `onRevoke(userId, sessionId | null)`
  tells the app when `logout` (the session's id) or `logout-all` (`null`)
  revoked; wire it as above. A disconnected client does not reconnect on
  its own; its next connect is authenticated afresh.
- `issueSession({ sessions, jwtSecret }, userId, { provider })` starts a
  session for an app's own sign-in flow (login codes, an embedded activity),
  and `liveSession` reads a token back; both work with `socketAuth`.

From the browser, `./client` speaks to these routes: `authProviders({
apiUrl })` lists the sign-ins the API serves (`GET /providers`: a provider
`google.optional` built nothing for is not in it, nor the mock where it is
off), so a login page shows only those, whatever the web app was built
with; `signInUrl(provider, { apiUrl, returnTo })` is the start route's URL
(to navigate to; `returnTo` defaults to the current page's origin), and
`signOut()` and `signOutEverywhere()` post to `logout` and `logout-all`. Each POST sends the
session cookie (`credentials: "include"`, so the API's CORS must allow the
web app's origin with credentials) with `Content-Type: application/json`,
and the token `setAuthToken` stored, if any, as a bearer token; the stored
token is forgotten either way, and a refusal or an unreachable server
rejects with a `QuickdrawError`. A socket keeps the user it signed in as
until it connects again, so reconnect the provider's connection after
signing out (with a token in `auth`, clearing it does that):

<!-- example: apps/web/src/components/SignIn.tsx#browser -->

```tsx
export function SignIn() {
  // GET /auth/providers: only the sign-ins this API serves (no Google button without its keys)
  const { data: providers = [] } = useQuery({
    queryKey: ["auth", "providers"],
    queryFn: () => authProviders({ apiUrl: API_URL }),
  });
  return (
    <nav>
      {providers
        .filter((provider) => provider.kind !== "guest")
        .map((provider) => (
          // the kit's GET /auth/{id}/start: back to this page's origin with the session cookie
          <a key={provider.id} href={signInUrl(provider.id, { apiUrl: API_URL })}>
            {`Sign in with ${provider.name}`}
          </a>
        ))}
    </nav>
  );
}

export function SignOut() {
  const { connection } = useQuickdraw();
  const leave = async (): Promise<void> => {
    // POST /auth/logout with the cookie: the session is revoked, the cookie cleared
    await signOut({ apiUrl: API_URL });
    // the socket keeps its user until it connects again, as nobody now
    connection.close();
    connection.open();
  };
  return (
    <button type="button" onClick={() => void leave()}>
      Sign out
    </button>
  );
}
```

An app's own REST route (a service worker's renewal, a webhook) signs the
user in with `requireSession` and calls the services in process, so the
method's validation, access check and tracked writes are a socket call's.
`sessionOf(req)` gives the route `{ userId, sessionId, principal }`, typed,
with no cast of `req` (`sessionOf<AppPrincipal>(req)` when `loadPrincipal`,
like `socketAuth`'s, builds the app's own principal; by default it is
`{ userId, kind: "user" }`); they are also set as `req.userId`,
`req.sessionId` and `req.principal`. `qd.caller(principal)` then loads the
user's grants as the user's sockets get them, so a method behind
`{ service: L }` passes or answers `FORBIDDEN` as it would over a socket:

<!-- example: apps/api/src/auth/routes.ts#rest -->

```ts
import { httpStatus, toWire } from "@fitzzero/quickdraw-core";
import { requireSession, sessionOf } from "@fitzzero/quickdraw-core/server/auth";

// 401 without a live session; the principal built as socketAuth builds a socket's
const signedIn = requireSession(
  { sessions, jwtSecret: env.JWT_SECRET },
  { loadPrincipal: (userId): AppPrincipal => ({ userId, kind: "user" }) },
);

app.get("/api/projects/:projectId/task-count", signedIn, (req, res) => {
  void (async () => {
    const { principal } = sessionOf<AppPrincipal>(req);
    try {
      // the method's validation, access check (with the user's grants) and writes, as over a socket
      const count = await qd.caller(principal).taskService.countOnBoard({
        projectId: req.params.projectId,
      });
      res.json({ count });
    } catch (error) {
      const failure = toWire(error);
      res.status(httpStatus(failure.code)).json(failure);
    }
  })();
});
```

`createMemorySessionStore()` keeps sessions in the process, for development
and tests. In production, store them in the database. Sessions are not live
data, so nothing needs their writes tracked: with the tracked client, the
first session write logs one development warning about a write outside a
unit of work, which running the store's writes inside `qd.run(...)` (or
using the untracked client here) avoids. Delete expired rows now and then.

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

## Testing

`@fitzzero/quickdraw-core/testing` boots the app's real server on a free
port, so a test exercises the same dispatcher, access engine, tracked writes
and frames production does (design: section 13):

<!-- example: apps/api/src/services/task.test.ts#app -->

```ts
it("sends a rename to the other members' boards", async () => {
  const app = await createTestApp({
    services: [projectService, taskService],
    db,
    strictWarnings: true,
  });
  const { call } = await app.connect(bo); // a real protocol 5 socket
  await call.taskService.get({ id: taskId });
  await app.as(ada).taskService.rename({ id: taskId, title: "Ship it" }); // in process
  await app.frames.waitFor({ event: "qd:e", userId: bo.userId }); // the entity frame bo receives
  await app.close();
});
```

- `createTestApp` takes `createServer`'s options, plus `strictWarnings`
  (below). Its sockets act as the principal they connect with, its rate
  limiter is off, and its dispatcher becomes the current one of the
  `initQuickdraw` instance that defined its services, so
  `qd.stream(...).push`, `qd.presence` and `qd.run` reach the test app (the
  last one created).
- Seed rows with the untracked client (`prisma`), or inside `qd.run` once
  an app runs: a tracked write outside any unit of work flushes on its own,
  with an `ambient-write` warning.
- `app.as(principal)` calls in process and `app.connect(principal)` over a
  real socket (`{ call, socket, hello, close }`); both are keyed by service
  name. `app.frames(match?)` lists every frame the server sent, with its
  socket and user; `frames.waitFor(match)` waits for one. A query of one
  event (`EventQuery`) takes `where`, a predicate over its frames typed by
  the event (`{ event: "qd:presence", where: ({ data }) => data.joined === id }`), and
  `streamFrames(contract, stream, where?, scope?)` and
  `eventFrames(contract, event, where?)` match one stream's items or one
  event's payloads, typed by the contract, to spread beside `socketId` or
  `userId`. `emitWithAck` and `waitForEvent` send raw frames and wait for
  events.

### Access matrices

`describeAccessMatrix(app, { service, principals, cases, via? })` runs each
case as each principal, and anonymously, through the app's real dispatcher
(in process, or over a socket per principal with `via: "socket"`), and fails
listing every cell that differs from the expected table:

<!-- example: apps/api/src/services/task.test.ts#matrix -->

```ts
it("lets the owner rename, members read, and nobody else in", async () => {
  const app = await createTestApp({ services: [projectService, taskService], db });
  await describeAccessMatrix(app, {
    service: taskService,
    principals: { owner: ada, member: bo, stranger: ed },
    cases: [
      { method: "get", input: { id: taskId }, allow: ["owner", "member"] }, // everyone else is denied
      {
        method: "rename",
        input: { id: taskId, title: "x" },
        expect: { owner: "allow", member: "FORBIDDEN" },
      },
    ],
  });
  await app.close();
});
```

`"deny"` (the default for everyone `allow` does not name) means
`UNAUTHENTICATED` without a principal and `FORBIDDEN` with one. Mutations run
for real, once per allowed principal: give inputs that can run again, or
`input` as a function of the cell (a `MatrixInputFactory` of the
`MatrixCell` `{ name, principal }`, sync or async), called before each
cell's call, that makes a row of its own (a task
to delete, an unused name), so no cell depends on the order of the
principals.

### Performance budgets

`expectBudget(run, { name })` makes performance something a test can fail
on. It runs one step of a test against the apps `createTestApp` started,
records what the step cost, and compares that with the entry `name` in the
budget file beside the test, `__budgets__/<test file>.json`. Commit the
file.

<!-- example: apps/api/src/services/task.test.ts#budget -->

```ts
it("counts a board within its budget", async () => {
  const app = await createTestApp({ services: [projectService, taskService], db });
  const result = await expectBudget(() => app.as(ada).taskService.countOnBoard({ projectId }), {
    name: "count a board",
  });
  expect(result.measured.calls).toHaveLength(1); // what the step cost: calls, statements, bytes
  await app.close();
});
```

It counts statements and bytes, never time, so a budget is the same on every
machine and on PGlite or PostgreSQL. It records:

- **each call** of the step (through `app.as(...)`, a socket or HTTP): its
  service and method, the statements its handler ran and its reply's bytes,
  from its completion record (`CallRecord.sqlStatements` and `bytes`;
  `app.as(...)` replies count as their JSON). The access check before the
  handler is not among a call's statements; the reads a kit's handler makes
  to filter by access are. A query that joined another call's shared run
  counts none: the run is counted once.
- **the whole step**: every statement the apps' tracked database clients ran
  while `run` did (access checks, handlers, flushes and subscription reads),
  and every byte the apps' servers wrote to sockets (a frame sent to a room
  counts once per socket that receives it), plus the in-process replies.

What it does with them:

- A missing entry is written. A step that costs less rewrites its entry, so
  the budget tightens as the code improves; under CI (`CI=1` or `CI=true`)
  it fails instead ("budget changed; rerun locally to accept"), so removed
  work is noticed and the lower budget is committed from a local run.
- A step that costs more fails, naming every number that grew with its old
  and new values. Set `QD_ALLOW_BUDGET_GROWTH=1` to accept every new budget,
  or `QD_ALLOW_BUDGET_GROWTH="list a page,count a board"` for the ones it
  names, and commit the file. A step whose calls changed (other methods,
  outcomes or how many) counts as growth.
- Each step of a test file has its own name: a name another test of the
  file already measured is a `TypeError` (the same test measuring it again,
  a retry, is fine).
- Statements must match exactly; bytes may move by up to 5% either way
  (ids and timestamps vary in length) without counting as a change.
- Await, inside `run`, everything the step should cost: the replies and the
  frames it is about. Measure one step at a time.
- A few reads happen once per process (the storage adapter asks once
  whether an order column may hold null). When a step could be the first to
  pay for one, run it once before measuring it, so its budget does not
  depend on the order tests run in.

### Development warnings

While `NODE_ENV` is not `"production"`, a running app warns about the slow
and untracked patterns lint cannot see, as they happen. Every warning has
one format and names the method call it happened in:

```text
[quickdraw:n-plus-one] taskService.board: task.findUnique by id ran 10 times in one call, once per item (N+1); ...
```

| Kind                     | Raised when                                                                                                                                                                                        |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `n-plus-one`             | a call ran 10 statements of one shape (model, operation, `where` keys), outside a `$transaction([])`                                                                                               |
| `unbounded-read`         | a call ran `findMany` with neither `take` nor ids to read (`id`, `{ in }` or `{ equals }`)                                                                                                         |
| `oversized-response`     | a reply was larger than `maxResponseBytes` (default 1 MiB)                                                                                                                                         |
| `nested-write`           | a write's `data` wrote a related row, which is not tracked                                                                                                                                         |
| `ambient-write`          | a tracked write ran outside any unit of work                                                                                                                                                       |
| `batch-read`             | a write in an array-form `$transaction` read its rows outside the batch                                                                                                                            |
| `batch-create-many`      | a `createMany` in an array-form `$transaction` could not report its rows                                                                                                                           |
| `repeated-call`          | one connection repeated a call or was refused `RATE_LIMITED` again and again (below)                                                                                                               |
| `tiered-field-in-output` | a method's own output schema declares a field the contract tiers, which only projection outputs strip; raised when the server is made (for an output without JSON Schema, when a reply carries it) |
| `resolver-without-reads` | a service's policy is, or combines in `anyOf`, a `resolver` without `reads`, so no tracked write re-checks it; raised when the server is made                                                      |

Updates and deletes by id inside an interactive transaction are not counted
toward `n-plus-one`: that is how per-row writes are written (see tracked
writes). Each is logged once per kind, service, method and subject (the
model, or the field of a nested write), under `category: "quickdraw.dev"`.
Only an app's own statements are checked: the framework's reads and the
kits' own reads are not, while the app's callbacks a kit calls (`prepare`,
`onChange`, `resolveUser`, a search strategy) are. A statement filtered by
an `id` list (`{ id: { in: ids } }`, one per chunk of ids) never counts
toward `n-plus-one`. In tests, `createTestApp({ strictWarnings: true })`
(under vitest or jest) throws every warning raised in that app's method
calls as a `DevWarningError` where it is raised, so the test that caused it
fails: the call it happened in fails with `INTERNAL` and the error as its
`cause`, and an in-process call whose reply was oversized rejects with it
once the reply was recorded (over a socket or HTTP the reply was already
sent, so that error is logged, not thrown). Strictness belongs to the app:
warnings outside its calls (an ambient write while seeding, another app's
calls) are logged as usual, and `app.close()` ends it. The ones raised when
the app is made, `tiered-field-in-output` and `resolver-without-reads`, are
thrown from `createTestApp` itself, so a strict app over such a method or
policy does not start.

A `repeated-call` warning names a client caught in a loop (a mutation fired
from an effect that its own result runs again, a refetch that triggers
itself) before the socket's rate limit answers `RATE_LIMITED` without saying
why: when one connection (a socket, an MCP session) calls a method with the
same input more than 10 times within a second, once per connection, service
and method; and when one is refused `RATE_LIMITED` more than 30 times within
a minute, once per connection. Calls without a connection (in-process,
HTTP) are not counted.
The client names the same loops from its side, in development, with the
same format: `repeated-mutation` when one `useMutation` issues its mutation
more than 5 times within a second (with the component that holds it), and
`repeated-invalidation` when `qd.invalidate` asks for one query key more
than 20 times within a second, or the invalidation coordinator refetches
or marks it stale that often. The coordinator's work is counted after its
coalescing, so a watched topic that changes 25 times a second (a few
refetches) is not named a loop.

### Components

`@fitzzero/quickdraw-core/testing/client` renders components against the
test app, with the real provider, hooks and socket:

<!-- example: apps/web/src/components/TaskBoard.test.tsx#render -->

```tsx
it("shows a task another user adds", async () => {
  const app = await createTestApp({ services: [projectService, taskService], db });
  const view = await renderWithQuickdraw(<TaskBoard projectId={projectId} />, {
    app,
    as: ada,
    client: qd,
  });
  await app.as(ada).taskService.create({ projectId, title: "Added elsewhere" });
  await view.findByText("Added elsewhere"); // the collection delta reached the component
  await app.close();
});
```

`renderWithQuickdraw(ui, { app, as, client, queryClient?, wrapper? })` is
async (Testing Library, an optional peer, is loaded lazily) and returns
Testing Library's result plus `connection`, `queryClient`, `disconnect()`
and `reconnect()`, which drop and restore the socket as a lost network does.

The web app's test imports the API's services across apps, as above, and
needs a database: run such tests in a jsdom project of their own, with the
API's global setup (the template its test databases boot from, below) and a
setup file that calls `installJsdomShims()` from `./testing/client`. That
adds what jsdom lacks, and keeps what it has: `scrollTo`, `scrollBy` and
`scrollIntoView` on elements (they do nothing; a list that follows its newest
item calls them) and `Blob.prototype.arrayBuffer` (PGlite reads a database
dump through it). This repository runs the README's example app that way:
`packages/core/vitest.config.ts`, project `readme`, with
`test/readme/globalSetup.ts` and `test/readme/workerSetup.ts`.

For a component test or a story without a server, `createMockClient(contracts)`
gives the typed client's shape with stubs; give it to the components in place
of the app's client (a module mock of the file that exports `qd`, say). It
comes from `./testing/client`, or from `@fitzzero/quickdraw-core/testing/mock`,
which names no Testing Library, for a browser bundle (Storybook):

<!-- example: apps/web/src/components/TaskBoard.test.tsx#mock -->

```tsx
const mock = createMockClient(contracts); // the typed client's members, with stubs
mock.task.board.mockScope(projectId, [card]); // what useCollection shows for the scope
mock.task.countOnBoard.mockResolvedValue(1); // what the query answers
mock.task.useEntity.mockRow({ ...card, notes: null }); // what useEntity shows for t1
afterEach(() => mock.$reset()); // forget it all (automatic when the runner has a global afterEach)
```

Each method member has `mockResolvedValue`, `mockRejectedValue`,
`mockImplementation`, `mockReset` and `calls`; streams have `mockItems`,
channels `sent` and events `mockEmit`. Everything set is forgotten after
each test only when the test runner has a global `afterEach` (vitest with
`globals: true`, or jest), where the mock registers its own reset
(`resetAfterEach: false` opts out); otherwise call `mock.$reset()` in an
`afterEach` of your own, as above. Optimistic updates are not shown.

The members' hooks need no provider. A component that reads the connection
(`useQuickdraw()`, `usePresence(room)`) renders inside the mock's own
provider, `mock.$Provider`, where those real hooks read the mock's session:
who it acts for, set with `createMockClient(contracts, { session })` and
`mock.$session({ userId, serviceAccess, isConnected, isKnown })` (each field
left out keeps its starting value, and the reset after each test puts the
starting session back), and the rooms `mock.$presence(room, userIds)` sets.
Its views select members for the session's user:

<!-- example: apps/web/src/components/TaskBoard.test.tsx#session -->

```tsx
it("lets a signed-in user through the gate", () => {
  mock.$session({ userId: "ada", serviceAccess: { taskService: "Admin" } }); // useQuickdraw() shows it
  render(<AuthGate>Board</AuthGate>, { wrapper: mock.$Provider });
  expect(screen.getByText("Board")).toBeTruthy();
});
```

In Storybook, a decorator renders every story inside `qd.$Provider`, and a
story's `beforeEach` sets its session (`qd.$session(...)`) beside its data.
A docs page renders its stories side by side, where one mock session would
show the last story's in all of them: give each its own with the
provider's `session` prop, `<qd.$Provider session={{ userId: null }}>`
(a `MockSession`, the type `$session(...)` takes too), laid over the
mock's session field by field for that subtree alone (the
real `useQuickdraw()` and `usePresence`, and the mock's views and admin
grants, read it there).

### Test databases

`@fitzzero/quickdraw-core/testing/prisma` gives each vitest worker a database
of its own: `createPrismaTestGlobalSetup` migrates a template once per run
and clones a database per worker on PostgreSQL (`TEST_DATABASE_URL`), or
builds a PGlite dump without one; `workerDatabaseUrl` and `resetDatabase`
(truncates every table) do the rest. On PGlite each worker boots its own
database from the dump with `openPgliteFromTemplate`, in milliseconds and
under jsdom too (it reads the dump through Node's `Blob`); the app's db
package gives its test client from it while tests run:

<!-- example: packages/db/src/testing.ts#worker -->

```ts
// this worker's own database: the migrated template, loaded in milliseconds
const pglite = await openPgliteFromTemplate(TEST_TEMPLATE);
export const prisma = new PrismaClient({ adapter: new PrismaPGlite(pglite) });
```

`TEST_TEMPLATE` is `{ migrationsDir, cacheDir, templateName }`, the same the
global setup builds with (`buildPgliteTemplate(TEST_TEMPLATE)`, or
`createPrismaTestGlobalSetup`), and a setup file empties the database before
each test (`beforeEach(() => resetDatabase(prisma))`). Apply `trackPrisma`
to the test client exactly as in production.

## Observability

`createServer({ stallWatchdog: true })` watches the event loop. It samples
the loop's delay every 20 ms (`perf_hooks.monitorEventLoopDelay`), reads it
every 10 s, and logs a warning (`category: "quickdraw.stall"`) when the 99th
percentile delay of that window is above 200 ms, or when one delay in it is
above 1 s, naming the window's slowest methods. `{ thresholdMs, maxMs,
intervalMs, slowest }` change the two thresholds, the window (at least 1 s)
and how many methods it names. A percentile needs repeated stalls: one
300 ms block in a 10 s window is one sample of about 500 and does not move
it, while a single block over `maxMs` warns on its own. On an idle process
the watchdog costs about 0.05% of one CPU.

`otelOnCall({ meter, tracer })` on `./server/otel` is an `onCall` handler
that records every call with OpenTelemetry (`@opentelemetry/api` is an
optional peer dependency, and only this entry imports it):

<!-- example: apps/api/src/observability.ts#otel -->

```ts
import { metrics, trace } from "@opentelemetry/api";
import { otelOnCall } from "@fitzzero/quickdraw-core/server/otel";

export const server = qd.createServer({
  app,
  services,
  db,
  // warns when the event loop's p99 delay passes 200 ms
  stallWatchdog: true,
  onCall: otelOnCall({ meter: metrics.getMeter("api"), tracer: trace.getTracer("api") }),
});
```

| Instrument                      | Kind      | Unit          |
| ------------------------------- | --------- | ------------- |
| `quickdraw.calls`               | counter   | `{call}`      |
| `quickdraw.call.duration`       | histogram | `s`           |
| `quickdraw.call.response.size`  | histogram | `By`          |
| `quickdraw.call.sql_statements` | histogram | `{statement}` |

Every point carries `quickdraw.service`, `quickdraw.method`,
`quickdraw.outcome` (`ok`, `not-modified` or the error code) and
`quickdraw.transport`; a call to a method that does not exist is recorded as
`_unknown`, so no client can add attribute values. With a tracer, each call
is also a server span named `service.method`, with an error status for
`INTERNAL` and `TIMEOUT`. With or without either, calls slower than `slowMs`
(default 1 s) or larger than `maxResponseBytes` (default 1 MiB) log at
`warn`.

## API docs from contracts

The `quickdraw-docs` command writes Markdown API docs from the contracts:
one page per service (its `describe`, its entity and field tiers,
projections, methods with their `describe`, kind, default MCP tool name
(`{service}_{method}`: a registry's `name`, `include` and `exclude` options
are not visible to the command), the MCP read-only hint on a query, input
fields and output, collections, streams, channels and events with their
`describe`, from the schemas' JSON Schema where they have one) and a
`README.md` index that lists each service's `describe`. It reads contracts (and, with `--services`, the
services' definitions), never source code.

```bash
quickdraw-docs packages/shared/src/index.ts --out docs/api           # write the pages
quickdraw-docs packages/shared/src/index.ts --out docs/api --check   # exit 1 when they are stale
quickdraw-docs packages/shared/src/index.ts --services apps/api/src/services/index.ts --out docs/api
```

With `--services <module>` (a module exporting the services, each or in a
list, as the server takes them; importing it must not start the server),
each page also says who may call what, read from the services'
definitions: an "Access" section with the row policy, whether a
service-wide `Admin` grant passes every check, who may watch the change
topic (`watchAccess`) and the field levels; each method's access form, in
words, and its `rowless`; who may open a collection's scope; a channel's
access; a stream's computed seed and when its items are checked. A
contract the services module has no service for says so, and a service
without a contract is an error. Pass the same flag to `--check`. The
services module is imported with everything it imports, as the server
loads it: the workspace packages it uses (`@project/db`, `@project/shared`)
load from their built output when their `package.json` points there, so
build them first (`bun run build`, or `turbo run build --filter` for those
packages) in a script that runs the docs on a fresh checkout; the error
says so when a built file is missing. The contracts module, which imports
only the shared package's own sources, needs no build.

The module may export each contract, or a map of them as given to
`createQuickdrawClient`. A TypeScript module loads through Node's type
stripping, or through `tsx` when the project has it installed (for
extensionless imports and `tsconfig` paths, which Node's loader refuses); a
module whose own code throws runs once and its error is reported as is. Pages are only ever replaced
or removed when they start with the generator's marker, and they are laid
out as oxfmt and Prettier format Markdown, so formatting them changes
nothing.

Where the pages live depends on how busy the repository is:

- **Few pull requests at a time:** commit the pages and run `--check` in
  CI next to the lint step.
- **Many at a time** (several agents, each changing methods): a committed
  generated file is a merge conflict in every pair of pull requests that
  touch contracts. Regenerate the pages on each push to the base branch
  instead, with the workflow the `quickdraw-api-docs` skill of
  [`@fitzzero/quickdraw-skills`](packages/skills) ships (a job with a
  read-only token generates them, a second job commits them), and never
  commit them by hand.

## Lint rules and agent guidance

[`@fitzzero/quickdraw-lint`](packages/lint) is the oxlint plugin and base
config every 5.0 app extends: it reports untracked and foreign writes, nested
and raw SQL writes, hand-sent frames, inline auth guards, unbounded reads,
database calls and emits in loops, layering breaks, bypasses of the typed
client, hand-written copies of kit methods (`prefer-kit`, a warning),
contract members without a `describe` (`require-describe`, a warning), and
every removed 4.x API with its replacement. Each rule supports a baseline,
so an app can adopt it before fixing old code.

The guards follow one order of preference, so an agent moving fast meets a
mistake as early as it can be caught: a type error; then a refusal when the
service is defined (an access form that checks no row on a method that
takes an `id`, unless it says `rowless: true`); then lint; then a
development warning as it happens (`repeated-call`, `repeated-mutation` and
`repeated-invalidation` name a client loop before the rate limit does).

[`@fitzzero/quickdraw-skills`](packages/skills) ships agent rules and skills
for quickdraw apps and links them into `.claude/` with
`quickdraw-skills link`, so every app's agents read the same, current
guidance:

```jsonc
// package.json
{
  "scripts": {
    "prepare": "quickdraw-skills link",
  },
}
```

## Migrating from 4.x

[`@fitzzero/quickdraw-codemod`](packages/codemod) moves a 4.x app to 5.0:
contracts from the method maps, `defineService` from the service classes,
the typed client for the hooks, and a report of everything left to decide.
[`MIGRATION.md`](MIGRATION.md) explains each step, the access mapping and
the defaults that changed; [`UPGRADE-PROMPT.md`](UPGRADE-PROMPT.md) is the
procedure for an agent. Both ship with the codemod, at
`node_modules/@fitzzero/quickdraw-codemod/MIGRATION.md` and
`node_modules/@fitzzero/quickdraw-codemod/UPGRADE-PROMPT.md`.

```bash
bunx @fitzzero/quickdraw-codemod v5 .
```

## Package exports

| Export             | Holds                                                                                                                                                                                                                                           |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`                | `defineContract`, `query`, `mutation`, `nullable`, `listOf`, `via`, the kits' contract halves, inference types, `QuickdrawError`, error codes, protocol types, room and topic names                                                             |
| `./server`         | `initQuickdraw`, `createServer`, `createDispatcher`, `createHttpRouter`, policies, `custom`, the kits' handlers, `requireRow`, `nextOrdinal`, `storageOf`, dev warnings, the Redis adapter, the socket rate limiter, env and encryption helpers |
| `./server/auth`    | `createAuthRoutes`, `socketAuth`, `requireSession` and `sessionOf`, providers (`google`, `discord`, `mock`, `guest`), session stores, `issueSession`, `liveSession`, JWT, cookie and origin helpers                                             |
| `./server/express` | Express rate limits: `createAuthLimiter`, `createAuthStatusLimiter`, `createCallLimiter`, `createPublicApiLimiter`, `createWebhookLimiter`                                                                                                      |
| `./server/mcp`     | `createMcpRegistry`, `describeTools`, `createMcpStdioServer`, `createMcpHttpRouter`, `bootstrapMcpServer`                                                                                                                                       |
| `./server/otel`    | `otelOnCall`                                                                                                                                                                                                                                    |
| `./prisma`         | `trackPrisma`, `storageOf`                                                                                                                                                                                                                      |
| `./client`         | `createQuickdrawClient`, `QuickdrawProvider`, `useQuickdraw`, `usePresence`, `useAdminServices`, `createQuickdrawConnection`, `call`, `callData`, `liveDataOf`, the coordinator; everything in `./utils`                                        |
| `./utils`          | `createServerCaller`, cache keys (`methodKey`, `entityKey`, `collectionKey`), formatting, navigation, `parseJWTPayload`                                                                                                                         |
| `./parser`         | the JSON-only Socket.IO parser                                                                                                                                                                                                                  |
| `./testing`        | `createTestApp`, `describeAccessMatrix`, `expectBudget`, `createRecordingSink`, `DevWarningError`                                                                                                                                               |
| `./testing/client` | `renderWithQuickdraw`, and everything in `./testing/mock`                                                                                                                                                                                       |
| `./testing/mock`   | `createMockClient` alone, without Testing Library: for browser bundles such as Storybook                                                                                                                                                        |
| `./testing/prisma` | test databases on PostgreSQL or PGlite                                                                                                                                                                                                          |

The package also ships the `quickdraw-docs` command.

## Developing this repository

A bun workspace with turbo: `packages/core` (this package), `packages/lint`,
`packages/skills` and `packages/codemod`. See
[CONTRIBUTING.md](CONTRIBUTING.md).

```bash
bun install
bun run build && bun run typecheck && bun run lint && bun run test
bun run format:check
```

The README's examples live in `packages/core/test/readme/`: edit them there,
then run `bun run readme:sync` in `packages/core` to copy them in here.

## License

MIT
