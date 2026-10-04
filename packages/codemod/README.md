# @fitzzero/quickdraw-codemod

Moves a quickdraw 4.x app to 5.0: contracts in the shared package, services
as `qd.defineService(...)`, the web app's hooks on the typed client. It does
the mechanical part, never changes who may call a method, and marks
everything that needs a decision. The guide to the rest is
[`MIGRATION.md`](MIGRATION.md), shipped beside it.

```bash
bunx @fitzzero/quickdraw-codemod@next v5 . --dry-run   # what it would change
bunx @fitzzero/quickdraw-codemod@next v5 .
```

Run it from the app's repository root, on a clean working tree, after
upgrading `@fitzzero/quickdraw-core` to 5.0. It expects the quickdraw
template's layout; the options move each part:

| Option                | Default                                       |
| --------------------- | --------------------------------------------- |
| `--shared <dir>`      | `packages/shared`                             |
| `--api <dir>`         | `apps/api`                                    |
| `--web <dir>`         | `apps/web`                                    |
| `--db-package <name>` | `packages/db`'s name                          |
| `--dry-run`           | write nothing; list the files it would change |

## What it does

- **Contracts.** One `defineContract("<serviceName>", { ... })` per 4.x
  service in `packages/shared/src/contracts/`, from the service's method map
  and `defineMethod` calls. Each method's `input` is the schema its
  `defineMethod` validated with, moved into the shared package with the
  helpers it needs (or `todoSchema<Payload>()` when it had none); its output
  is `"entity"` when the 4.x response was the service's DTO (or
  `todoSchema<Response>()`); its kind is `query` when its name starts with
  get, list, search, find or count, or the web app reads it with
  `useServiceQuery`. Service names are kept exactly.
- **Services.** Each `BaseService` (or `BaseRpcService`) class becomes
  `qd.defineService(contract, { model, access, methods })` in its own file.
  Handler bodies are kept, with `({ input, ctx, db })` for
  `(payload, ctx)`, `ctx.principal.userId` for `ctx.userId` and the tracked
  `db` for the Prisma field. Helper methods become module functions. A split
  service's method modules export typed method objects.
- **Access.** Each method gets the 5.0 form that admits exactly the callers
  4.x admitted:

  | 4.x                                        | 5.0                                  |
  | ------------------------------------------ | ------------------------------------ |
  | `"Public"`                                 | `"public"`                           |
  | any level, with a row id                   | `{ service: L, entry: L, id }`       |
  | `"Read"` without a row id                  | `"authenticated"`, marked for review |
  | `"Moderate"` or `"Admin"` without a row id | `{ service: L }`                     |

  A row id is `resolveEntryId`, or a payload with `id`, which 4.x read
  implicitly.

- **The web app.** `useService`, `useServiceQuery`, `useSubscription` and
  `useCollection` become `qd.<service>.<member>` hooks, through the app's
  typed wrappers too, which are deleted once nothing calls them.
- **Other uses of a service class.** An import of `ChatService` becomes one
  of the service object `chatService`, `new ChatService(prisma)` becomes
  `chatService` (marked) and the class as a type `typeof chatService`. A
  file that already binds that name (a local `const chatService = new
ChatService(prisma)`, a parameter `pushService: PushService`) imports the
  object under an alias (`chatService as chatServiceDef`), so no output
  refers to itself.
- **Every workspace package that depends on quickdraw** (the root
  `package.json`'s `workspaces`), not only shared, api and web: the
  database package's test helpers, say. An entry point that only moved is
  rewritten there and everywhere (`@fitzzero/quickdraw-core/server/testing/prisma`
  becomes `@fitzzero/quickdraw-core/testing/prisma`, with the same
  functions); the rest of the 4.x API there is marked.
- **New files**: the tracked `db`, `initQuickdraw` (with `AppTypes`,
  `MethodOf` and `PublicMethodOf`) and the web app's typed client.

## What it leaves

Wherever a person has to decide, a marker above the code says what to do:

```ts
// quickdraw-migrate: review [emit] hand emit: 5.0 sends entity frames from tracked writes; delete this once the write goes through db
this.emitUpdate(input.id, updated);
```

`quickdraw-migration-report.md`, at the repository root, lists every marker
with its file and line, grouped by kind: the contracts' placeholders and
method kinds, the access forms to decide, access overrides to turn into a
policy, `toDto` and protected fields, collections to declare, hand emits,
`this.create/update/delete` calls, raw SQL writes, lifecycle hooks,
`installAdminMethods`, instance state, client hook options, a hook's
`error` read as the 4.x message string (`error.includes(...)`: it is a
`QuickdrawError` now), every use of a 4.x service instance's members
(`pushService.resubscribe(...)`, `gameService.sim`, found by type; the
service object has none), a dynamic `import()` of a service class and the
`new` that follows it, and the 4.x APIs left (the server set-up, room
events). The report is read back from the markers, so it always matches the
code. A dry run lists the report with the files it would change: `A` when
the run would create it.

Running the codemod again changes no code: delete each marker once its
item is done, run it again, and the report lists what remains. Lint
(`@fitzzero/quickdraw-lint`'s `no-v4-api` and `no-todo-schema`) and the
typecheck report the same work.

## Development

The tests run the codemod on a 4.1 app laid out like the template
(`test/fixtures/v4-app`, modeled on quickdraw-chat; it typechecks against
the published 4.1.0) and check that the output matches the committed
snapshot (`test/fixtures/v4-app.expected`; `bun run test -u` rewrites it),
that it typechecks against the built 5.0 core and passes the 5.0 lint rules
apart from what its markers cover, that the report lists every item of the
fixture at its file and line, and that a second run changes nothing.
`MIGRATION.md` is a copy of the repository's (written by `bun run
readme:sync` in `packages/core`); its appendix of removed names comes from
`bun run guide:sync`.
