---
name: quickdraw-new-service
description: Add a service to a quickdraw 5.0 app end to end - its contract in the shared package, the service on the server, registration in createServer, the typed client's hooks in the web app, and its tests (access matrix, live behavior, budgets). Use when asked to "add a service", "add a model to the API", "expose X to the client", or to add methods, collections or a kit to an existing service.
---

# Add a quickdraw service

Five steps, in this order, because each one is typed by the one before it.
Paths follow the quickdraw template (`packages/shared`, `apps/api`,
`apps/web`); use the app's own if they differ. The rules
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

## 1. The contract (`packages/shared/src/contracts/<name>.ts`)

<!-- example: packages/shared/src/contracts/label.ts -->

```ts
import { crud, defineContract, mutation } from "@fitzzero/quickdraw-core";
import { z } from "zod";

const label = z.object({ id: z.string(), projectId: z.string(), name: z.string() });

export const labelContract = defineContract("labelService", {
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
- Use Zod 4.2 or later for every schema; give each method a `describe`
  sentence when agents or MCP clients will call it.
- Export the contract from the shared package's index, next to the others.

## 2. The service (`apps/api/src/services/<name>.ts`)

<!-- example: apps/api/src/services/label.ts -->

```ts
import { crud, inherit } from "@fitzzero/quickdraw-core/server";
import { labelContract, projectContract } from "@project/shared";
import { qd } from "../quickdraw";

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
- Reach for a kit before hand-writing CRUD, search, sharing or admin.

## 3. Register it (`apps/api/src/index.ts`)

Add the service to `qd.createServer({ services: [...] })`. If the app has an
MCP registry (`createMcpRegistry({ services, dispatcher })`), add it there
too, or exclude the methods agents must not call.

## 4. Use it from the web app

Add the contract to the map given to `createQuickdrawClient` (the key you
pick becomes `qd.<key>`), then use the hooks:

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

## 5. Test it (`apps/api/src/services/<name>.test.ts`)

- `describeAccessMatrix` over every method, as an owner, a member, a
  stranger and anonymously.
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
writes, unbounded reads and raw socket use), typecheck and tests. If the app
generates API docs with `quickdraw-docs`, regenerate them and commit the
result.
