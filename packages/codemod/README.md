# @fitzzero/quickdraw-codemod

Moves a quickdraw 4.x app to 5.0: contracts in the shared package, services
as `qd.defineService(...)`, the web app's hooks on the typed client. It does
the mechanical part, never changes who may call a method, and marks
everything that needs a decision. The guide to the rest is
[`MIGRATION.md`](MIGRATION.md), and the procedure for an agent
[`UPGRADE-PROMPT.md`](UPGRADE-PROMPT.md), both shipped beside it.

```bash
bunx @fitzzero/quickdraw-codemod v5 . --dry-run   # what it would change
bunx @fitzzero/quickdraw-codemod v5 .
```

Run it from the app's repository root, on a clean working tree, after
upgrading `@fitzzero/quickdraw-core` to 5.0. It formats what it writes with
the app's formatter (oxfmt, prettier or Biome, when the root `package.json`
has it and it is installed), so the output passes the app's format check as
written. Files the formatter's config ignores (an app that ignores Markdown
ignores the report) are left as written. When the formatter fails, the
codemod prints its exit code, the formatter's own error and the files it
left unformatted. It expects the quickdraw template's layout; the options move each
part:

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
  `db` for the Prisma field. Helper methods and getters become module
  functions (a getter's reads call it). Fields become module bindings with
  their initializers, marked, and the constructor's other code, the values
  it gave fields included, an exported `setUp<Service>(...)` taking the
  constructor's parameters it uses, marked; only the Prisma client's field
  and a field holding another service go. A call of the 4.x base class
  (`super.x(...)`) is dropped under a marker that names it: `super` outside a
  class does not parse. A `DTO | null` mutation of one row answers
  `"entity"`, marked (a tracked write throws `NOT_FOUND` rather than
  answering null, and only `"entity"` is optimistic by default). In a file
  whose helpers use the tracked `db`, handlers use that one rather than
  shadow it. A split service's method modules export typed method objects,
  whether their parameter is the class or a port of it, read from the
  source: `Pick`, `Omit`, `Partial`, `Readonly` or `Required` of the class
  or of `BaseService<...>` over its method map, through type aliases,
  interfaces, type parameters and intersections. The port type is marked. A
  `defineMethod` call tied to no service is named at its file and line in
  the contract's marker for the method map's unimplemented methods. A
  function that only calls the modules' register functions, or other such
  functions (an aggregator, such as
  `defineQueryMethods(service) { defineGetTarget(service); ... }`), is
  removed with its calls, and so is a file it leaves empty that nothing
  imports; the summary counts the removed aggregators. One that does more
  (a condition, logging, another call) stays under a `[this]` marker that
  names the calls the codemod removed from it, and a register function
  loses its calls of the others the same way.
- **Which class.** A service is read from one class nothing extends, outside
  test code (`__tests__`, `testing`, `*.test.ts(x)`, `*.spec.ts(x)`): of
  several with one service name, the class `registerService` instantiates,
  else the one named after the service; the others are marked `[service]`.
  Test code's 4.x service classes are marked `[service]` and hide nothing;
  its uses of the services are rewritten. A contract whose class implements
  none of its method map is marked `[service]` and named on stderr.
- **Access.** Each method gets the 5.0 form that admits exactly the callers
  4.x admitted:

  | 4.x                                        | 5.0                                  |
  | ------------------------------------------ | ------------------------------------ |
  | `"Public"`                                 | `"public"`                           |
  | any level, with a row id                   | `{ service: L, entry: L, id }`       |
  | `"Read"` without a row id                  | `"authenticated"`, marked for review |
  | `"Moderate"` or `"Admin"` without a row id | `{ service: L }`                     |

  A row id is `resolveEntryId`, or a payload with `id`, which 4.x read
  implicitly. The service's policy is `jsonAcl("acl")` where 4.x set
  `hasEntryACL: true`, with one difference from 4.x, marked once per
  service: a user with several entries in a row's list gets the highest of
  their levels, where 4.x took the first.

- **The web app.** `useService`, `useServiceQuery`, `useSubscription` and
  `useCollection` become `qd.<service>.<member>` hooks, through the app's
  typed wrappers too, which are deleted once nothing calls them, with a file
  of types only they imported. A local type only a rewritten call's type
  arguments named goes, a one-argument `UseCollectionResult<Item>` gets
  5.0's second argument, and an import left holding only types becomes
  `import type`.
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
- **Template carve-outs.** A service whose 4.x code sat between a
  carve-out's comments (`quickdraw-game:start`, `quickdraw-game:end`, around
  its `ServiceMethodsMap` entry) keeps them in `contracts/index.ts`, and its
  new contract file carries a `[carve-out]` marker, so the report lists it
  for the fork script that deletes the carve-out's files. An entity key the
  DTO declares inside a carve-out keeps its comments in the contract.

## What it leaves

Wherever a person has to decide, a marker on its own line above the code
says what to do:

```ts
// quickdraw-migrate: review [emit] hand emit: 5.0 sends entity frames from tracked writes; delete this once the write goes through db
this.emitUpdate(input.id, updated);
```

`quickdraw-migration-report.md`, at the repository root, lists every marker
with its file and line (in the formatted file), grouped by kind: the contracts' placeholders and
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

Running the codemod again changes nothing at all: delete each marker once
its item is done, run it again, and the report lists what remains. Lint
(`@fitzzero/quickdraw-lint`'s `no-v4-api` and `no-todo-schema`) and the
typecheck report the same work; adopt lint on the output with
`quickdraw-lint baseline` and lint with `quickdraw-lint check`, since the
4.x code it keeps for review breaks rules (unused functions) until its
markers are done.

## Development

The tests run the codemod on a 4.1 app laid out like the template
(`test/fixtures/v4-app`, modeled on quickdraw-chat; it typechecks against
the published 4.1.0) and check that the output matches the committed
snapshot (`test/fixtures/v4-app.expected`; `bun run test -u` rewrites it),
that every file it writes parses and puts its markers on lines of their
own, that it typechecks against the built 5.0 core and passes the 5.0 lint
rules apart from what its markers cover, that the report lists every item
of the fixture at its file and line, and that a second run changes nothing
(`test/format.test.ts` runs it with the app's formatter installed, too).
`MIGRATION.md` and `UPGRADE-PROMPT.md` are copies of the repository's, with
their links pointing at GitHub (written by `bun run readme:sync` in
`packages/core`); the guide's appendix of removed names comes from `bun run
guide:sync`.
