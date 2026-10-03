# @fitzzero/quickdraw-lint

The quickdraw oxlint plugin and the configs every quickdraw 5.0 app extends
(design: `docs/rfcs/0003-v5.md`, section 14). The rules catch the mistakes
that matter with the 5.0 API: writes subscribers never see, frames sent by
hand, reads that grow with the table, bypassing the typed client, and 4.x
calls that no longer exist. Every rule is tested, and every rule can be
adopted without fixing old code first (baselines, below).

```bash
bun add -d @fitzzero/quickdraw-lint oxlint
```

```jsonc
// .oxlintrc.json in your app
{
  "extends": [
    "./node_modules/@fitzzero/quickdraw-lint/oxlint.base.jsonc",
    // apps built from the quickdraw template: the design-system rules
    "./node_modules/@fitzzero/quickdraw-lint/oxlint.template.jsonc",
  ],
  // plugins, ignorePatterns, env, globals and settings are not inherited
  "plugins": ["typescript", "import", "react", "nextjs", "jsx_a11y"],
  "ignorePatterns": ["**/dist/**", "**/node_modules/**"],
}
```

The configs load the plugin through a path relative to themselves, so an app
needs no `jsPlugins` entry of its own. The comment at the top of
`oxlint.base.jsonc` lists what an extending config inherits. The plugin runs
on oxlint 1.52 or later.

## Rules

Every rule is syntactic: oxlint's JS plugins see one file's syntax and no
types. Where a rule has to guess, it prefers missing a case to reporting
correct code; each rule's file says what it leaves alone.

| Rule                                                                           | Reports                                                                                                                                                                          | Checks by default      |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `no-untracked-write`                                                           | importing the untracked Prisma client (`prisma`, `PrismaClient` from the app's db package, `@prisma/client` or the generated client) and writing through a client named `prisma` | services, jobs, routes |
| `no-foreign-write`                                                             | a write to a model that the enclosing `defineService` neither owns (`model`) nor lists in `writes`                                                                               | everywhere             |
| `no-nested-write`                                                              | a nested relation write (`data: { labels: { create } }`) through the tracked client (`db`, `tx`): only the parent row is tracked                                                 | everywhere             |
| `no-raw-sql-write`                                                             | `$executeRaw*`, and `$queryRaw*` running a write, in a function that does not record the rows with `ctx.touch(...)` (or `qd.collections.reset(...)`)                             | services, jobs, routes |
| `no-manual-emit`                                                               | `.emit()` on the Socket.IO server or a socket (`io.to(room).emit`), and `qd:` strings, the framework's event and room names                                                      | services, jobs, routes |
| `no-inline-auth-guard`                                                         | `if (!ctx.principal) throw ...` and its variants inside a `handler`; declare `access` instead                                                                                    | everywhere             |
| `no-unbounded-read`                                                            | `findMany` without `take` (a read by `id` is bounded by its ids)                                                                                                                 | services               |
| `no-db-call-in-loop`                                                           | an awaited database call once per item of a `for`/`for...of`/`for...in` loop or a `.map`/`.forEach` callback (not batched `while` loops, `createMany`, or `in:` filters)         | services, jobs, routes |
| `no-emit-in-loop`                                                              | `ctx.rooms.emit`, `emitToUser` or a stream's `push` once per item to the same room, user or stream scope (fan-out to different targets is fine)                                  | services, jobs, routes |
| `no-load-then-filter`                                                          | `findMany` whose rows are only `.filter`ed or `.find`-ed by a condition a `where` could express                                                                                  | services, jobs, routes |
| `no-prisma-in-routes`                                                          | model calls on the Prisma client in route handlers                                                                                                                               | routes                 |
| `no-cross-service-internal-imports`                                            | importing another service directory's files other than its index                                                                                                                 | services               |
| `no-await-void-mutate`                                                         | `await mutation.mutate(...)`: `mutate` returns nothing; use `mutateAsync`                                                                                                        | client code            |
| `no-untyped-client`                                                            | a TanStack Query hook whose `queryFn`/`mutationFn` calls quickdraw by hand, or whose `queryKey` is a quickdraw key                                                               | client code            |
| `no-manual-refetch`                                                            | a quickdraw query's `refetch()` right after (or in the callbacks of) a quickdraw mutation, and `invalidateQueries`/`refetchQueries`/`resetQueries` on a quickdraw key            | client code            |
| `no-raw-socket`                                                                | `socket.emit`, `socket.on`, `socket.off` and the other raw Socket.IO calls                                                                                                       | client code            |
| `no-v4-api`                                                                    | every 4.x API 5.0 removed or moved; each message names the replacement                                                                                                           | everywhere             |
| `no-raw-button-strings`, `no-raw-tooltip-strings`, `no-raw-typography-strings` | raw strings in MUI `Button`, `Typography` and `Tooltip` titles (`oxlint.template.jsonc`)                                                                                         | `*.tsx`, `*.jsx`       |

The base config turns on all but the last three, at `error`.

### Which files a rule checks

A rule about one layer checks only that layer's files. The defaults follow the
template's layout. The rules scoped to services, jobs and routes, and
`no-raw-socket`, skip tests (`__tests__/`, `test/`, `tests/`, `*.test.*`,
`*.spec.*`), which seed, inspect and probe on purpose; the other rules check
tests too.

| Layer       | Globs                                    |
| ----------- | ---------------------------------------- |
| services    | `**/services/**`                         |
| jobs        | `**/jobs/**`                             |
| routes      | `**/routes/**`, `**/routes.*`            |
| client code | `**/*.tsx`, `**/*.jsx`, `**/apps/web/**` |

Every file-scoped rule takes `files` and `ignore` globs, matched against the
path relative to where oxlint runs (keep them `**/`-prefixed):

```jsonc
{
  "rules": {
    "quickdraw/no-unbounded-read": ["error", { "files": ["**/server/services/**"] }],
  },
}
```

Other options: `clients` (the names the database client goes by: `["db",
"tx"]` for the write rules, plus `prisma` for the read rules) on the rules
that look at database calls; `modules` (specifiers of the untracked client's
modules) on `no-untracked-write`; `emitters` on `no-manual-emit`; `sockets`,
`allowedEvents` and `allowedPrefixes` on `no-raw-socket`; `clients` (the typed
client's names, `["qd"]`) on `no-untyped-client` and `no-manual-refetch`;
`shared` and `allow` (`{ "<service>": ["<service>/<file>"] }`) on
`no-cross-service-internal-imports`. Each rule's options are in its schema,
so a misspelled option fails oxlint at startup.

## Baselines

An app adopts the rules without fixing every existing violation first:

```bash
bunx quickdraw-lint baseline            # writes .quickdraw-lint-baseline.json
```

```jsonc
// .oxlintrc.json: every quickdraw rule reads the file
{
  "settings": { "quickdraw": { "baseline": ".quickdraw-lint-baseline.json" } },
}
```

`quickdraw-lint baseline` runs oxlint with your config (`-c` to pick one;
paths after the options, the current directory by default) and records how
many times each quickdraw rule reports in each file. A rule given the file
reports nothing in a file until the file holds more violations than recorded,
and then only the ones beyond the count (the last ones in the file). Commit
the file; run the command again after fixing old violations so the counts go
down. A single rule takes the file as an option instead of the setting:
`["error", { "baseline": ".quickdraw-lint-baseline.json" }]`. A relative path
is looked up from each linted file's directory upwards, so one file at the
repository root also serves lint runs started from package directories.

```json
{
  "version": 1,
  "files": {
    "apps/api/src/services/task.ts": { "no-unbounded-read": 2 }
  }
}
```

## From the 4.1 rules

The 4.1 rules were moved here unchanged before 5.0; 5.0 replaces them. A
config that still names a removed rule fails to load, so drop these names
from your overrides:

| 4.1 rule                                                                       | 5.0                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `no-cross-service-mutations`                                                   | `no-foreign-write`: owners come from `defineService`'s `model` and `writes`, so there is no allowlist to keep |
| `no-direct-prisma-mutations`                                                   | `no-untracked-write` (there is no `this.create` to prefer: write through `db`)                                |
| `no-manual-collection-events`                                                  | `no-manual-emit` (collections derive their deltas from tracked writes)                                        |
| `no-raw-socket-emit`, `no-raw-socket-on`                                       | `no-raw-socket`, with no app-specific default exemptions                                                      |
| `no-raw-service-room-string`                                                   | removed: entity and collection rooms belong to the framework (`no-manual-emit` reports `qd:` names)           |
| `require-zod-schema`                                                           | removed: every contract method declares `input` and `output`                                                  |
| `no-service-method-record`, `no-unsafe-payload-cast`                           | removed: there are no service classes or `defineMethod` generics; inputs are typed by the contract            |
| `no-raw-button-strings`, `no-raw-tooltip-strings`, `no-raw-typography-strings` | unchanged, moved to `oxlint.template.jsonc`                                                                   |

## Developing

`bun run --filter @fitzzero/quickdraw-lint test` runs every rule's cases
under oxlint's own `RuleTester` (`oxlint/plugins-dev`: oxlint's parser and
plugin runtime, in vitest), and `plugin/test/oxlint.test.mjs` runs the oxlint
CLI with the shipped configs: every rule must report its example there, the
core package's fixture apps must pass the rules that judge service
definitions, and the baseline command must round-trip. The plugin's `.mjs`
files ship as they are; there is no build.
