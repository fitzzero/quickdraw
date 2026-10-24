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
| `./client/core`                         | `socket.io-client`                                                      |
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
  // what the MCP bridge's context hook gives an agent's calls, as ctx.mcp
  mcp: { readonly scopes: readonly string[] };
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
the same `app` (see the [auth routes kit](#auth-routes-kit)). `verifySession`
checks a bearer token against the session store on every call
(`bearerAuth`), so a signed-out or revoked session stops at once:

<!-- example: apps/api/src/auth.ts -->

```ts
// The app's sessions, token check and grants, for the README's server examples.

import type { AccessLevel } from "@fitzzero/quickdraw-core";
import { bearerAuth, createMemorySessionStore } from "@fitzzero/quickdraw-core/server/auth";
import { db } from "./db";
import type { AppPrincipal } from "./quickdraw";

/** Signs the session JWTs: one secret for the auth routes and `socketAuth`, 32 characters or more. */
export const jwtSecret = process.env.JWT_SECRET ?? "";

/** The sessions the auth routes issue. In production, a store over the database (see the auth routes kit). */
export const sessions = createMemorySessionStore();

/**
 * The agent a bearer token signs in, or `null` for no token: checked against
 * the session store on every call, so a signed-out or revoked session stops
 * at once. An agent, so methods with `kinds: ["user"]` refuse it. Never
 * `verifyJWT` alone, which checks no session.
 */
export const verifySession = bearerAuth({
  sessions,
  jwtSecret,
  loadPrincipal: (userId): AppPrincipal => ({ userId, kind: "agent" }),
});

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
// It has an id, and its pair is unique by @@unique: the write tracker keys
// rows by id, so a table keyed by a composite @@id is never tracked, and a
// member removed from it would never be revoked.
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
- A service name holds no `:` or `@`: it is part of every room name of the
  service (`qd:e:{service}:{id}@{level}`, `qd:c:{service}:{collection}:{scope}`),
  which must split one way only, so `defineContract` throws on one.
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
        // an agent's call carries its token's scopes as ctx.mcp; a user's call has none
        if (ctx.mcp !== undefined && !ctx.mcp.scopes.includes("tasks")) {
          throw new QuickdrawError("FORBIDDEN", "This token may not assign tasks");
        }
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
  flush together once; and it is cancelled with `ctx.signal`. It carries
  the calling method's `ctx.mcp` as well: every call an MCP call makes
  through `ctx.services`, nested ones included, sees the MCP call's fields
  with transport `"internal"`, so tell a token's call apart by `ctx.mcp`,
  never by `ctx.transport`. It is typed by the `contracts` of
  `initQuickdraw`'s types, as `qd.caller` is.
- `share: "caller"` runs identical concurrent calls of one principal once,
  `share: "all"` across principals; `ttlMs` keeps a shared result. A
  `"all"` run's handler sees the first caller's `ctx` and every caller gets
  its result, so a result shared across principals must depend on the
  input only: it never reads `ctx.principal`, `ctx.services`, `ctx.mcp`,
  `ctx.access` or a context field made from them (in development, reading
  one of the first four warns `[quickdraw:shared-principal]`; copying or
  logging the whole `ctx` reads them too). `"all"` is refused with
  `custom` access and on the kit methods whose result depends on the caller
  (the read/write kit's `list` and `getMany`, `search`, the sharing kit's
  `listShares` and `listMembers`, the admin kit's `adminList` and
  `adminGet`): give those `"caller"`. Callers of a shared run whose levels
  hide the same fields get one copy of its result, encoded once for all of
  their sockets.
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
      access: { entry: "Moderate" },
      // users only: an agent acting for one is refused, whatever its grants
      kinds: ["user"],
      handler: ({ input, ctx, db }) =>
        db.task.update({ where: { id: input.id }, data: { assigneeId: ctx.principal.userId } }),
    },
    triage: {
      // Moderate on the task's project, from a token that may triage: claims add to the form
      access: { entry: "Moderate" },
      claims: (claims, input) => claims?.scope === "triage" && input.status !== "archived",
      handler: ({ input, db }) =>
        db.task.update({ where: { id: input.id }, data: { status: input.status } }),
    },
    assigned: {
      // Read on the project the input names, asked through ctx.access; none named, the caller's
      // own that they may still read
      access: custom(
        async (ctx, input) =>
          input.projectId === undefined || (await ctx.access.can(project, input.projectId, "Read")),
      ),
      handler: async ({ input, ctx, db }) => {
        const readable = await ctx.access.where(task, "Read");
        if (readable === "none") return [];
        return db.task.findMany({
          where: {
            AND: [{ assigneeId: ctx.principal.userId, projectId: input.projectId }, readable],
          },
          take: 100,
        });
      },
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
  lowest first, are `Public`, `Read`, `Moderate` and `Admin`. A `custom`
  form replaces the row check, and a service-wide `Admin` grant skips it: a
  check on the caller's claims is `claims` (below), and one that needs the
  caller's level on a row asks `ctx.access` (`assigned` above, and below).
- `kinds`, beside `access`, says which kinds of principal
  (`principal.kind`) may call: `initQuickdraw({ kinds: ["user", "agent"] })`
  for every service the app defines, `defineService(contract, { kinds })`
  for one service, and a method's own `kinds` (`claim` above). Each level
  only narrows the one above it: a wider or empty list is refused when the
  service is defined. A principal of another kind, or without a `kind`,
  gets `FORBIDDEN` before the form is asked, and no grant passes the check,
  a service-wide `Admin` grant included, since a token acting with someone's
  grants is what it stops. An anonymous caller is left to the form, so a
  `"public"` method takes no `kinds` of its own: a refused caller would call
  it signed out. A service's list also holds for its entity, collection,
  topic and stream subscriptions, and its channels drop the messages of
  other kinds.
- `claims: (claims, input) => boolean`, beside `access` on a method, is a
  requirement on the caller's verified claims (`principal.claims`, a
  token's `scope`; `triage` above). It adds to the form, so `triage` needs
  Moderate on the task's project and a triage token. It runs right after
  `kinds`, outside the access engine, so no grant passes it, a service-wide
  `Admin` grant included. Without a principal the call is
  `UNAUTHENTICATED`; when it returns anything but `true`, `FORBIDDEN`. It is
  synchronous, and a `"public"` method takes none. A token narrowed by
  `claims` is narrowed only on the methods that declare it; elsewhere it
  acts with its user's grants (`kinds` keeps a kind of token out).
- On a service with a policy, a method whose input has `id` under a form
  that asks the policy nothing about the row that id names would let anyone
  that form admits reach any row by its id, so `defineService` refuses it,
  naming the method and the ways out. Those forms are the ones that check
  no row (`"public"`, `"authenticated"`, `{ service: L }` below `Admin`),
  `custom(fn)`, `{ scope, of, id }` (a row of another service) and
  `{ entry, id }` naming another key. The ways out: a form the policy
  decides (`{ entry: L }`, or `{ service: L, entry: L }` to keep the grant,
  with `claims` beside it for a check on the caller's claims), or
  `rowless: true` on the method when every such caller may reach any row on
  purpose (the `title` method above; public profiles, lookups by an id that
  tells nothing), or when `id` names a row the method creates (an id the
  client made, under a `scope` form). A `rowless` query under a form that
  checks no row also answers "not modified" for any `id`; under any other
  form it runs its handler every time. A kit's methods take it as
  `rowless: ["get"]` in the kit's options. The input's keys come from its
  JSON Schema: an `id` in any branch of a union counts, and so does one
  beside a value JSON Schema cannot write (a `Date`, a `Set`). Not checked:
  an input without JSON Schema (Zod 3) or whose JSON Schema names no keys (a
  `todoSchema` without `keys`), one that is no object (a bare string
  that is the id itself), a row named by another key (`ids`, `taskId`, a
  nested `where.id`) under a form that checks the row `id` names, and an
  `entry` form whose `id` is a function, which names its row in code.
- A service-wide `Admin` grant passes every access form on its service
  (`adminBypass: false` turns that off), though not `kinds` or `claims`. A
  grant below `Admin` counts only where the form names `service`: a `Read`
  grant does not read every row.
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
  parent's policy only: grants on the parent's service do not flow down. A
  membership table needs an `id` column (the pair unique by `@@unique`),
  or its writes are not tracked and a removed member is never revoked.
- One policy decides every surface: method calls, entity subscriptions,
  collection scopes, the kits' lists and searches, streams and channels.
- When a tracked write lowers or removes someone's access, a relation-form
  foreign key included (`project: { connect }`), their sockets leave the
  rooms anchored on that row and get `qd:revoked`; a changed level moves
  them to that level's room. In a cluster the change is broadcast to every
  node. Every socket's re-resolution settles before the flush's frames go
  out, a failed one included.
- `server.dispatcher.access` gives the same answers to other code:
  `levelsFor(service, principal, ids)`, `accessWhere(service, principal, level)`
  (a `where` filter for `findMany`, or `"none"`) and `onAccessChanged(listener)`.
- `ctx.access` gives them to a handler or a `custom` form, as the caller:
  `levelsFor(service, ids)`, `can(service, id, level)` and
  `where(service, level)` are those bound to `ctx.principal`, with the
  grants the call runs with (a socket's, or those an in-process caller
  loaded); `service` is a contract or a service name. A form can then check
  a row no `{ entry }` or `{ scope }` form names: a parent the input
  names, or a key that is optional, as in `assigned` above, which passes
  without a project and needs Read on one it names. Its handler adds
  `where(task, "Read")` to its query with `AND`, so a list without a
  project still follows the row policy. Never spread the filter into
  `where`: it and the input both set `projectId`, and whichever comes last
  wins, widening a list with a project or dropping the policy from one
  without. `ctx.access` counts levels as
  `{ entry }` does: a service-wide `Admin` grant reaches every row (with
  `adminBypass`), a row that is not found gives anyone else no level
  (`can` is `false`), and an anonymous caller has none anywhere (an empty
  map, `false`, `"none"`). So a form that asks it about a parent counts a
  service-wide `Admin` grant on the parent's service, which
  `{ scope, of }` does not: prefer `{ scope: L, of, id }` when the input
  always names the parent. A `custom` form is still no row check of the
  method's own `id`: a method whose input has one needs `rowless: true`
  beside it (above). Every method call has it, MCP and `ctx.services` calls
  included, and so do the `ctx` the kits pass to their forms and callbacks;
  a context no dispatcher built throws `INTERNAL` on its use, and `qd` has
  none: a job asks `server.dispatcher.access`.
- `createServer({ access: { cacheMs: 30_000 } })` keeps policy lookups across
  requests; tracked writes to the columns and membership tables the policies
  read evict them as soon as the write is durable (a transaction's at its
  commit, a rolled-back one never), so a check later in the same call sees
  it, as does any other request on that node. Servers behind a cluster
  adapter evict when the write's flush broadcasts its access change, after
  the call. A process that broadcasts nothing (a job on a bare
  `createDispatcher`, or a server without a cluster adapter) reaches other
  processes' caches only when the time passes, as do writes the tracked
  client cannot see, so the cache is off by default. A lookup inside a
  transaction (`db.$transaction`, a sharing change) reads the database,
  never the cache.

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
- A transaction nested in an interactive one,
  `tx.$transaction(async (inner) => ...)`, runs as a savepoint of it
  (Prisma 7) and is tracked the same way: its writes join the transaction
  around it when the savepoint is released, and are dropped when it rolls
  back, even when the transaction around it catches the error and commits.
  Inside a transaction's callback, write through its client (`tx`,
  `inner`) what must commit or roll back with it. Work on `db` there runs
  outside the transaction, on a connection of its own, and is tracked as
  such: a write (a `createMany` or `updateMany` too) commits at once, and a
  `db.$transaction` of its own commits on its own, so their frames are sent
  whatever the transaction then does. (A database with one connection, as
  PGlite in tests, runs that work only once the transaction ends.) A
  transaction's client writes to its own transaction wherever it is used,
  inside another transaction's callback too, and once that transaction
  ended its writes are refused, as Prisma refuses them. An array-form
  `$transaction([...])` begun on either client is a transaction of its
  own, as Prisma runs it: the root client's operations in it commit with
  it, while one made on `tx` in it runs in `tx`'s transaction (the
  tracking hook awaits it there; Prisma alone would run it in the batch).
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

- A helper that writes takes the tracked client by its type. `trackPrisma`
  returns `Tracked<C>`: still a `C` wherever one is asked for, while the
  untracked client is no `Tracked<C>`. Type the helper's client
  `Tracked<PrismaClient>`, or `TrackedTransaction<PrismaClient>` when it
  may also run inside `db.$transaction(async (tx) => ...)`, whose `tx` is
  one (`db` is one too), and the untracked client passed to it is a type
  error. A helper typed `PrismaClient` takes either client. Both types are
  type-only, on `./prisma` and on the root export, so a shared package
  names them without Prisma. `no-untracked-write` reads the type too, when
  the file imports it from quickdraw (under any name): a parameter, a
  destructured binding or a class member so typed may be named `prisma`.

<!-- example: apps/api/src/jobs/overdue.ts#helper -->

```ts
import type { TrackedTransaction } from "@fitzzero/quickdraw-core/prisma";
import type { PrismaClient } from "@project/db";

// takes the tracked client, or a transaction's: passing the untracked `prisma` is a type error
export async function reopenStale(
  client: TrackedTransaction<PrismaClient>,
  projectId: string,
): Promise<number> {
  const { count } = await client.task.updateMany({
    where: { projectId, status: "stale" },
    data: { status: "open" },
  });
  return count;
}

export async function restoreProject(projectId: string): Promise<number> {
  return await qd.run(() =>
    db.$transaction(async (tx) => {
      await tx.project.update({ where: { id: projectId }, data: { archived: false } });
      return await reopenStale(tx, projectId);
    }),
  );
}
```

- Not seen: the related rows of a nested write
  (`{ labels: { create: [...] } }`, which warns in development), raw SQL and
  database cascades. A foreign key a nested write sets on the written row
  (`project: { connect }`, `parent: { disconnect: true }`) is seen: such an
  `update` or `upsert` reads the row's interested columns first, one more
  statement. Before deleting a row, delete or clear through `db` the rows
  a cascade would take with it (for the admin kit's `adminDelete`, in its
  `prepare`). Record raw SQL with
  `ctx.touch("task", ids)`, or `{ removed: true }` for deleted rows. A touch
  inside a transaction's callback joins that transaction, as a write
  through `tx` there would: touch a root `db.$executeRaw` made there after
  the callback, or the transaction's rollback drops it. A job
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
  through untracked, with one warning. Membership and junction tables
  included: give them `id String @id @default(cuid())` and keep the pair
  unique with `@@unique([...])`, never a composite `@@id`. `createServer`
  checks, at start, every model a policy, a membership table or a `via`
  junction depends on, and logs `[quickdraw:untracked-access-model]` as an
  error, in every environment, for one it cannot track; a test app made
  with `strictWarnings` fails to start.
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
  `versionColumn`s or passes `changeLog: false`. For a query, it comes only
  when its form checked the row `id` names (an `entry` form on `id`, a
  `scope` form on the service's own rows by `id`, `{ service: "Admin" }`),
  for a caller the service's `Admin` bypass passes, or for a `rowless`
  method under a form that checks no row (`"public"`, `"authenticated"`,
  `{ service: L }`): it answers before the handler runs, so it would tell
  any other caller that the row exists and has not changed. Any other
  query runs its handler.
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
  comes back has its clients reconnect to catch up. Give each deployment its
  own Valkey, or its own `cluster.keyPrefix` (which `setupRedisAdapter` takes
  as its key): a node applies only its own deployment's events (once every
  deployment that shares the Valkey runs this version), and a Valkey's `db`
  does not separate pub/sub.
  [docs/deploying.md](docs/deploying.md) has the wiring, what holds across
  nodes, what it costs, what happens when a node or Valkey stops
  answering, and a production checklist.

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
    // a user opens only the scope that is their id; its items still follow access above
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
  Over the item service's own `members` table (a `members` read of the
  policy, alone or inside `anyOf`, whose `entry` is the via's `entry` and
  whose `user` is the via's `scope`), a link counts only when its
  role gives at least the collection's `access`: a role change across that
  line adds or removes the entry, and a link below it is in no page, count,
  index, `qd:col:items` or scoped search. When the item reads the junction
  (a chat's `memberCount`), declare
  `via({ model, entry, scope, refreshEntry: true })`: every junction write
  then also sends the entry again, `updated`, to each scope that still
  holds it, for one more read of the item per flush.
- `qd:col:sub { s, c, scope }` authorizes the scope through its anchor's
  policy, then answers a page and joins the scope's room; flushes send `qd:c`
  deltas to it (`added`, `updated`, `patched`, `removed`, or `reset` for more
  than `bulkThreshold` rows, default 200). A `"self"` scope is the
  subscriber's own user id: its items are stripped at `Read`, and it may not
  declare a higher `access`. On a service with an access policy its items
  still follow that policy: a page, `qd:col:items` and every flush hold only
  the rows its user may read at `Read`. A row the user loses goes out
  `removed`, and a change to their membership of a parent row (or a reload
  of their grants) sends `reset`, so the list loads again; a client that
  resumes the list after such a change reads a page. A change to a parent
  row's own access columns (a project's owner or access list) reaches the
  list only at the rows' next write or the list's next load.
- `requires: { service: L }`, beside `anchor` or `scopeAccess`, also asks
  for a service-wide grant of at least `L` on the collection's service, as
  its methods under `{ service: L }` do: both checks must pass, and a
  service-wide `Admin` passes either. It is for a list whose methods need
  the grant, `mine: { scopeAccess: "self", requires: { service: "Read" } }`
  beside methods under `{ service: "Read" }`; a list whose rows its users
  read by their level on each row (`assigned` above) takes none. Without
  the grant, `qd:col:sub` (cursor pages included), the scope's change
  topic and a search kept to the scope are `FORBIDDEN`. The grant comes
  from the socket's principal, never a read: when the user's grants reload
  below it (`server.access.refresh`, a tracked write of the grants column,
  on any node), each of their sockets leaves the scope with `qd:revoked`
  (`reason: "access"`) and gets nothing more of it. A collection without
  `requires` is unchanged.
- Items are visible to everyone in an anchored scope: no per-row policy or
  field tier applies inside it. Derive the item service's own access from
  the anchor (`inherit` from it, as above): a per-row policy on the item
  service (an owner column, a row's access list) is not applied to an
  anchored scope's items, so a row it would hide still reaches everyone in
  its scope. A `"self"` scope is the exception: its items follow the item
  service's policy for its user.
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
  leaves the topic after one last `qd:changed`. A watch whose access
  changed while it was answered is authorized again before it joins the
  topic, with the socket's principal as it is then, and answered
  `FORBIDDEN` when it lost access; it hears nothing until it joins. Entity
  and collection subscribes re-check the same way, with the grants the
  socket holds then (a grant lowered mid-subscribe denies, a raised one
  answers at its level), but from inside their room, which they need to
  catch every change after the snapshot they read: a frame sent while they
  re-check can reach a socket that is then refused, and the client drops
  it with the refusal.
- The socket rate limiter does not count subscription events; each socket
  runs `qd:sub`, `qd:col:sub`, `qd:col:items` and `qd:watch` in a lane
  instead: `limits.subscriptions` (8 at once, 64 waiting), then
  `RATE_LIMITED`. A socket holds at most 10,000 entity ids, 1,000
  collection scopes, 1,000 topic watches and 500 stream feeds at once:
  one more is `CONFLICT` (a `qd:sub` whose new ids would pass the cap is
  refused whole, and a row that batches running at once left no room for
  is answered `CONFLICT` on its own), one held already never counts again,
  and `qd:hello`
  announces the caps (`limits.subscriptions.maxEntityIds`, `maxScopes`,
  `maxTopics`).

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
  `peers: true` serves peer links between the clients of an app room
  ([Peer links](#peer-links)).
  Socket.IO's connection state recovery is refused: `createServer` throws
  for `socket: { connectionStateRecovery }`, since a recovered socket would
  come back with its principal and rooms without authenticating again, so a
  revoked session or a lowered grant would return. Clients resume by
  revision on every reconnect instead.
- **HTTP**: `POST /qd/{service}/{method}` with the input as a JSON body and
  `Content-Type: application/json` (required, even without a body, so a
  cross-site page cannot use a session cookie without a CORS preflight). The
  principal comes from the session cookie (`__Host-session` over HTTPS,
  `session` over plain HTTP or with `COOKIE_DOMAIN`, as the auth routes name
  it) or an `Authorization: Bearer` token through the same
  `authenticate`, which is told which one the transport chose
  (`request.credential`): `socketAuth` answers a cookie sent from a page
  outside `allowedOrigins` with `FORBIDDEN`, as it refuses such a socket.
  The cookie is `auth.token` only for `socketAuth`'s `authenticate`; any
  other finds it in `request.sessionCookie` alone, and `auth.token` holds
  only a bearer token. The reply is `{ ok: true, d }` or
  `{ ok: false, e: { code, message, data? } }` with the code's HTTP status.
  Works on Express 4 and 5, and on a bare Node server. Move it with
  `http: { path }`, turn it off with `http: false`, or mount
  `createHttpRouter({ dispatcher, auth })` yourself. It has no rate limit of
  its own: on Express, set `http: { rateLimit: createCallLimiter() }` (from
  `./server/express`), which refuses with the `RATE_LIMITED` reply. An app
  without sockets makes its dispatcher with
  `createDispatcher({ services, db, serviceAccessSource })` when users'
  grants are stored in a column (the admin kit protects that column only
  where the dispatcher names it, as `createServer` does from
  `auth.serviceAccessSource`), and `createHttpRouter` throws when its
  `auth.serviceAccessSource` is not its dispatcher's. An MCP process made
  with `createDispatcher` names it the same way.
- **In process**: `server.dispatcher.caller(principal)` or
  `qd.caller(principal)`: `await qd.caller(user).taskService.rename(input)`,
  typed by the `contracts` of `initQuickdraw`'s types. A principal that
  carries no `serviceAccess` gets the grants `auth.loadServiceAccess`
  loads, as a socket's handshake and an HTTP call do: at the caller's first
  call, and again at its next call after the server applied new grants to
  a user (`server.access.refresh`, a tracked write to
  `auth.serviceAccessSource`). One that carries grants (even `{}`) keeps
  exactly those. A load that fails rejects the call with `INTERNAL`.

`authenticate` takes one request (`{ transport, auth, headers, socket | req }`,
plus `credential` and `sessionCookie` on HTTP) for both transports and
returns a principal, a user id, or nothing for an anonymous caller; throwing
`QuickdrawError("UNAUTHENTICATED", ...)` (or `"FORBIDDEN"`) refuses: a
socket's handshake is refused `UNAUTHENTICATED`, which signs a quickdraw
client out, and an HTTP call is answered 401 (403 for `FORBIDDEN`).
Anything else it, or `loadServiceAccess`, throws is the server's failure
(its session store or database down): a socket's handshake is refused
`INTERNAL`, and a quickdraw client keeps the user and connects again by
itself, and an HTTP call is answered `INTERNAL` (500), which
`createServerCaller` rejects with. So a plain `Error` thrown for bad
credentials signs nobody out: in development the server warns once when
`authenticate` throws anything but a `QuickdrawError`
(`[quickdraw:authenticate-threw]`), and lint's `no-plain-error-refusal`
reports one thrown in an `authenticate` (or `socketAuth`'s `loadPrincipal`)
written where the server is made. On HTTP the session cookie is in
`auth.token` only for `socketAuth`'s `authenticate`.
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
the HTTP status of the error code as `code`. A call through the shim runs
with the `ctx.socketId` and `ctx.rooms` of the socket it arrived on, so a
handler can put a 4.x client in an app room; it leaves its rooms when it
disconnects, and `onRoomLeave` and presence hear it as they hear a 5.0
socket. 4.x subscriptions, collections and channels are not served, and a
contract's events reach only 5.0 sockets: delivering events to 4.x
listeners stays the app's own raw emit to the room until those clients
speak protocol 5. Each service, method and principal kind that calls
through the shim is logged once at `warn`, so the remaining 4.x clients can
be found.

A service renamed during the migration keeps its old name for 4.x clients
through aliases: with `legacyWire: { aliases: { taskService: "cardService" } }`,
`socket.emit("taskService:get", payload, ack)` runs `cardService.get`, with
that method's validation, access and `onCall` (grants are read under
`cardService`, never under the old name). Its log line names the alias, once
per old name, method and principal kind, so the app can see when the old name
is no longer called. Each alias must name a registered service and must not be
one itself, or `createServer` throws. Only 4.x events are aliased: a protocol-5,
HTTP or MCP call to `taskService` finds no service.

### MCP bridge

`@fitzzero/quickdraw-core/server/mcp` serves the services to AI agents as MCP
tools generated from their contracts at startup: one tool per method, named
`{service}_{method}`, described by the method's `describe` text (without
one, by `service.method (kind)`, which tells an agent nothing), with the
input schema's JSON Schema as its arguments and `readOnlyHint` on every
query. The API docs print each method's default tool name and its read-only
hint. Every tool call goes through the dispatcher with transport `"mcp"`,
so input validation and access checks apply as on a socket. Queries share
a concurrency lane per caller (16 run and 64 wait by default, the
dispatcher's `limits`, then `RATE_LIMITED`): a stdio process, and on HTTP
a bearer token, a user without a token, or the address of an anonymous
caller (Express's `req.ip`, an IPv6 address by its /56). Behind a proxy,
set Express's `trust proxy`, or every anonymous caller shares the proxy's
lane. A `principal` hook that authenticates by anything but the bearer
token (a cookie, an API key header) must refuse a request whose bearer
token it does not verify, or a caller makes a lane per made-up token. The
HTTP routes have no rate limit of their own: limit them per address, as
below (`createPublicApiLimiter` answers 429 with `{ error }`, not the
routes' `{ success: false, code }`). A method whose input cannot describe
itself as JSON Schema stops the registry at startup, naming the method,
unless it is excluded.

<!-- example: apps/api/src/mcp.ts#mcp -->

```ts
import { createPublicApiLimiter } from "@fitzzero/quickdraw-core/server/express";
import {
  createMcpHttpRouter,
  createMcpRegistry,
  createMcpStdioServer,
} from "@fitzzero/quickdraw-core/server/mcp";

const summarizeInput = z.object({ projectId: z.string() });

const registry = createMcpRegistry({
  services: [projectService, taskService],
  dispatcher: server.dispatcher,
  // an agent acting for the user of a session token, checked on every call; no token is anonymous
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

// GET /mcp/tools, POST /mcp/invoke; the routes have no rate limit of their own, so limit them per
// address (never by the bearer token, which nothing has checked yet)
app.use("/mcp", createPublicApiLimiter({ max: 600 }));
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
  `{ success: false, error, code, data? }` with the code's HTTP status. A
  request from a web page (one with an `Origin` header) is answered 403
  unless `createMcpHttpRouter({ allowedOrigins })` lists its origin (exact
  origins or anchored patterns, as `socketAuth` takes them; none by
  default); an MCP client sends no `Origin`. `allowedOrigins` adds no CORS
  headers: a page on another origin still needs the app's CORS setup. For a
  server on a developer's machine or a LAN,
  `allowedHosts: ["localhost", "127.0.0.1", "::1"]` also refuses a request
  for any other `Host`, which a DNS-rebinding page would send. An entry with
  a port matches that port only (a `Host` without one is for port 80 or
  443).
- An anonymous caller (the `principal` hook returned nothing) may call
  `"public"` methods, and custom tools that declare `access: "public"`; any
  other tool answers `UNAUTHENTICATED` before it runs. A failed call reaches
  the agent as a tool error carrying the code.
- The tool list is the registry's, the same for every caller: `tools/list`
  and `GET /mcp/tools` are not filtered by the principal, so an agent sees
  tools it may not call (and its call is refused). Keep a tool out of the
  list with `exclude` or `include`, per registry, and serve agents of
  different reach from separate registries.
- `kinds` sees only what the `principal` hook labels: `verifySession` above
  labels every MCP caller `kind: "agent"`, so a method with
  `kinds: ["user"]` refuses it. Check a session token against the store on
  every call (`bearerAuth`), never with `verifyJWT` alone, which a
  signed-out session still passes. A custom tool obeys the app's
  `initQuickdraw({ kinds })` too, and takes `kinds` of its own within it
  (`FORBIDDEN` for another kind, before its arguments are read); a
  `"public"` tool takes none. Custom tools served beside the services of
  apps that admit no kind in common stop the registry at startup.
- To refuse a token, the `principal` hook throws
  `QuickdrawError("UNAUTHENTICATED")` (or `"FORBIDDEN"`): the call is
  answered `UNAUTHENTICATED` (401 over HTTP), logged at debug, as the
  caller's doing. Never put the token in the message. Anything else it
  throws, or a principal of the wrong shape, is the server's failure (its
  token store or database down), as it is from `authenticate`: the call is
  answered `INTERNAL` (500 over HTTP) and logged as an error, so an agent
  is never told that a token the hook could not check is refused. A hook
  that refuses with a plain `Error` therefore never tells the agent its
  token is bad: in development the registry warns once when its hook
  throws anything but a `QuickdrawError`
  (`[quickdraw:mcp-principal-threw]`), and lint's `no-plain-error-refusal`
  reports one thrown in a hook written where the registry is made.
  `bearerAuth` refuses with a `QuickdrawError`.

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
  `count_tasks` takes no arguments. An object schema with `.meta({ id })`,
  which JSON Schema writes as a `$ref`, counts as the object it names; a
  schema made from it (`.optional()`, `.refine()`, `.default()` and the
  like) is not an object input. Every call of such a tool gets the binder's
  value before its input is validated, through `tools/call` and both shapes
  of `POST /mcp/invoke` alike, and a call of any other method's tool that
  sends a bound argument is `FORBIDDEN`. Only top-level arguments are
  bound.
- A call fails closed, before the method runs: `UNAUTHENTICATED` for an
  anonymous caller, and `FORBIDDEN` when the binder returns `undefined` or
  `null`, or when the agent sent the argument with another value. A binder
  that throws fails the call with `INTERNAL`, or with the code of the
  `QuickdrawError` it threw.
- `createMcpRegistry` throws at startup when a bound argument is in no
  selected method's object input (a misspelled name would leave the real
  argument to the agent), and when an input may hold it anywhere it cannot
  be filled (an input that is not an object, or a branch of a union or an
  intersection, behind a `$ref` too), which it names: leave that method
  out, or make its input an object.
- Custom tools are never bound, and neither are the calls their `caller`
  makes: a custom tool reads `principal` itself. `describeTools` and the API
  docs list the inputs as the contracts declare them, with nothing bound.
- Binding is not access control. The same principal reaches the method over a
  socket or HTTP with nothing bound, so the method's access must still
  confine it to its project.

An app that signs the caller in itself, such as its own MCP transport over
`callMethod` or an in-process assistant, passes the caller as `principal`
in the call's options, and the registry's `principal` hook is not asked:

<!-- example: apps/api/src/mcp.ts#signed-in -->

```ts
import { requireSession, sessionOf } from "@fitzzero/quickdraw-core/server/auth";
import { toToolResult } from "@fitzzero/quickdraw-core/server/mcp";

// the app's own MCP route: its sessions sign the caller in, as an agent of their user
const signedIn = requireSession(
  { sessions, jwtSecret },
  { loadPrincipal: (userId): AppPrincipal => ({ userId, kind: "agent" }) },
);

app.post("/assistant/:service/:method", signedIn, (req, res) => {
  void (async () => {
    const result = await registry.callMethod(req.params.service, req.params.method, req.body, {
      // no bearer token: the call's queries share its user's lane
      request: {
        transport: "http",
        sessionId: crypto.randomUUID(),
        token: null,
        headers: req.headers,
        req,
      },
      // the registry's principal hook is not asked; the user's grants load as qd.caller's do
      principal: sessionOf<AppPrincipal>(req).principal,
    });
    res.json(toToolResult(result));
  })();
});
```

- `principal: null` calls anonymously; without the key, the hook says who
  calls, as before. `registry.call` takes it as `callMethod` does. The
  `context` hook, bound arguments and the call's concurrency lane see the
  given principal, and `request` is still needed: the lane and `context`
  read it.
- A principal that carries no `serviceAccess` gets the grants the server's
  `auth.loadServiceAccess` loads, at each call, as `qd.caller` gives them;
  one that carries grants (`{}` included) keeps exactly those. The `principal`
  hook's principal is used as the hook returns it.
- It is an in-process option: `POST /mcp/invoke` never reads a principal
  from its body.

Two more needs are met by the options above, with nothing added:

- **A tool set per kind of caller.** Make one registry per kind, each with its
  own `include`, `bind` and `principal`, and serve each at its own `path` or
  from its own stdio entry, as above. A registry's `principal` hook refuses
  the other kinds: throwing `QuickdrawError("UNAUTHENTICATED")` fails their
  calls with `UNAUTHENTICATED` and logs at debug; never put a token in the
  message.
- **Frozen public tools.** `name` gives a method's tool any public name, as
  `create_task` above. When agents depend on tool names and argument shapes
  that must never change, give that surface a contract of its own: its
  methods' inputs and `describe` texts are the frozen shapes, its handlers
  call the app's services through `ctx.services`, and a registry with
  `name: (_service, method) => method` serves it. Those calls carry the
  tool call's `ctx.mcp`, so a guard that reads it in a method they reach
  holds as it does on that method's own tool. The bridge never reshapes a
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
- Every call, a hook's, `qd.<service>.<method>.call()` or `call`, reads and
  writes alike, is bound as it is made to the user it is made as, and goes
  out only on a socket whose own hello names that user. A socket speaks
  for whoever its credentials named when it connected, which a session
  cookie can change unseen (another tab signs someone else in), and only
  its hello says whom. So from the first connect, or a drop, until the
  socket's hello, quickdraw holds calls itself, never in Socket.IO's send
  buffer, and the hello sends them, in the order they were made, or fails
  `CANCELLED` each one made as someone else. `setAuth`, `close` and a
  refused session fail the calls held `CANCELLED`; one whose time runs out
  first fails `INTERNAL` ("Not sent: the connection to the server is
  down"). A channel message (`useChannel`'s `send`) sent before that hello
  is dropped, as input the next one supersedes, and `isReady` reads false
  meanwhile, though a drop keeps the last hello. The reads that resume live
  rows and collections still go at the connect: their answers follow the
  hello, and a hello naming another user drops them.
- A mutation hook's call is bound, as it is made, to the user it is made as
  and to the credentials it is made under, and each attempt is checked
  before it goes out: one whose user changed first (`setAuth` in the same
  handler, an async `onMutate`, a pause while offline, a `scope` queue, a
  retry, a cookie that names someone else after a reconnect) fails
  `CANCELLED`, is not sent as the next user, and is not retried. An attempt
  that starts while new credentials await their hello is refused the same
  way, even for the same user's refreshed token (it is not held until the
  hello); one that starts once that hello names the call's user is sent. A
  call made after the server ended the session is sent only if the next
  hello comes under the same credentials (a cookie that signs in again)
  and names that session's user; new credentials (`setAuth`) refuse it,
  even for that user. A first connect the server refuses ends a session
  no hello named: whoever signs in next under the same credentials claims
  a call made after it. A refused item's `retry()` sends again as the user
  who made the call, and when this check stops it the item shows in
  `refused` again, with the `CANCELLED`.
- A mutation hook shows a call (its `data`, `error`, `variables` and
  status) only to the user it is made as, while the server's hello names
  them. A component that stays mounted while the user changes shows the
  next user none of the last user's calls, finished or in flight, and none
  while new credentials await their hello; the same user's shows again
  once their hello arrives, and stays through a reconnect. `throwOnError`
  throws only such an error. The call still settles, and its callbacks
  still run, for the user who made it. A call made while no hello is held
  (before the first, while new credentials await theirs, after the server
  ended the session) becomes the call of the user the next hello under the
  same credentials names, even once it settled (after a session the server
  ended, only if it names that session's user again, and after a refused
  first connect, whoever signs in). It shows, pending
  and then its answer or error, while no hello is held under the same
  credentials, and once one is, only to that user: one the hello did not
  make anyone's (another user's cookie after the session ended) shows to
  nobody. New credentials hide it. A
  call that itself switches the user (an anonymous sign-in or sign-up,
  then `setAuth`) hides its result once the new hello arrives: act on it
  in `onSuccess`.
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
  quickdraw cached, and no `useQuery` of the client shows a placeholder made
  from it (`placeholderData` such as `keepPreviousData`), nor `useSearch` its
  last results; new credentials for the same user refetch it; new grants
  (`qd:access`) refetch every query. Live entries never take a placeholder,
  whatever `placeholderData` default the `QueryClient` sets: `useEntity`,
  `useCollection` and a search's held scope show nothing of another row,
  scope or user while a new id, scope or user loads. A mounted mutation
  hook shows the next user none of the last user's calls, and no call or
  channel message is sent as the next user (above).
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
page stay meanwhile. When the server ends the session (signed out on
another device, revoked, expired) or refuses a connect for it (its
`authenticate` refused the credentials, or the handshake was
`FORBIDDEN`), the hello is forgotten: `isKnown` is false, `status` is
`"disconnected"` or `"refused"`, and everything quickdraw cached is gone,
so a gate that finds the connection stopped with nobody known shows the
sign-in. A server that could not check the credentials (its session store
down: the handshake is refused `INTERNAL`) signs nobody out: the
connection keeps the hello and the cache, stays `"connecting"`
(`reconnecting` after a connect on these credentials) and connects again
by itself after Socket.IO's reconnection delays, so the gate below shows
the page with "Reconnecting…", or "Connecting…" before a first connect.
Another protocol (`refusal.code` `"PROTOCOL_MISMATCH"`) keeps the hello;
the provider reloads the page once for it:

<!-- example: apps/web/src/components/AuthGate.tsx#gate -->

```tsx
export function AuthGate({ children }: { readonly children: ReactNode }) {
  // isKnown: the server's hello named the user, so userId is final (null: signed out)
  const { status, isKnown, userId, reconnecting } = useQuickdraw();
  if (!isKnown) {
    // stopped with nobody known: the server ended or refused the session (signed out elsewhere,
    // revoked, expired), and what quickdraw cached is gone
    return status === "disconnected" || status === "refused" ? <SignIn /> : <p>Connecting…</p>;
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

A script, a CLI or a worker uses the connection directly, from
`@fitzzero/quickdraw-core/client/core`: the client without React, for a
process that installs neither React nor TanStack Query. It holds the
connection, `call` and `callData`, `newId`, the auth helpers, peer links,
host mode and everything on `./utils`. Nothing it imports, in its code or
its types, is React or TanStack, and it carries no `"use client"`.
`./client` re-exports all of it, the same functions:

<!-- example: apps/api/scripts/report.ts#script -->

```ts
import { callData, createQuickdrawConnection } from "@fitzzero/quickdraw-core/client/core";

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

Live rows and collections take a TanStack `QueryClient`, so they are on
`./client` only, still without React: `liveDataOf(connection, queryClient)`
holds them for code without hooks (a React Native module, a Node client
that keeps a `QueryClient`), and `createInvalidationCoordinator(queryClient)`
invalidates as the hooks do.

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
        // all or nothing: Admin on every id, as delete needs
        bulkDelete: { entry: "Admin", id: "ids" },
      },
      // what `create` writes: columns from the principal, the next ordinal
      prepare: async (input, ctx, db) => ({
        ...input,
        assigneeId: ctx.principal.userId,
        ordinal: await nextOrdinal(db, "task", { projectId: input.projectId }),
      }),
    }),
    archive: {
      access: { entry: "Moderate" },
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
  `update: "authenticated"` edits no row. `create` makes a new row and
  checks no row of its own: it needs that row level on each parent its new
  row names (each anchor column it writes, below), whatever its form, so
  `create: "authenticated"` writes into no project its caller cannot
  moderate; give it `{ scope: "Moderate", of: project, id: "projectId" }`.
  `list`, `getMany`, `bulkUpdate`
  and `bulkDelete` act on many rows, so they also keep only the rows the
  service's policy gives the caller at the form's `entry` or `scope` level
  (else `Read` for reads and `Moderate` for writes; a bulk method's form
  that names none takes `update`'s or `delete`'s row level when it is
  higher): a list never shows a row `get` would refuse, and a bulk delete
  never deletes a row `delete`'s `{ entry: L }` would refuse. When the
  single-row form names no row level (`{ service: L }`, `custom`), give the
  bulk method the same form. A service-wide `Admin` grant reaches every row,
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
  total only when asked (a second statement). A sort value too long for a
  cursor (4,096 characters) makes the cursor name its row instead: the next
  page reads that row first, and the cursor is `VALIDATION` once the row has
  left the list (or for a caller whose list never held it). Such a cursor
  follows its row: a change to that row's sort value between pages can skip
  or repeat rows. Items are the `item`
  projection, stripped of fields above the level the page was read at, as
  collection items are.
- `getMany({ ids })` (at most 200) leaves out ids the caller cannot read and
  ids with no row. Bulk writes skip rows the caller cannot write, run in one
  transaction and return `{ count }`; give one `{ entry: L, id: "ids" }` to
  refuse the whole call instead of skipping rows (an empty `ids`, or an id
  with no row, is then `FORBIDDEN`).
- Writes go through the tracked client: `create` sends `added`, `update` a
  patch and `delete` `removed`, and a bulk write past a scope's
  `bulkThreshold` sends it one `reset`. A missing row is `NOT_FOUND`, a
  unique violation `CONFLICT`.
- Without a service-wide `Admin` grant, `update` and `bulkUpdate` (and the
  admin kit's writes) never set a column the policy reads (an owner column,
  an access list), even one an anchored collection also scopes by. They
  never set a membership table's entry, user or role column that any policy
  reads either: change memberships with the sharing kit. They move a row
  into another parent (an `inherit` policy's `via`, an anchored
  collection's scope column) only when the caller's level on the new parent
  meets the method's row level. Each refusal is `FORBIDDEN`. An `inherit`
  `via` column stays movable, so never inherit a row's access from the
  users' own rows (`inherit({ from: user, via: "ownerId" })`): a caller
  would hand the row to themself.
- `create` takes a column the policy reads, and a membership column, only
  from `prepare` (`ownerId: ctx.principal.userId`), never from a caller
  without a service-wide `Admin` grant. It writes a parent only where the
  caller has the row level on it, after `prepare` ran.
- Every kit write holds column values only, in every environment and for
  every caller, a service-wide Admin included: a key that is a relation of
  the model (one a projection selects with a nested `select`) or a value
  that is a Prisma nested write (`{ connect }`, `{ update }`, a to-many
  `{ set: [...] }`) is `VALIDATION`, since nested writes are not tracked
  and would skip the checks above. A `prepare` that returns one is
  `INTERNAL`. A Json value whose own key is a relation operation holding an
  object or list, or `delete`/`disconnect` set to `true`, is refused too;
  keep such data one level deeper. Any `{ set: [...] }` is refused, a scalar
  list's included: write a scalar list as the list itself.
- `reorder({ id, beforeId?, afterId? })` puts the row between its new
  neighbors (`beforeId` comes right before it) with one write, or renumbers
  the `within` list in steps of 1,024 when no gap is left, in a transaction
  given 5 s plus 10 ms per row of the list. The neighbors it names need the
  method's row level, as the moved row does (a neighbor below it is
  `NOT_FOUND`, as a missing one is), and the list is the rows sharing the
  `within` values that the caller may write: a list with no `within` or a
  null one is each caller's own. The rows it names are read through that
  same filter, so a policy whose filter matches no row (a `resolver` without
  `where`) moves nothing below a service-wide grant, as its lists show
  nothing. Moves run SERIALIZABLE: two at
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
  const queryClient = useQueryClient();
  const filter = { projectId };
  // the list's own key (plus a suffix: pages are not one list result) and call,
  // so qd.invalidate(qd.task.list) refetches these pages too
  const pages = useInfiniteQuery({
    queryKey: [...qd.task.list.key({ filter }), "pages"],
    queryFn: ({ pageParam, signal }) =>
      qd.task.list.call({ filter, cursor: pageParam, limit: 50 }, { signal }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // the last project's pages stay shown while the next one's load, but never another user's:
    // placeholderFromSession, called on every render, drops what a switch of users left
    placeholderData: placeholderFromSession(queryClient, keepPreviousData),
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

A mounted TanStack hook keeps the last query that held data and makes its
placeholder from it, and after a switch of users that query is the last
user's: a member's `useQuery` and `useSearch` drop it themselves, and a hook
of the app's own does so when its `placeholderData` goes through
`placeholderFromSession(queryClient, placeholderData)` from `./client`,
called on every render (TanStack reuses a placeholder without asking while
the option is the same function), as above. Until the hello on new
credentials arrives, the cache also still holds the last user's results,
which a member's hooks hide and a hook of the app's own does not: render it
only while `isKnown`, as `AuthGate` above does.

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
  most 100, with keyset cursors as for `list`. There is no ranking: a call
  with `scope` comes in the scope collection's order, one without by id.
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
    // each user's projects: an invite adds the project; a remove, a leave or a role below Read takes it out
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
      // the one user a by-name call means, or null (NOT_FOUND): an email is unique
      // (and wins when both are given), a display name counts only when exactly
      // one user has it
      resolveUser: async ({ name, email }) => {
        if (email !== undefined) {
          return (await db.user.findUnique({ where: { email }, select: { id: true } }))?.id;
        }
        if (name === undefined) {
          return null;
        }
        const named = await db.user.findMany({ where: { name }, select: { id: true }, take: 2 });
        return named.length === 1 ? named[0]?.id : null;
      },
      // runs inside the change's transaction: its writes commit with it, a throw undoes it
      onChange: async (change, ctx) => {
        ctx.log.info("sharing changed", { kind: change.kind, id: change.id, user: change.userId });
        // the flush revokes their subscriptions, but rooms are the app's: a user whose entry or
        // membership is gone leaves the project's board on every node (removeFromBoard, rooms.ts)
        if (change.after === null) {
          await removeFromBoard(change.id, change.userId);
        }
      },
    }),
  },
});
```

- Access list methods: `share({ id, userId, level })` gives a user `Read`,
  `Moderate` or `Admin` (replacing a level they had, unless it is above the
  caller's), `setLevel` changes the level of a user the row is shared
  with, `unshare({ id, userId })`
  takes it away, and `listShares({ id })` lists the row's shares; each
  returns the list as `[{ userId, level }]`, one entry per user. Membership
  methods: `invite({ entryId, userId, role? })` and
  `setRole({ entryId, userId, role })` return the member as
  `{ userId, role, level }`, `remove({ entryId, userId })` and
  `leave({ entryId })` return `null`, and
  `listMembers({ entryId, cursor?, limit? })` pages the members in user id
  order (50 by default, at most 200). `shareByName` and `inviteByName` take
  `name` or `email` instead of `userId`, and need `resolveUser`, which
  returns exactly one user's id or `null` (`NOT_FOUND`): an email by
  `findUnique`, a name only when exactly one user has it, as above, never
  the first of several (a `findFirst` by name shares with whoever
  registered that name first); a mode adds every method but those two
  unless `methods` names its own list.
- Who may call: a change needs `{ entry: "Admin" }` on the row, a list
  `{ entry: "Read" }`, and `leave` a signed-in member (`FORBIDDEN` for
  anyone else). `access: { share: { entry: "Moderate" } }` replaces one
  method's form. Whatever the form, no caller shares, sets or invites at a
  level above their own on the row, nor changes or removes a user whose
  current level there is above their own (`FORBIDDEN`; a service-wide
  grant counts where the form names `service`; equal levels may, so one
  Admin changes another), and each change reads the caller's level again
  inside its transaction, refusing one lowered by a concurrent change
  (`FORBIDDEN`).
- The kit changes the list or the table the service's policy reads, alone
  or inside `anyOf`, and takes their names from it: a service whose policy
  has none for a mode the contract uses (or two) fails when it is defined.
  Roles are the policy's `levels` keys, or the level names `Read`,
  `Moderate` and `Admin` without it; another role is `VALIDATION`, and
  `invite` without a role gives the lowest one that can read the row.
  Roles that map to one level are peers: with
  `{ owner: "Admin", admin: "Admin" }` an `admin` may demote or remove the
  `owner`, so protect an owner with an owner column
  (`anyOf(owner("ownerId"), members(...))`).
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
- App rooms are not subscriptions: a user who loses access stays in the
  rooms a method joined them to until the app takes them out. The example's
  `onChange` does that when the change leaves the user with no entry or
  role (`change.after === null`): `removeFromBoard` takes their sockets out
  of the project's board on every node. With custom `members` `levels`, a
  role below the join's level must take the user out too. Under `anyOf` a user who still has
  the other list is taken out too, and joins again on their next connection
  (`useJoin`). `onChange` runs inside the change's transaction, before it
  commits: a join that runs before the commit (a check that still sees the
  old list) puts the user back until they disconnect, and a change whose
  commit fails has still taken them out until their next connection.

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
    // the kit's reads are queries, not live data: after this screen's own write,
    // read the page again and put the row the write returned in adminGet's cache
    onSuccess: (row) => {
      qd.invalidate(qd.task.admin.adminList);
      qd.task.admin.adminGet.setData({ id: row.id }, row);
    },
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
  itself, and a value the database refuses is `VALIDATION`. A relation of
  the model (a key a projection selects with a nested `select`) or a nested
  write (`{ connect }`, `{ update }`) is `VALIDATION`, for every caller: the
  kit writes column values only. A missing row is `NOT_FOUND`.
- `editable: ["title", "status"]` names the only fields `adminCreate` and
  `adminUpdate` write: `adminMeta` reports every other field
  `editable: false`, so a generic form leaves it read-only, and a write
  naming one is `VALIDATION` ("is not editable"). Each must be a field the
  kit shows, never `id` or a timestamp, and a `fieldOverrides` entry may
  not say otherwise. `admin.contract({ entity, editable })` takes the same
  list, so the writes' input checks, types and JSON Schema (and the MCP
  tools made from it) name only those fields; given to both halves, the
  two lists must name the same fields. Without either list the kit writes
  what it wrote in 5.0.0: every field it shows but `id`, the timestamps and
  the model's relations, less those an override made read-only. An `editable` list, or a
  `fieldOverrides` entry with `editable: true`, that names a relation of the
  model fails when the service is defined.
- `adminMeta()` returns `{ serviceName, displayName, fields }`, one
  `{ name, type, label, required, editable, showInTable, sortable, filterable, enumValues?, relationService?, kind?, showInForm? }`
  per field: `type` is
  `string`, `number`, `boolean`, `date` (an ISO string with a date format),
  `enum` or `json` from the field's JSON Schema, and `relation` by override;
  `sortable` and `filterable` are the declared fields (`filterable` is
  optional in the `AdminFieldConfig` type, default `false`, so field
  configurations written for 4.x still type); `id` and the
  timestamps come first and are not editable; a relation of the model (a
  field a projection selects with a nested `select`) is `editable: false`;
  `acl`, `serviceAccess` and `service_access` are hidden, and so is the
  column `auth.serviceAccessSource` (a bare dispatcher's
  `serviceAccessSource`) names on this service's model, whatever its name.
- Grants: on a users service, `admin.handlers(user, { grants: true })`
  shows and writes the entity's grants field (`serviceAccess`, or the
  column `auth.serviceAccessSource` names, whatever its name and type; the
  entity schema checks what is written), so the admin screen edits grants
  through `adminUpdate`. Options that clash with that column (hiding it
  beside `grants: true`, or naming it in `editable`, `fieldOverrides`, a
  filter or a sort without), and `grants: true` on an entity with no grants
  field, fail when the server is made.
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
  every field. Its statements get the development checks a handler's get
  (a loop of writes in it is an `n-plus-one`), as `prepare`'s do.
  `onCommitted({ method, id, before?, after }, ctx)` runs once
  the write has committed (after `onWrite`'s transaction), in a detached
  unit of work of its own: the reply does not wait for it, its writes flush
  on their own, and a throw is logged, the write standing. Apply an edit to
  what runs in memory (a game's simulation) there, so an edit that rolled
  back is never applied. Without a hook (these two or `prepare`, below) the
  kit opens no transaction. Each handler `admin.handlers` returns resolves
  with its method's output type (`AdminOutputOf<C, M>`), so a wrapper reads
  the row and returns it with no cast.
- `admin.handlers(contract, { prepare })` runs `prepare(call, ctx, db)`
  before each `adminCreate`, `adminUpdate` and `adminDelete`, once the
  caller's access and data were checked, in one transaction with the write
  and `onWrite` (`db` is the transaction's tracked client; a throw undoes
  its writes and the write, and fails the call). `call` is
  `{ method: "adminCreate", data }`, `{ method: "adminUpdate", id, data, before }`
  or `{ method: "adminDelete", id, before }`: `data` is the caller's, and
  `before` the row, every field, as `onWrite` hears it. Before a create or
  an update it may return column values, written over the caller's data:
  a column the server computes (a hash, a slug, the next ordinal), even one
  the caller may not write (hidden, not editable, above their level), but
  never `id`, a timestamp, a relation or a nested write (`VALIDATION`). An
  anchor column it sets (a parent's id, an anchored collection's scope)
  needs the method's row level on the row it names, as the caller's data
  and the read/write kit's `prepare` do (`FORBIDDEN`), so a lowered form
  never moves a row into a parent its caller cannot reach. Returning
  nothing, or `undefined` for a key, keeps the caller's data, and what it
  returns before a delete is ignored. The tracked client never sees
  what the database deletes or clears with a row (`onDelete: Cascade`,
  `SetNull`), so those rows stay in the lists and entities open on them;
  delete or clear them through `db` in `prepare`, and their subscribers are
  told. `prepare` shares the write's transaction, and so its time limit,
  Prisma's 5 seconds by default: for a large cascade, such as a user's
  delete clearing their rows in every service, give that transaction
  another with `admin.handlers(contract, { transaction: { timeoutMs: 30_000 } })`
  (`maxWaitMs`, how long it may wait to start, is Prisma's 2 seconds by
  default; a client's `transactionOptions` changes both for every
  transaction). A write that runs past it is undone and fails `INTERNAL`.
  The limits are positive numbers of milliseconds, and `transaction` is
  refused without a hook, which opens no transaction:

<!-- example: apps/api/src/services/kits/admin.ts#prepare -->

```ts
import type { TrackedTransaction } from "@fitzzero/quickdraw-core/prisma";
import { nextOrdinal } from "@fitzzero/quickdraw-core/server";
import type { PrismaClient } from "@project/db";

export const taskAdmin = admin.handlers(task, {
  editable: ["projectId", "title", "status"],
  // runs before each write, in its transaction: `db` is that transaction's tracked client
  prepare: async (call, _ctx, db: TrackedTransaction<PrismaClient>) => {
    if (call.method === "adminCreate" && call.data.projectId !== undefined) {
      // written over the caller's data, a read-only column too: the new task goes last
      return { ordinal: await nextOrdinal(db, "task", { projectId: call.data.projectId }) };
    }
    if (call.method === "adminDelete") {
      // the database deletes the task's label links and clears its subtasks' parent,
      // unseen: do both here, tracked, so the rows and lists open on them are told
      await db.taskLabel.deleteMany({ where: { taskId: call.id } });
      await db.task.updateMany({ where: { parentTaskId: call.id }, data: { parentTaskId: null } });
    }
    return undefined;
  },
});
```

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
  watch nothing, so after its own write a screen reads the page again and
  puts the row the write returned in `adminGet`'s cache with `setData` (the
  `onSuccess` above), and sees other admins' writes when it next reads.
  Their `useQuery`, and `adminSubscribers`', defaults to `staleTime: 0`, so a
  screen reads them again whenever it mounts (pass `staleTime` to keep a
  result longer; `adminMeta` keeps the provider's five minutes).
- A screen that serves every service from its metadata (the route names the
  service) takes `adminOf(qd, key)`: the same members, keyed by what the kit
  made them for and typed by field name (`AdminScreen`: rows are
  `AdminRow`, `adminList` takes `{ page, pageSize, filter, sort: { field, direction } }`
  with names read from `adminMeta`), so no cast is needed over a union of
  keys; a method the contract does not expose is absent. Its query members
  have `setData` too: `admin.adminGet?.setData({ id: row.id }, row)` shows
  the row `adminUpdate` or `adminCreate` returned, with no read.

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
    // relay each cursor to the board's room, the one its requires matched (ctx.room)
    cursor: (payload, ctx) => {
      ctx.rooms.emit(ctx.room, task, "cursorMoved", payload);
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

// a job skips the work nobody watches: the feed's subscribers on every node
export async function tailLogs(taskId: string, read: () => Promise<string[]>): Promise<void> {
  if ((await qd.stream(task, "logs").subscribers(taskId)) > 0) {
    const lines = await read();
    qd.stream(task, "logs").pushMany(
      taskId,
      lines.map((line) => ({ line })),
    );
  }
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
  feed's subscribers. A `volatile` stream drops an item for a socket only
  while its connection is backed up (64 relay messages and volatile frames
  sent to it waiting), never because another frame went to it in the same
  tick: more than 64 items to one socket in one tick drop the rest, so push
  a snapshot instead of a burst that big. Behind a cluster adapter its
  items go to every node, as a seeded stream's do, and each node checks its
  own sockets (docs/deploying.md). `pushMany(scope, items)`
  (`pushMany(items)` for a global stream) pushes several items to one feed
  at once: every item is checked before any is kept or sent, and each goes
  out as its own frame, in order; use it rather than `push` in a loop
  (`no-emit-in-loop`). `qd:stream:sub` is authorized with the
  stream's `access` through the access engine, the scope being the row an
  `entry` or `scope` form checks; `access: { room }` opens it to the
  sockets in an app room instead, signed in or not, and a socket that
  leaves the room, or is taken out, leaves the feed; a stream without
  `access` is closed. A global stream names the room, or `{ prefix }` for
  any room whose name starts with it; a scoped stream computes it from the
  scope, ``(worldId) => `world:${worldId}` ``, because a name or a prefix
  would let a socket in that room read every scope (`defineContract`
  refuses both on a scoped stream, by type and when it runs). The answer is the seed; `useStream` then appends, keeps the
  latest `max` (default 500), and subscribes again after a reconnect, when
  the seed replaces what it held. A subscribe an access change overlapped
  is authorized again before it joins the feed, with the socket's
  principal as it is then, and answered `FORBIDDEN` when it lost access;
  nothing pushed meanwhile reaches it as a frame, and its seed is read as
  it joins. A subscribe an unsubscribe overtook answers `seed: []`. A
  socket holds at most 500 feeds. A
  subscriber whose access is lowered is authorized again; one refused
  leaves the feed and gets
  `qd:revoked { kind: "stream", reason: "access", s, stream, scope? }`, and
  `useStream` shows `FORBIDDEN` until the next connect.
- A job skips the work nobody watches (`tailLogs` above):
  `await qd.stream(task, "logs").subscribers(taskId)` (`subscribers()` for
  a global stream; also on `server.stream` and `dispatcher.stream`) is how
  many sockets subscribe to the feed, on every node, anonymous ones
  included: the sockets a push reaches. Behind a cluster adapter the other
  nodes answer one request with a count each, never their sockets; a node
  that does not answer in time counts as 0 while the others' answers count
  (warned at most once every 10 minutes), and so does a node of an earlier
  version. "In time" is the adapter's own `requestsTimeout`, which
  `setupRedisAdapter` sets to `cluster.timeoutMs`, or `cluster.timeoutMs`
  for an adapter without one (docs/deploying.md). `qd.rooms` refuses the
  stream rooms' reserved `qd:` names, and Socket.IO's own rooms hold one
  node's sockets: count with `subscribers`.
  A host-served stream's handle refuses it, as it refuses `push`: only the
  host's client knows who subscribes.
- A service's `streams: { <name>: { seed, validate } }` (type
  `StreamImplementation`) computes a stream's seed per subscriber, `seed: (scope, ctx) => items` (the current state,
  where the items that follow are deltas; on whichever node the subscriber
  is on, under its principal, in the tick it joins the feed; a contract
  `seed: n` and a seed function cannot both be declared), and
  `validate: "development"` checks pushed items only while the dispatcher
  checks outputs (`outputValidation`, off in production), for a hot stream:
  unchecked, an item goes out as pushed, extra keys included.
- Channels: each message is `qd:ch [service, channel, payload]`, never
  answered. The client drops one rather than queue it while its connection
  is backed up (64 packets, or more than 32 KiB, waiting to be sent), never
  because another went out in the same tick, so a burst of input all
  arrives. Per socket and channel a token bucket
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
  A channel without `requires` takes a message from every signed-in socket,
  about any row or room its payload names: a handler that relays it to a
  room (``ctx.rooms.emit(`project:${payload.projectId}`, ...)``) lets any
  user reach that room. The server warns `channel-without-requires` for
  each such channel when it starts (a strict test app does not start). Give
  the channel a `requires` and relay to `ctx.room`, the room it matched; or,
  when any signed-in user may send it, say so on the service, `channels: {
ping: { access: "authenticated", handler } }`, which delivers as before
  and silences the warning.
- Presence: `isOnline` and `lastSeen` (now while online, else when the
  user's last socket on this process disconnected) come from this process's
  sockets, whatever rooms they are in; `count` and `users` (each user once,
  anonymous sockets left out; app rooms only) come from this process's
  records of the rooms `ctx.rooms.join` joined (a socket a raw
  `socket.join` put in a room is not counted). Behind a Redis adapter each
  also asks the other nodes, which answer from the same records with user
  ids alone (or whether they hold a socket of the user); concurrent reads
  of one room or user share one request.
  `ctx.rooms.join(room)` and `leave` put the calling socket in an app room
  (calls without a socket get `false`; names starting with `qd:` or `user:`
  are refused with `VALIDATION`, and so are names with the shape of a
  Socket.IO socket id, 20 letters, digits, `_` or `-`, because every socket
  is alone in the room of its id: give such an id a prefix, `doc:${id}`; at
  most 100 per socket; a method that shares its runs, `share`, may not join
  or leave with its caller's socket: `INTERNAL`), and the room's sockets get
  `qd:presence` frames: the list on joining, then who joins and who leaves.
  `usePresence(room)` shows them. `rooms.size`, `rooms.leave` and presence
  refuse the same names.
- Events: `ctx.rooms.emit(room, contract, event, payload)` and
  `emitToUser(userId, ...)` check the payload first (`INTERNAL`, nothing
  sent, when it fails), then send the validated payload as
  `qd:event [service, event, payload]`; `useEvent` hears them. `emit`
  refuses the framework's rooms (`qd:`, `user:`) with `VALIDATION`: a
  user's sockets are reached with `emitToUser`.
- Rooms belong to a socket: a reconnect (a lost network, `qd:rotate`, new
  credentials) is a new socket in no room, which hears none of its events
  and whose channel messages requiring it are dropped. `useJoin(member,
input, { enabled?, onJoined? })` (from `./client`) runs the joining call
  (`enterBoard` above) on every `qd:hello` and when its input changes by
  value, never on a re-render, and shows `status` (`idle` with no socket to
  join with, `joining`, `joined`, `error`), `isJoined`, `data` (what the
  last join returned, to the user it ran as and for the input it ran with
  only: hidden while new credentials await their hello, never the next
  user's, and never another input's, so a new input shows `joining` with
  no `data` from its first render until its own answer) and `error`;
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

// a member removed from the project (the sharing kit's onChange calls it): their sockets leave
// its board on every node, so they hear nothing more of it and its cursor channel drops their
// messages (also ctx.rooms.leave)
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

### Peer links

Two players of one app room can link their clients: WebRTC data channels
between them, or the server's relay when those cannot form (a browser
behind a symmetric NAT, Node, a headless game client), with the same
messages either way (design: section 12.5). A server opts in with
`createServer({ peers: true })`: it forwards the signals that set a link
up and relays its messages, only between two signed-in sockets of the
room, and never reads what a link carries. A link has two channels: `rel`,
ordered and reliable (state, chat), and `fast`, unordered and never resent
(input, positions). The app tells players each other's socket ids, here
with an event:

<!-- example: apps/api/src/services/kits/peers.ts#service -->

```ts
// on a server created with peers: true, which forwards the links' signals and relays their messages
export const matchService = qd.defineService(match, {
  methods: {
    enterMatch: {
      // any signed-in user here: a real game checks the caller's seat in the match first
      access: "authenticated",
      handler: ({ input, ctx }) => {
        const room = `match:${input.matchId}`;
        const joined = ctx.rooms.join(room);
        if (joined && ctx.socketId !== undefined) {
          // the socket's own id, which a peer links to
          ctx.rooms.emit(room, match, "playerJoined", {
            matchId: input.matchId,
            userId: ctx.principal.userId,
            socketId: ctx.socketId,
          });
        }
        return joined;
      },
    },
  },
});
```

<!-- example: apps/web/src/components/kits/MatchLinks.tsx#hook -->

```tsx
function track(links: Map<string, PeerLink>, link: PeerLink, onMove: { current: OnMove }): void {
  links.set(link.peer, link);
  link.on("message", (data) => {
    // a peer's message is its word, never checked by the server: parse it as any input
    const move = moveSchema.safeParse(data);
    // userId: the peer's user, as the server named it (known once the link is open)
    if (move.success && link.userId !== undefined) {
      onMove.current(link.userId, move.data);
    }
  });
  link.on("close", () => links.delete(link.peer));
}

// each player of a match linked to every other: send a move to all of them, hear theirs
export function useMatchLinks(matchId: string, onMove: OnMove): (move: Move) => void {
  const { connection } = useQuickdraw();
  const room = `match:${matchId}`;
  const [links] = useState(() => new Map<string, PeerLink>());
  const heard = useRef(onMove);
  useEffect(() => {
    heard.current = onMove;
  });
  // on every connection: a link lives as long as its socket, and a reconnect is a new socket
  useJoin(qd.match.enterMatch, { matchId });
  // a player who joins later: this side offers (when both offer, the link settles who answers)
  qd.match.playerJoined.useEvent((player) => {
    const self = connection.socket.id;
    if (player.matchId === matchId && player.socketId !== self && !links.has(player.socketId)) {
      track(links, createPeerLink(connection, { room, to: player.socketId, offerer: true }), heard);
    }
  });
  // the players here before: they offer, this side answers
  useEffect(
    () =>
      onPeerRequest(connection, (request) => {
        if (request.room === room) {
          track(links, request.accept(), heard);
        }
      }),
    [connection, room, links],
  );
  useEffect(
    () => () => {
      for (const link of links.values()) {
        link.close();
      }
    },
    [connection, room, links],
  );
  // direct when WebRTC connects, the server's relay when it cannot; fast: unordered, never resent
  return (move) => {
    for (const link of links.values()) {
      link.send("fast", move);
    }
  };
}
```

- `createPeerLink(connection, { room, to, offerer })` (from `./client`, or
  `./client/core` without React) opens a link to socket `to` in app room `room`. One side
  offers; when both do (each heard of the other at once), the side whose
  socket id sorts after the other's answers instead.
  `onPeerRequest(connection, listener)` hears a socket of the room that
  signals this one with no link yet (`{ room, from, userId }`):
  `request.accept(options?)` answers with a link, `request.reject()`
  refuses it, and a request nobody answers is dropped after 15 s.
- A link has `state` (`connecting`, `open`, `closed`), `path` (`direct` or
  `relay`), `peer` and `userId` (the peer's socket and user, as the server
  named them), `on("open" | "message" | "state" | "close", listener)` and
  `close()`, which tells the peer. `send(label, data)` takes any JSON value
  of at most 64 KiB as UTF-8 JSON (a `RangeError` above) and returns false
  when it dropped it: the link is not open, `fast` is backed up, or the
  relay's rate is spent (`stats` counts what was sent, received and
  dropped). `closeReason` says why it closed: `closed` (this side), `bye`
  (the peer closed it, or left the room, was taken out of it or
  disconnected: the server says so at once), `left` (this socket left the
  room), `disconnected` (a link lives as long as its socket: open it again
  after a reconnect), `timeout` (nothing opened within 15 s), `lost`
  (nothing heard for 8 s, or a `relay: "never"` link's direct path
  dropped), `failed`, `refused` (the server refused a
  signal) or `unsupported` (a server without `peers`).
- The direct path comes first, over the platform's `RTCPeerConnection`
  (`peerConnection` takes another, such as react-native-webrtc's;
  `iceServers` defaults to Google's and Cloudflare's public STUN servers,
  with no TURN). The relay takes over when ICE fails, when the direct path
  does not open within 5 s or drops after it opened (`rel` messages in
  flight on it may be lost: the link emits `state`, so the app can
  resync; when a data channel closes, the link first waits 2 s for the
  peer's bye, since a peer that closes its link closes its channels too),
  and at once on a side without WebRTC or with
  `relay: "always"`; `relay: "never"` closes the link instead. A link never
  moves back from the relay.
- `link.clock` reads the peer's clock from pings on `fast` (six quick ones
  as the link opens, then one every 500 ms): `now()` (the peer's clock, in
  its milliseconds), `offset`, `rtt`, `jitter` and `synced`.
- The server's limits: a socket signals at most 64 peers at once
  (`CONFLICT`) and 20 signals a second (a burst of 40; `RATE_LIMITED`).
  It relays only between two sockets that signalled each other, at most
  120 messages a second to each peer (a burst of 240) and 1 MiB a second
  in all (a burst of 2 MiB), and drops the rest silently; the client keeps
  under these itself, from the hello's `limits.peers`. A socket that keeps
  flooding either is disconnected, as for channels. A socket that leaves a
  room, is taken out of it or disconnects ends its links there: the server
  tells each peer it signalled, and each that signalled it. Behind a
  cluster adapter the node that holds a socket checks it, and the relay
  crosses nodes.
- What a peer sends is the peer's word: the server checks who may link,
  never what a link carries. Parse a link's messages as any input, and
  check on the server whatever a client reports there.
- Tests: `createLoopbackPeerLink({ ms, jitter, loss })` (from `./testing`)
  links two ends in one process, with a delay and jitter per message and
  loss on `fast` alone; its ends take `setLag` too.

A browser test, a bench or a host plays a link over a bad network on its
real path, direct or relay, with `setLag`:

<!-- example: apps/web/src/components/kits/MatchLinks.tsx#lag -->

```tsx
// a browser test or a bench plays the match over a bad network, on the links' real paths: each
// holds every message 150 ms plus up to 40 ms more, each way, and loses 5% of fast ones
export function playOverBadNetwork(links: readonly PeerLink[]): () => void {
  for (const link of links) {
    link.setLag({ ms: 150, jitter: 40, loss: 0.05 });
  }
  // rel messages are never lost and keep their order; clock.rtt now reads about 300 ms more
  return () => {
    for (const link of links) {
      // what the lag holds goes on the next task, in order
      link.setLag(null);
    }
  };
}
```

- `link.setLag({ ms, jitter, loss })` holds every message of the link,
  both ways, `ms` plus up to `jitter` milliseconds, and loses a `fast` one
  with probability `loss`, from 0 to 1: `stats.simulatedLoss` counts the
  app's, and `dropped` still counts only what the link dropped. `rel`
  messages are never lost and keep their order; a held one its path
  refuses as it comes due (the relay's rate spent) goes again a little
  later, and `send` on `rel` returns false meanwhile. `send` returns true
  for a message it holds, and `stats.sent` counts it once a path took it.
  The clock's pings and host mode's messages wait too, so `link.clock.rtt`
  reads the lagged round trip. A new lag leaves what is held on its time;
  `setLag(null)` (or all zeros) ends it, and what is held goes on the next
  task, in order. `link.lag` reads it, and `random` takes a seeded
  generator, so a run repeats. The server never sees the lag.

### Host mode

One player's client can run a room's authoritative simulation as the
room's host (design: section 12.5). A contract declares the channels and
streams the host serves (`serve: "host"`): a player's messages and feeds
of them go to the room's host over the player's link, and never reach the
server. The server only says who hosts: a method makes the calling socket
the room's host (`ctx.rooms.setHost(room)`), and each socket of the room
hears it (`qd:host`). Host mode runs over peer links, so the server needs
`peers: true` (`createServer` throws without it):

<!-- example: packages/shared/src/kits/host.ts#contract -->

```ts
export const arena = defineContract("arenaService", {
  describe: "Arenas whose simulation one player's client runs, as the arena's host.",
  methods: {
    enterArena: mutation({
      input: z.object({ arenaId: z.string() }),
      output: z.boolean(),
      describe: "Joins the caller's socket to an arena's room.",
    }),
    hostArena: mutation({
      input: z.object({ arenaId: z.string() }),
      output: z.boolean(),
      describe: "Makes the caller's socket the arena's host, while it has none.",
    }),
  },
  channels: {
    // a player's input: to the arena's host over the player's link, never to the server
    steer: {
      payload: z.object({
        arenaId: z.string(),
        dx: z.number().min(-1).max(1),
        dy: z.number().min(-1).max(1),
      }),
      ratePerSecond: 30,
      requires: { room: (steer) => arenaRoom(steer.arenaId) },
      serve: "host",
    },
  },
  streams: {
    // the host's world, to each player of the arena: the latest snapshot seeds a newcomer
    world: {
      item: snapshotSchema,
      scope: "arenaId",
      seed: 1,
      volatile: true,
      access: { room: arenaRoom },
      serve: "host",
    },
  },
});
```

<!-- example: apps/api/src/services/kits/host.ts#service -->

```ts
// on a server created with peers: true, as host mode runs over peer links
export const arenaService = qd.defineService(arena, {
  methods: {
    enterArena: {
      access: "authenticated",
      handler: ({ input, ctx }) => ctx.rooms.join(arenaRoom(input.arenaId)),
    },
    hostArena: {
      // the app picks the host, never the server: here the first player who asks
      access: "authenticated",
      handler: ({ input, ctx }) => {
        const room = arenaRoom(input.arenaId);
        return ctx.rooms.hostOf(room) === null && ctx.rooms.setHost(room);
      },
    },
  },
  // no handler for steer and no options for world: the arena's host serves both
});
```

A player reads and sends as with a server's stream and channel:

<!-- example: apps/web/src/components/kits/ArenaHost.tsx#player -->

```tsx
// a player reads the world and sends input as with any stream and channel: both reach the host
export function useArena(arenaId: string) {
  useJoin(qd.arena.enterArena, { arenaId });
  const { items } = qd.arena.world.useStream(arenaId);
  const { send } = qd.arena.steer.useChannel();
  return {
    world: items.at(-1),
    // on the link's fast: never resent, so send input every frame, not once
    steer: (dx: number, dy: number) => send({ arenaId, dx, dy }),
  };
}
```

The host's client serves the contract's host-served members with
`defineHost`, while the server names its socket the room's host:

<!-- example: apps/web/src/components/kits/ArenaHost.tsx#host -->

```tsx
// the arenas this client simulates as their host: each player's position, by user
const arenas = new Map<string, { tick: number; players: Map<string, { x: number; y: number }> }>();

// a peer's input arrives checked against the contract (schema, room, rate), but it is still
// that player's word: the simulation applies it as it would any input
const arenaHost = defineHost(arena, {
  channels: {
    steer: (steer, { peer }) => {
      const players = arenas.get(steer.arenaId)?.players;
      const at = players?.get(peer.userId) ?? { x: 0, y: 0 };
      players?.set(peer.userId, { x: at.x + steer.dx, y: at.y + steer.dy });
    },
  },
});

// serves the arena while the server names this socket its host (qd:host), and stops when not
export function useArenaHost(arenaId: string): void {
  const { connection } = useQuickdraw();
  useEffect(() => {
    const room = arenaRoom(arenaId);
    let host: Host<typeof arena> | undefined;
    const settle = (): void => {
      const hosting = hostOf(connection, room) === connection.socket.id;
      if (hosting && host === undefined) {
        arenas.set(arenaId, { tick: 0, players: new Map() });
        host = arenaHost.serve(connection, { room });
      } else if (!hosting && host !== undefined) {
        host.close();
        host = undefined;
      }
    };
    const stop = onHostChange(connection, (changed) => {
      if (changed === room) {
        settle();
      }
    });
    settle();
    // the host's loop: twenty snapshots a second to every player of the arena
    const loop = setInterval(() => {
      const state = arenas.get(arenaId);
      if (host !== undefined && state !== undefined) {
        state.tick += 1;
        host.stream("world").push(arenaId, {
          tick: state.tick,
          players: Object.fromEntries(state.players),
        });
      }
    }, 50);
    return () => {
      stop();
      clearInterval(loop);
      host?.close();
    };
  }, [connection, arenaId]);
}
```

- A host-served channel declares `requires: { room }`, the room whose
  host takes its messages (a name, a function of the payload, or
  `{ prefix }`); a host-served stream declares a scope and
  `access: { room: (scope) => room }`, and its `seed: n` is how many items
  the host keeps per scope for a newcomer. The service gives a host-served
  channel no handler and a host-served stream no options (`defineService`
  refuses them). The server drops a `qd:ch` to one (with a development
  warning), refuses a `qd:stream:sub` to one (`VALIDATION`), and
  `qd.stream(...).push` throws for one.
- `ctx.rooms.setHost(room)` makes the calling socket the room's host and
  returns true (false for a call without a socket); the socket must be in
  the room (`FORBIDDEN`). A new `setHost` replaces the host. `hostOf(room)`
  (on `ctx.rooms`, `qd.rooms` and `server.rooms`) returns the host's
  socket id or `null`, and `clearHost(room)` clears it.
- When the host leaves the room, is taken out of it or disconnects, the
  room has no host: its sockets hear `qd:host` with `null`, and
  `onHostLeave({ room, socketId, principal, reason })` (the service's and
  `createServer`'s) runs once. The server never picks the next host; the
  app does, as `hostArena` above lets the next player who asks. Behind a
  cluster adapter each node knows each room's host. A node that dies
  without closing its sockets leaves the hosts it held recorded on the
  other nodes until each room's host is set or cleared again, and no
  `onHostLeave` runs for them. So an app that picks a host only while
  `hostOf(room)` is `null`, as `hostArena` does, also needs a way for a
  player to take over a host that stops answering: a method that calls
  `ctx.rooms.setHost(room)` or `clearHost(room)` after a timeout of the
  app's own.
- `defineHost(contract, { channels, streams })` (from `./client`, or
  `./client/core` without React) takes one handler per host-served channel, whose `ctx` is
  `{ peer: { socketId, userId, link }, room }` (the user as the server
  named it, and the host's end of the player's link), and
  `streams.<name>.seed(scope)` to compute a newcomer's seed
  (default: the latest items pushed, as many as the contract's `seed`).
  `serve(connection, { room })` answers the links of the room's players and
  returns a `Host` with `stream(name).push(scope, item)` (checked against
  the stream's schema), `peers` and `close()`. The host checks each message
  as the server checks a channel's: its schema, its room, and a bucket per
  player and channel; it ends the link of a player who floods. A player
  subscribes at most 500 times at once and then 50 times a second
  (`RATE_LIMITED`). A seed goes whole or not at all: one with an item too
  large for a message of its own is refused (`INTERNAL`), and what the
  relay drops on `rel` is sent again, in order. The host's own
  `useChannel` and `useStream` for its room reach it over an in-process
  link, so the host's own client is one of its `peers` too. One
  connection serves several contracts in a room, one `serve` each, over
  the same links; serving one contract twice in a room throws.
- `hostOf(connection, room)` and `onHostChange(connection, listener)`
  (from `./client`) say who hosts a room the socket is in. A player's feed
  subscribes again each time a link to the room's host opens (a new host,
  a reconnect), and its seed replaces what it showed. A channel message is
  dropped while no link is open, and goes on the link's `fast`, never
  resent: send input every frame. After a link to the host
  closed, the next waits 1 s, doubling to 15 s while links keep closing
  unopened.
- The server never sees what a host and its players send each other. A
  host is one player's client: trust what it reports no more than any
  client's word, and check on the server whatever a service keeps of it.
  A service's `kinds` does not reach its host-served members either: the
  host knows each player's user, not its kind, so any signed-in socket of
  the room can link to it. Guard who joins the room.

Each of a host's `peers` comes with `link`, the host's end of that
player's link: `link.clock.rtt` is the player's round trip, and
`link.setLag(...)` lags that player's messages both ways. The host's own
client is one of them, over its in-process link, so a host can play over
a link as laggy as its players':

<!-- example: apps/web/src/components/kits/ArenaHost.tsx#fair -->

```tsx
// the host's own play goes through an in-process link, one of host.peers: lag it to the median
// player's one-way delay, at most 100 ms, so the host plays over a link as laggy as its players'
export function matchPlayersLag(host: Host<typeof arena>, self: string | undefined): void {
  const oneWay = host.peers
    .filter((peer) => peer.socketId !== self)
    .map((peer) => peer.link.clock.rtt / 2)
    .sort((a, b) => a - b);
  const median = oneWay[Math.floor(oneWay.length / 2)] ?? 0;
  // call it now and then, as the players' round trips change: what is held keeps its time
  host.peers.find((peer) => peer.socketId === self)?.link.setLag({ ms: Math.min(100, median) });
}
```

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
| `GET /me`                              | `{ userId }`, or 401; 403 for a cookie from a page `allowedOrigins` does not list                                     |
| `POST /logout`                         | 204: revokes the session, clears the cookie                                                                           |
| `POST /logout-all`                     | 204: revokes every session of the user; 401 without a live session                                                    |
| `/mock/provider/*`                     | the mock provider's own endpoints, while `isMockOAuthEnabled()`                                                       |

- The OAuth state is 256 random bits, sent to the provider and kept in a
  10-minute HttpOnly, SameSite=Lax cookie (`__Host-qd_oauth` on `/` over a
  secure request or whenever `publicUrl` is https, else `qd_oauth` on
  `basePath`). The `__Host-` name is what keeps another site under the
  same parent domain from planting a state of its own (a state the routes
  issued to an attacker, to sign the browser in as them): only this host,
  over HTTPS, can set it. So serve the API over HTTPS with an https
  `publicUrl`: a plain `qd_oauth` keeps that risk. The cookie is also
  signed with an HMAC under a key derived from `jwtSecret`, so its state,
  return origin, provider and age cannot be forged; the MAC does not say
  which browser a state was issued to. The callback clears it whatever
  happens, and accepts only that state, for that provider, within its 10
  minutes, once (each redeemed state is remembered by the process), so a
  sign-in cannot be finished in another browser or replayed.
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
  `logout-all` read the cookie, else an `Authorization: Bearer` token. A
  cookie sent from a page `allowedOrigins` does not list is answered 403
  (`FORBIDDEN`), as on the HTTP transport, and `guest`, which sets the
  cookie, refuses such a page whatever it sends; a bearer token is not
  ambient, so any page may send it.
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
  on either transport. An app's own `authenticate` finds an HTTP call's
  session cookie in `request.sessionCookie`, never in `auth.token` (which
  holds only a bearer token for it), and `request.credential` says which
  one the transport chose (`"cookie"` or `"bearer"`, type
  `HttpCredentialSource`). One that accepts the cookie applies the same
  rule with `cookieOriginAllowed(request, allowedOrigins)` and checks the
  session in the store on every call (`liveSession`); a
  `QuickdrawError("FORBIDDEN")` it throws on HTTP is answered as it is. A
  hook that takes bearer tokens only (the MCP bridge's `principal`, an
  `authenticate` reading `auth.token`) uses `bearerAuth`.
- `socketAuth({ devCredentials })` signs a socket in by the user id its
  handshake names (`auth: { userId }`, no token), as the function answers
  (the principal, or `null` to refuse): for a game editor or load-test bots
  in development. It runs only when `NODE_ENV` is `development` or `test`:
  `socketAuth` throws when it is given otherwise (an unset `NODE_ENV`
  included: set `NODE_ENV=development`), refuses such a handshake once
  `NODE_ENV` says otherwise, and `createServer` warns at startup while it
  is on; pass it only behind the app's own flag.
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
  (`ENABLE_MOCK_OAUTH=true` and `NODE_ENV` `development` or `test`; an
  unset `NODE_ENV` mounts nothing and logs an error saying to set
  `NODE_ENV=development`), mounting it logs a warning, and every request
  checks again. Set `mock({ internalUrl })` where the API
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
  the same name, and read `__Host-session` first wherever it is present:
  only this host, over a secure context, can have set it. Without a
  domain, a request over HTTPS reads only `__Host-session`, never
  `session`: another site under the same parent domain can set that cookie
  for the whole domain, and while the user holds no `__Host-session` it
  would sign them in as whoever set it. A plain HTTP request reads
  `__Host-session`, then `session` (the name the routes set there); when
  the routes or `setSessionCookie` and `clearSessionCookie` set or clear
  `session`, they also clear a stale `__Host-session` the request carries,
  which would otherwise shadow it, or outlive a sign-out. A configured name is read as it is, on
  any request, so a changed name goes in all three places:
  `createAuthRoutes({ cookie: { name } })`, `socketAuth({ cookieName })`
  and `createServer({ http: { cookieName } })`. The transports see the
  cookie's domain through `COOKIE_DOMAIN` only: share the cookie with
  subdomains by setting `COOKIE_DOMAIN`; a `cookie.domain` given only to
  the routes needs `cookieName: "session"` on the other two, and the routes
  warn at startup until the cookie is named. They also warn for
  `cookie.domain: ""` while `COOKIE_DOMAIN` is set: the transports then
  take a `session` cookie over HTTPS too, which the routes never set there
  and any site under that domain can. Behind a proxy that ends TLS,
  have it send `X-Forwarded-Proto`, which every request carries, so the
  name does not depend on which requests carry an `Origin`.
- A socket whose session expires is disconnected then (`io server
disconnect`; `socketAuth` records the expiry, and an app's own
  `authenticate` may, through `recordSocketSession(socket, sessionId,
expiresAt)`, with `expiresAt` a `Date` or epoch milliseconds: a JWT's
  `exp` is in seconds). A handshake whose recorded session expired before
  it ended (a slow `loadPrincipal`) is refused, `UNAUTHENTICATED`. Otherwise a socket keeps the principal it authenticated
  with until it reconnects, so a revoked session's open sockets are ended with
  `server.access.disconnectUser(userId, { sessionId?, reason? })`: every
  socket of the user, or those `socketAuth` recorded for one session
  (`recordSocketSession` on `./server` for an app's own `authenticate`), on
  every node behind a cluster adapter. `onRevoke(userId, sessionId | null)`
  tells the app when `logout` (the session's id) or `logout-all` (`null`)
  revoked; wire it as above. A disconnected client does not reconnect on
  its own; its next connect is authenticated afresh. It forgets the user
  and everything quickdraw cached (`isKnown` false, `status`
  `"disconnected"`), and calls waiting to be sent when a reconnect is
  refused fail with `CANCELLED`, so a shared machine shows nothing of
  theirs.
- `issueSession({ sessions, jwtSecret }, userId, { provider })` starts a
  session for an app's own sign-in flow (login codes, an embedded activity),
  and `liveSession` reads a token back; both work with `socketAuth`.
- `bearerAuth({ sessions, jwtSecret, loadPrincipal? })` is `socketAuth`'s
  counterpart for a hook handed a bearer token alone (the MCP bridge's
  `principal`, `authenticate: ({ auth }) => verify(auth.token)`): no token
  is anonymous, a token whose session is not live is refused with
  `UNAUTHENTICATED`, on every call, and it never reads cookies. It records
  no socket session: use `socketAuth` for `createServer`. `verifyJWT`
  checks a token's signature and expiry only, never the store, and warns
  once in development when it verifies a session token.

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
signing out: `connection.close()`, then `open()`, as below, or a reload
(with a token in `auth`, clearing it does that):

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
- `app.as(principal)` calls in process (with transport `"internal"`, or
  another, below) and `app.connect(principal)` over a real socket
  (`{ call, socket, hello, close }`); both are keyed by service name.
  `app.frames(match?)` lists every frame the server sent, with its
  socket and user; `frames.waitFor(match)` waits for one. A query of one
  event (`EventQuery`) takes `where`, a predicate over its frames typed by
  the event (`{ event: "qd:presence", where: ({ data }) => data.joined === id }`), and
  `streamFrames(contract, stream, where?, scope?)` and
  `eventFrames(contract, event, where?)` match one stream's items or one
  event's payloads, typed by the contract, to spread beside `socketId` or
  `userId`. `emitWithAck` and `waitForEvent` send raw frames and wait for
  events.

`app.as(principal, { transport, mcp })` calls in process as another
transport would, so a guard that reads `ctx.mcp` or `ctx.transport` is
tested like any other access. Here the handler example's `assign` (under
Services), which refuses an agent's token without the `tasks` scope:

<!-- example: apps/api/src/services/task.test.ts#token -->

```ts
it("lets an agent's token assign tasks only with the tasks scope", async () => {
  // the handler example's assign, which reads the token's scopes from ctx.mcp
  const app = await createTestApp({ services: [assigningService], db });
  const agent: AppPrincipal = { ...ada, kind: "agent", serviceAccess: { taskService: "Moderate" } };
  const input = { id: taskId, assigneeId: bo.userId };
  // in process, as an MCP tool call arrives: transport "mcp", and the context hook's fields as ctx.mcp
  const reader = app.as(agent, { transport: "mcp", mcp: { scopes: [] } });
  await expect(reader.taskService.assign(input)).rejects.toMatchObject({ code: "FORBIDDEN" });
  const writer = app.as(agent, { transport: "mcp", mcp: { scopes: ["tasks"] } });
  expect(await writer.taskService.assign(input)).toMatchObject({ assigneeId: bo.userId });
  await app.close();
});
```

- `transport` is `"internal"` (the default), `"http"` or `"mcp"`; a
  socket's call is `app.connect`'s. `mcp` is the call's `ctx.mcp`, typed by
  the app's `QuickdrawTypes["mcp"]`: with `transport: "mcp"` the call is an
  MCP tool call's, and with the default transport it is a call an MCP call
  made through `ctx.services`.
- Bound arguments and the registry's `principal` and `context` hooks belong
  to the MCP registry, not the dispatcher, so test them through the
  registry: `registry.callMethod(service, method, input, { request })`
  calls a method's tool as an agent would, with the input as the method
  takes it, and resolves with `{ ok: true, data }` or
  `{ ok: false, error }`.

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
principals. Each cell of the report records its principal's `kind`, and a
cell that differs is listed with it: on a service or method with `kinds`,
give the matrix a principal of each kind it refuses.

### Access snapshots

`snapshotAccessMatrix(app, { principals, reset, rows })` records the whole
matrix instead of chosen cases: every method of the app's services (or of
`services`), each entity subscribe (`qd:sub`) and each collection scope
(`qd:col:sub`), as every principal and anonymously. The first run writes the
outcomes to `__access__/<test file>.json` beside the test, and every later
run compares its matrix with that file, so each changed cell is a decision
someone made. Commit the file. Use it to pin a service's table, and before
a migration, a policy refactor or a new kind of principal:

<!-- example: apps/api/src/services/task.test.ts#snapshot -->

```ts
it("pins who may call what, for every method, subscribe and scope", async () => {
  const app = await createTestApp({ services: [projectService, taskService], db });
  const report = await snapshotAccessMatrix(app, {
    principals: { owner: ada, member: bo, stranger: ed },
    reset: async () => {
      await resetDatabase(prisma); // at the start, and after each write access let through
      return await seed();
    },
    rows: (board) => ({ projectService: board.projectId, taskService: board.taskId }),
  });
  expect(report.inconclusive).toEqual([]); // every cell ran, with an input its schema accepts
  await app.close();
});
```

- `reset()` empties the database and seeds it (`resetDatabase` from
  `./testing/prisma`, then the app's seed, with the untracked client), and
  resolves with what the seed made: the fixture. It runs first, and again
  after every mutation the pipeline did not refuse, so no cell sees the
  writes of another. `principals` may be a function of the fixture, for a
  seed that makes new ids; its names stay the same.
- `rows(fixture)` names the row each service's cells are about: a row id,
  or named variants (`{ own: p1, other: p2 }`), each a row of the matrix of
  its own. It names every service an access form, an entity subscribe or a
  collection anchor of the matrix reads; a missing one is a `TypeError`
  before any cell runs. A `"self"` scope is subscribed with the caller's own
  user id.
- Inputs are made from each method's input schema (Zod 4.2 or later
  describes itself as JSON Schema): the row goes where the access form reads
  it (`id`, the key an `entry` or `scope` form names, or where a function
  `id` finds it; for any other form, the input's `id`), and every other
  required value is as small as the schema allows. `inputs(ref, fixture)`
  gives a method's input instead (`ref` names the service, method, kind,
  variant, row and principal of the cell); `undefined` keeps the made one.
  A cell whose input fails the schema, or names no row where an `entry` or
  `scope` form reads it, is never called: it is `VALIDATION`, and the
  report lists it in `inconclusive`.
- Each cell is the exact outcome: `"ok"`, or the error code
  (`UNAUTHENTICATED`, `FORBIDDEN`, `NOT_FOUND`, ...). Each principal's
  `kind` is recorded beside the cells.
- A cell whose outcome changed fails, naming the cell, both outcomes and
  whether the change opens or closes access (a changed `kind` fails too):

  ```text
  snapshotAccessMatrix: 1 cell differs from the access snapshot (src/services/__access__/task.test.ts.json):
    taskService.rename as member: FORBIDDEN → ok (opens access)
  ```

  When each change is meant, run the tests with
  `QD_UPDATE_ACCESS_SNAPSHOT=1` and commit the file.

- Cells added or removed (a new method, principal or exclusion) rewrite the
  file in a local run. Under CI (`CI=1` or `CI=true`) they fail, and so do a
  missing file and `QD_UPDATE_ACCESS_SNAPSHOT`: a snapshot that writes
  itself pins nothing.
- Leave out a method whose outcome differs from run to run with
  `exclude: ["taskService.roll"]`; the file lists it. Take one snapshot per
  test file (one test file per service keeps merges small), or pass
  `{ file }`.

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
- Whether an order column may hold null comes from the client's own schema,
  with no statement; only a client that carries no schema text makes the
  storage adapter ask the database, once per column and process. When a step
  could be the first to pay for such a read, run it once before measuring it,
  so its budget does not depend on the order tests run in.

### Development warnings

While `NODE_ENV` is not `"production"`, a running app warns about the slow
and untracked patterns lint cannot see, as they happen. Every warning has
one format and names the method call it happened in (except for three:
`untracked-access-model` is checked as the server starts and logged as an
error under `category: "quickdraw.access"`, in every environment, at each
start, and `authenticate-threw` and `mcp-principal-threw` come from a
handshake, an HTTP request or an MCP tool call's session, before any
method's call):

```text
[quickdraw:n-plus-one] taskService.board: task.findUnique by id ran 10 times in one call, once per item (N+1); ...
```

| Kind                       | Raised when                                                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `n-plus-one`               | a call ran 10 statements of one shape (model, operation, `where` keys), outside a `$transaction([])`                                                                                                                      |
| `unbounded-read`           | a call ran `findMany` with neither `take` nor ids to read (`id`, `{ in }` or `{ equals }`)                                                                                                                                |
| `oversized-response`       | a reply was larger than `maxResponseBytes` (default 1 MiB)                                                                                                                                                                |
| `nested-write`             | a write's `data` wrote a related row, which is not tracked                                                                                                                                                                |
| `ambient-write`            | a tracked write ran outside any unit of work                                                                                                                                                                              |
| `batch-read`               | a write in an array-form `$transaction` read its rows outside the batch                                                                                                                                                   |
| `batch-create-many`        | a `createMany` in an array-form `$transaction` could not report its rows                                                                                                                                                  |
| `repeated-call`            | one connection repeated a call or was refused `RATE_LIMITED` again and again (below)                                                                                                                                      |
| `tiered-field-in-output`   | a method's own output schema declares a field the contract tiers, which only projection outputs strip; raised when the server is made (for an output without JSON Schema, when a reply carries it)                        |
| `resolver-without-reads`   | a service's policy is, or combines in `anyOf`, a `resolver` without `reads`, so no tracked write re-checks it; raised when the server is made                                                                             |
| `untracked-access-model`   | a model a policy, a membership table or a `via` junction depends on has no `id` the write tracker can key its rows by, so no write to it revokes; checked when the server starts, logged as an error in every environment |
| `shared-principal`         | the handler of a `share: "all"` run (an app's, not a kit's) read `ctx.principal`, `ctx.services`, `ctx.mcp` or `ctx.access`: the run has the first caller's, and every caller gets its result                             |
| `channel-without-requires` | a channel's contract declares no `requires` and its service no `access`, so every signed-in user may send it; raised when the server is made                                                                              |
| `authenticate-threw`       | the server's `authenticate` threw anything but a `QuickdrawError`, which both transports take for the server's failure (`INTERNAL`), so a refusal made that way never signs a client out; once per server                 |
| `mcp-principal-threw`      | an MCP registry's `principal` hook threw anything but a `QuickdrawError`, which the bridge answers `INTERNAL`, so an agent whose token it refused that way is told the server failed; once per registry                   |

Updates and deletes by id inside an interactive transaction are not counted
toward `n-plus-one`: that is how per-row writes are written (see tracked
writes). Each is logged once per kind, service, method and subject (the
model, the field of a nested write, or the member a shared run read), under
`category: "quickdraw.dev"`.
Only an app's own statements are checked: the framework's reads and the
kits' own reads are not, while the app's callbacks a kit calls (`prepare`,
`onWrite`, `onChange`, `resolveUser`, a search strategy) are. A statement filtered by
an `id` list (`{ id: { in: ids } }`, one per chunk of ids) never counts
toward `n-plus-one`, and neither does a `createMany` (one per chunk of
rows, as a large insert is split). In tests, `createTestApp({ strictWarnings: true })`
(under vitest or jest) throws every warning raised in that app's method
calls as a `DevWarningError` where it is raised, so the test that caused it
fails: the call it happened in fails with `INTERNAL` and the error as its
`cause`, and an in-process call whose reply was oversized rejects with it
once the reply was recorded (over a socket or HTTP the reply was already
sent, so that error is logged, not thrown). Strictness belongs to the app:
warnings outside its calls (an ambient write while seeding, an
`authenticate` that threw, another app's calls) are logged as usual, and
`app.close()` ends it. The ones raised when
the app is made, `tiered-field-in-output`, `resolver-without-reads`,
`untracked-access-model` and `channel-without-requires`, are thrown from
`createTestApp` itself, so a strict app over such a method, policy, table
or channel does not start.

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
channels `sent` and events `mockEmit`. A new answer refetches, once, the
method's results cached when it is set; a component rendered after it reads
the new answer with its own first fetch, so `calls` counts one call per
mount. Everything set is forgotten after
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
// withSavepoints: nested transactions (tx.$transaction inside one) run here as on PostgreSQL
export const prisma = new PrismaClient({ adapter: withSavepoints(new PrismaPGlite(pglite)) });
```

`TEST_TEMPLATE` is `{ migrationsDir, cacheDir, templateName }`, the same the
global setup builds with (`buildPgliteTemplate(TEST_TEMPLATE)`, or
`createPrismaTestGlobalSetup`), and a setup file empties the database before
each test (`beforeEach(() => resetDatabase(prisma))`). Apply `trackPrisma`
to the test client exactly as in production. `withSavepoints(factory)`
gives the adapter's transactions the savepoints Prisma 7 runs a nested
`tx.$transaction(...)` with, as `@prisma/adapter-pg` runs them, so code that
nests transactions commits and rolls back on PGlite as on PostgreSQL;
`pglite-prisma-adapter` has none, and Prisma refuses a nested transaction
on it without them. An adapter with savepoints of its own keeps them.

## Observability

Logs go to `createServer({ logger })`, any logger with Winston's methods
(default `consoleLogger`). The console default drops `debug` when
`NODE_ENV` is `"production"`, since a call's record logs at debug with its
caller's user id: `createConsoleLogger({ level: "debug" })` keeps it, and
`level: "warn"` drops `info` too. An error is logged with its message and
stack, but a Prisma client error only with its class, `code`, the schema
names and codes of its `meta` (never a value, nor the database's own text,
which quotes the row), the reason a validation error gives, and its stack
frames: its message renders the call, values included.

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
access; a stream's computed seed and when its items are checked. Each
page also gets a "Depends on" section: the other services its
declarations name, and which declaration names each one. A service depends
on another when its row policy `inherit`s from it, it `writes` the model
that service's rows live in, it `affects` that service's rows, one of its
methods, channels or streams takes a `{ scope, of }` form of it, or one of
its collections is anchored on that service's rows. A `writes` model that no
service's rows live in is listed as a model. The index adds a Mermaid
`graph LR` of the same edges, each labelled with how. Only declarations are
read: a handler that reads another service's rows without declaring it adds
nothing. A contract the services module has no service for says so, and a
service without a contract is an error. Pass the same flag to `--check`. The
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
service is defined (an access form that asks the policy nothing about the
row a method's `id` names, unless it says `rowless: true`); then lint; then a
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

| Export             | Holds                                                                                                                                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.`                | `defineContract`, `query`, `mutation`, `nullable`, `listOf`, `via`, the kits' contract halves, inference types, `QuickdrawError`, error codes, protocol types, room and topic names, `consoleLogger` and `createConsoleLogger`, the types `Tracked` and `TrackedTransaction` |
| `./server`         | `initQuickdraw`, `createServer`, `createDispatcher`, `createHttpRouter`, policies, `custom`, the kits' handlers, `requireRow`, `nextOrdinal`, `storageOf`, dev warnings, the Redis adapter, the socket rate limiter, env and encryption helpers                              |
| `./server/auth`    | `createAuthRoutes`, `socketAuth`, `bearerAuth`, `requireSession` and `sessionOf`, providers (`google`, `discord`, `mock`, `guest`), session stores, `issueSession`, `liveSession`, JWT, cookie and origin helpers                                                            |
| `./server/express` | Express rate limits: `createAuthLimiter`, `createAuthStatusLimiter`, `createCallLimiter`, `createPublicApiLimiter`, `createWebhookLimiter`                                                                                                                                   |
| `./server/mcp`     | `createMcpRegistry`, `describeTools`, `createMcpStdioServer`, `createMcpHttpRouter`, `bootstrapMcpServer`                                                                                                                                                                    |
| `./server/otel`    | `otelOnCall`                                                                                                                                                                                                                                                                 |
| `./prisma`         | `trackPrisma`, `storageOf`, the types `Tracked` and `TrackedTransaction`                                                                                                                                                                                                     |
| `./client`         | `createQuickdrawClient`, `QuickdrawProvider`, `useQuickdraw`, `usePresence`, `useAdminServices`, `createQuickdrawConnection`, `call`, `callData`, `liveDataOf`, the coordinator; everything in `./utils`                                                                     |
| `./client/core`    | the client without React or TanStack: `createQuickdrawConnection`, `call`, `callData`, `newId`, the auth helpers, `createPeerLink`, `defineHost`; everything in `./utils`                                                                                                    |
| `./utils`          | `createServerCaller`, cache keys (`methodKey`, `entityKey`, `collectionKey`), formatting, navigation, `parseJWTPayload`                                                                                                                                                      |
| `./parser`         | the JSON-only Socket.IO parser                                                                                                                                                                                                                                               |
| `./testing`        | `createTestApp`, `describeAccessMatrix`, `snapshotAccessMatrix`, `expectBudget`, `createRecordingSink`, `DevWarningError`                                                                                                                                                    |
| `./testing/client` | `renderWithQuickdraw`, and everything in `./testing/mock`                                                                                                                                                                                                                    |
| `./testing/mock`   | `createMockClient` alone, without Testing Library: for browser bundles such as Storybook                                                                                                                                                                                     |
| `./testing/prisma` | test databases on PostgreSQL or PGlite                                                                                                                                                                                                                                       |

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
