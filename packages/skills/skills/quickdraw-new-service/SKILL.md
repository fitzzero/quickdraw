---
name: quickdraw-new-service
description: Add a service to a quickdraw 5.0 app end to end - its Prisma model and migration, its contract in the shared package, the service on the server, registration in createServer, the typed client's hooks in the web app, and its tests (access matrix, live behavior, budgets). Use when asked to "add a service", "add a model to the API", "expose X to the client", or to add methods, collections or a kit to an existing service.
---

# Add a quickdraw service

Six steps, in this order, because each one is typed by the one before it.
Paths follow the quickdraw template (`packages/db`, `packages/shared`,
`apps/api`, `apps/web`). When the app's own rules (`.claude/rules/`, `CLAUDE.md`) name
other paths, theirs win: read one existing service, its registration and
its tests first, and put the new ones beside them. The rules
`quickdraw-services.md`, `quickdraw-access.md`, `quickdraw-client.md` and
`quickdraw-testing.md` (linked into `.claude/rules/`) hold the details.

Before you start, read one existing service and its contract in this app,
and the Prisma model the rows live in. Decide:

- **Where its rows live**: a Prisma model, or none (an RPC-only service has
  no `entity`, `model` or row policy).
- **Who may see a row**: an owner column, a JSON access list, a membership
  table, or the parent row's access (`inherit`). This is the row policy.
- **What a client lists**: which scopes (a project's tasks, a user's chats).
  Each is a collection, not a list method.

## 1. The model (`packages/db/prisma/schema.prisma`)

A service whose rows are new needs their Prisma model first: the service's
`model`, its `db.<model>` calls and its row policy's columns are checked
against the generated client. Add the model beside the others, with a
string `id` (every tracked row is keyed by it) and the columns the row
policy and the collections read (here `projectId`):

```prisma
model Label {
  id        String  @id @default(cuid())
  projectId String
  name      String
  project   Project @relation(fields: [projectId], references: [id], onDelete: Cascade)

  @@index([projectId])
}
```

Then, in `packages/db`, create the migration and generate the client, in
that order: `bun run db:migrate --name add_labels` (`prisma migrate dev`,
which writes `prisma/migrations/<time>_add_labels/migration.sql` and applies
it to the development database), then `bun run db:generate`. Prisma 7's
`migrate dev` no longer generates the client, so until `db:generate` runs
`db.label` does not exist and step 3 fails to typecheck. Commit the
migration with the schema. A service of rows that exist already skips this
step; an RPC-only service has no model.

## 2. The contract (`packages/shared/src/contracts/<name>.ts`)

<!-- example: packages/shared/src/contracts/label.ts -->

```ts
import { crud, defineContract, mutation } from "@fitzzero/quickdraw-core";
import { z } from "zod";

const label = z.object({ id: z.string(), projectId: z.string(), name: z.string() });

export const labelContract = defineContract("labelService", {
  describe: "Labels a project puts on its tasks.",
  entity: label,
  methods: {
    ...crud.contract({ entity: label, get: true, create: { input: label.omit({ id: true }) } }),
    rename: mutation({
      input: z.object({ id: z.string(), name: z.string() }),
      output: "entity",
      describe: "Renames a label.",
    }),
  },
  collections: {
    byProject: {
      describe: "A project's labels, by name.",
      scope: "projectId",
      item: "entity",
      order: [
        ["name", "asc"],
        ["id", "asc"],
      ],
    },
  },
});
```

- Service names end in `Service` and never change once deployed: they are
  stored in users' grants and sent on the wire.
- Use Zod 4.2 or later for every schema. Give the contract and each of its
  methods, collections, streams, channels and events a `describe` sentence:
  MCP clients and the generated API docs read it, and lint's
  `require-describe` warns on each one missing.
- Export the contract from `packages/shared/src/contracts/index.ts`, next to
  the others, and add it to the `contracts` map there: that map types the
  web client and `qd.caller`.

## 3. The service (`apps/api/src/services/<name>/index.ts`)

One directory per service: its helpers and its own unit-tested logic sit
beside `index.ts`. The API compiles as an ES module with NodeNext
resolution, so a relative import names the file with `.js`
(`"../../quickdraw.js"`; TS2835 without it).

<!-- example: apps/api/src/services/label/index.ts -->

```ts
import { crud, inherit } from "@fitzzero/quickdraw-core/server";
import { labelContract, projectContract } from "@project/shared";
// `.js`: the template's API compiles with NodeNext, which wants the extension on a relative import
import { qd } from "../../quickdraw.js";

export const labelService = qd.defineService(labelContract, {
  model: "label",
  access: inherit({ from: projectContract, via: "projectId" }),
  collections: { byProject: { anchor: projectContract } },
  methods: {
    ...crud.handlers(labelContract, {
      access: {
        get: { entry: "Read" },
        create: { scope: "Moderate", of: projectContract, id: "projectId" },
      },
    }),
    rename: {
      access: { entry: "Moderate" },
      handler: ({ input, db }) =>
        db.label.update({ where: { id: input.id }, data: { name: input.name } }),
    },
  },
});
```

- `qd` is the app's one `initQuickdraw` instance; import it, never create a
  second one.
- Every method declares `access`; write through the handler's `db`; list any
  other model the handlers write in `writes`; return rows for projection
  outputs. Throw `QuickdrawError` with a code for expected failures.
- A method whose input has `id` names a row: give it `{ entry: L }`.
  `defineService` refuses `"public"`, `"authenticated"` or `{ service: L }`
  below `Admin` there unless the method says `rowless: true` (every caller
  the form admits may reach any row, on purpose).
- Reach for a kit before hand-writing CRUD, search, sharing or admin; lint's
  `prefer-kit` warns on a hand-written `get`, `list`, `create` or
  `getLabel`-style method in a service that uses no kit.

## 4. Register it (`apps/api/src/services/index.ts`)

Add the service to the `services` list there. The server
(`apps/api/src/index.ts`, `qd.createServer({ services })`), the MCP server,
the tests and the benchmark all take their services from that list, so the
new one reaches every root at once; never add it to one root by hand. If
the MCP registry must not offer some of its methods to agents, exclude them
there.

## 5. Use it from the web app

The web client is made from the shared `contracts` map
(`apps/web/src/lib/quickdraw.ts`, `createQuickdrawClient(contracts)`), so the
contract added in step 2 is already there: its key becomes `qd.<key>` (the
template keys the map by service name, `qd.labelService`; this example's
map uses `label`). Then use the hooks:

<!-- example: apps/web/src/components/Labels.tsx -->

```tsx
"use client";

import { qd } from "../lib/quickdraw";

export function Labels({ projectId }: { readonly projectId: string }) {
  const { items } = qd.label.byProject.useCollection(projectId);
  const rename = qd.label.rename.useMutation();
  return (
    <ul>
      {items.map((label) => (
        <li key={label.id}>
          <button type="button" onClick={() => rename.mutate({ id: label.id, name: "urgent" })}>
            {label.name}
          </button>
        </li>
      ))}
    </ul>
  );
}
```

Read with `useEntity` and `useCollection` before `useQuery`; never refetch
or invalidate after a mutation by hand.

## 6. Test it (`apps/api/src/__tests__/services/<name>.int.test.ts`)

A test that boots the app (`createTestApp`, `describeAccessMatrix`,
`expectBudget`) needs the test database, so it is an integration test:
`<name>.int.test.ts`, which the database lane (`vitest.int.config.ts`, whose
global setup makes the database) runs. A plain `<name>.test.ts` runs in the
unit lane, without a database, and fails at its first query: keep it for
pure logic beside the service (`apps/api/src/services/<name>/*.test.ts`).
Components rendered against the server go in
`apps/web/src/__tests__/<name>.int.test.tsx`.

- `describeAccessMatrix` over every method, as an owner, a member, a
  stranger and anonymously; or `snapshotAccessMatrix`, which records every
  method, entity subscribe and collection scope of the service in
  `__access__/<test file>.json` (commit it, and keep its report's
  `inconclusive` empty).
- One live test: a write by one user reaches another user's collection or
  entity (`app.frames.waitFor`, or a component through
  `renderWithQuickdraw`).
- `expectBudget` for each method a page calls on load; commit the
  `__budgets__` file it writes.
- `createTestApp({ ..., strictWarnings: true })`, so N+1 reads, unbounded
  reads and nested writes in the service's calls fail the test that caused
  them. Seed rows with the untracked client (`prisma`).

## Finish

Run the app's lint (the quickdraw rules catch untracked writes, foreign
writes, unbounded reads and raw socket use), typecheck and the unit and
integration tests. If the app generates API docs with `quickdraw-docs`
(with `--services`, its pages also say who may call each method),
regenerate them and commit the result.
