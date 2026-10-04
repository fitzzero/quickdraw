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
| `no-unbounded-read`                                                            | `findMany` without `take` (a read by ids, `id` equal, `{ in }` or `{ equals }`, is bounded; `{ not }`, `{ notIn }` and `{ gt }` are not)                                         | services               |
| `no-db-call-in-loop`                                                           | a database call per item of a `for`/`for...of`/`for...in` loop or `.map` callback, awaited or sent to `Promise.all` (not `while`, `createMany`, `in:` its own set, `tx` writes)  | services, jobs, routes |
| `no-emit-in-loop`                                                              | `ctx.rooms.emit`, `emitToUser` or a stream's `push` once per item to the same room, user or stream scope (fan-out is fine; batch with `pushMany`)                                | services, jobs, routes |
| `no-load-then-filter`                                                          | `findMany` whose rows are only `.filter`ed or `.find`-ed by a condition a `where` could express                                                                                  | services, jobs, routes |
| `no-prisma-in-routes`                                                          | model calls on the Prisma client in route handlers                                                                                                                               | routes                 |
| `no-cross-service-internal-imports`                                            | importing another service directory's files other than its index                                                                                                                 | services               |
| `no-await-void-mutate`                                                         | `await mutation.mutate(...)`: `mutate` returns nothing; use `mutateAsync`                                                                                                        | client code            |
| `no-untyped-client`                                                            | a TanStack Query hook whose `queryFn`/`mutationFn` calls quickdraw by hand, or whose `queryKey` is a quickdraw key (hooks the client lacks may use a member's `key` and `call`)  | client code            |
| `no-manual-refetch`                                                            | a quickdraw query's `refetch()` right after (or in the callbacks of) a quickdraw mutation, and `invalidateQueries`/`refetchQueries`/`resetQueries` on a quickdraw key            | client code            |
| `no-raw-socket`                                                                | `socket.emit`, `socket.on`, `socket.off` and the other raw Socket.IO calls                                                                                                       | client code            |
| `no-v4-api`                                                                    | every 4.x API 5.0 removed or moved; each message names the replacement                                                                                                           | everywhere             |
| `no-unused-baseline`                                                           | an allowance in the baseline file that no violation uses any more (below)                                                                                                        | baselined files        |
| `no-raw-button-strings`, `no-raw-tooltip-strings`, `no-raw-typography-strings` | raw strings in MUI `Button`, `Typography` and `Tooltip` titles (`oxlint.template.jsonc`)                                                                                         | `*.tsx`, `*.jsx`       |

The base config turns on all but the last three, at `error`, except
`no-unused-baseline`, which warns.

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

Client code is also any file that imports `@tanstack/react-query`,
`socket.io-client` or `@fitzzero/quickdraw-core/client`, so a hook in a
`.ts` file is checked wherever oxlint runs from, the app root or `apps/web`
alike; for the client rules the globs add files on top of those.

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
paths after the options, the current directory by default) and records a
fingerprint for every quickdraw violation: the rule, the file, and a hash of
the violating line's trimmed text. A rule given the file reports a violation
only when its fingerprint is not recorded, or occurs more often than
recorded. So fixing an old violation and adding a new one in the same file
reports the new one, at its line, while edits elsewhere in the file (which
move lines without changing them) disturb nothing. A violation that a disable
comment covers is not recorded and uses no allowance. Commit the file.

When a recorded violation is fixed, its allowance is left unused, and
`no-unused-baseline` warns at the top of the file; run the command again so
the file shrinks and nothing new can take the allowance's place. A single
rule takes the file as an option instead of the setting:
`["error", { "baseline": ".quickdraw-lint-baseline.json" }]`. A relative path
is looked up from each linted file's directory upwards, so one file at the
repository root also serves lint runs started from package directories.

```json
{
  "version": 2,
  "files": {
    "apps/api/src/services/task.ts": {
      "no-unbounded-read": { "5d41402abc4b2a76": 1, "7d793037a0760186": 2 }
    }
  }
}
```

A version 1 file (counts per file, from an earlier 5.0 prerelease) is
refused with a message saying to write it again with the command.

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
