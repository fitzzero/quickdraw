# @fitzzero/quickdraw-skills

Agent rules and skills for quickdraw 5.0 apps, and the `quickdraw-skills link`
command that wires them into an app's `.claude/` directory. Every app reads
the same guidance, written against the API as built, and it updates with
the package instead of drifting per app.

```bash
bun add -d @fitzzero/quickdraw-skills
```

```jsonc
// package.json
{
  "scripts": {
    "prepare": "quickdraw-skills link",
  },
}
```

Add the package to the repo's root `package.json`, so it installs at
`node_modules/@fitzzero/quickdraw-skills` and the links stay the same
whatever the version.

## What it links

| Link                                   | What it holds                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------- |
| `.claude/rules/quickdraw-services.md`  | contracts, `defineService`, tracked writes, derived frames, `affects`, `ctx.touch`, kits |
| `.claude/rules/quickdraw-access.md`    | access forms, row policies, service grants, failing closed, one policy on every surface  |
| `.claude/rules/quickdraw-client.md`    | the typed client, live entities and collections, views, optimistic mutations, `watch`    |
| `.claude/rules/quickdraw-testing.md`   | `createTestApp`, access matrices, budgets, strict warnings, component tests              |
| `.claude/skills/quickdraw-new-service` | adding a service end to end: contract, service, registration, client, tests              |
| `.claude/skills/quickdraw-migrate-v5`  | moving a 4.x app to 5.0 (a stub until the 5.0 migration guide ships)                     |

Each rule's `paths` frontmatter follows the quickdraw template's layout
(`apps/api`, `apps/web`, `packages/shared`), so Claude Code loads it while
working on matching files.

## The command

- `quickdraw-skills link` writes each link as a relative symlink into
  `node_modules/@fitzzero/quickdraw-skills` (or into the package wherever it
  is installed, when it is not at the repo root) in the nearest directory
  above the working directory that holds `.git`. It replaces or prunes only
  links that point into this package: a real file or directory, or another
  package's link, is left alone with a warning, even under one of this
  package's names. That is how an app keeps its own version of a rule
  (with different `paths`, say): replace the link with a copy.
- `quickdraw-skills link --check` changes nothing and exits 1 when a link is
  missing, stale (points elsewhere) or dangling, or when a link to a rule or
  skill the package no longer ships is left; run it in CI.

Commit the links. They are dead on a fresh clone, come alive at the first
install, and always show the installed version's text. Claude Code skips a
broken link.
