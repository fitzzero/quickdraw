---
name: quickdraw-migrate-v5
description: Move a quickdraw 4.x app to quickdraw 5.0 (BaseService classes, ServiceRegistry and useService hooks to contracts, defineService and the typed client) with @fitzzero/quickdraw-codemod and the migration guide. Use when asked to "upgrade quickdraw", "migrate to quickdraw 5", when the repo has a quickdraw-migration-report.md, or when lint reports quickdraw/no-v4-api.
---

# Migrate a quickdraw 4.x app to 5.0

The codemod does the mechanical part; you work through what it marks. The
details of every step are in the migration guide:
`node_modules/@fitzzero/quickdraw-codemod/MIGRATION.md` (or `MIGRATION.md` at
the root of the quickdraw repository). Read its sections as the report sends
you to them.

## Rules

- **Never change who may call a method silently.** The codemod's access forms
  admit exactly the callers 4.x admitted: `"Public"` became `"public"`, a
  method with a row id `{ service: L, entry: L, id }` (never `{ entry: L }`:
  4.x let a service grant pass the row check), `"Read"` without a row id
  `"authenticated"` (marked: 4.x let every signed-in user call it), and
  `"Moderate"` or `"Admin"` without one `{ service: L }`. Change a form only
  as a decision the user agrees to.
- **Keep every service name**: stored grants (`User.serviceAccess`, JSON
  access lists) name them.
- **One step per commit**, lint, typecheck and tests green after each.

## Procedure

1. **Prepare.** A clean tree on a new branch. Node 24, Prisma 7, Zod 3.25 or
   later (4.2 or later where JSON Schema is read: MCP tools, the admin kit,
   projection keys). Upgrade `@fitzzero/quickdraw-core` to 5.0 (`@next` until
   5.0.0 ships) in every package that imports it, add
   `@fitzzero/quickdraw-lint`, `@fitzzero/quickdraw-skills` and `oxlint` as
   dev dependencies, extend `oxlint.base.jsonc`, add `quickdraw-skills link`
   to `prepare`, and add `zod` to the shared package if it lacks it.
2. **Run the codemod** from the repository root, first with `--dry-run`:

   ```bash
   bunx @fitzzero/quickdraw-codemod@next v5 . --dry-run
   bunx @fitzzero/quickdraw-codemod@next v5 .
   ```

   It expects the template's layout (`packages/shared`, `apps/api`,
   `apps/web`, `packages/db`); `--shared`, `--api`, `--web` and
   `--db-package` move each part. Commit its output untouched.

3. **Read `quickdraw-migration-report.md`.** Every item is a
   `// quickdraw-migrate: review [kind] ...` marker above the code it is
   about. Work through it in this order, one commit per step:
   1. **Contracts** (`[contract]`): real schemas for the entity and each
      `todoSchema`; check each method's kind (chosen from its name).
   2. **Access** (`[access]`, `[access-override]`): decide the
      `"authenticated"` forms; port `checkAccess`/`checkEntryACL` overrides
      into the service's policy (`owner`, `jsonAcl`, `members`, `inherit`,
      `anyOf`, `resolver`).
   3. **Emits** (`[emit]`, `[write]`, `[raw-sql]`, `[lifecycle]`,
      `[collection]`, `[projection]`, `[admin]`): write through `db`, declare
      the collections (boards: `index`, `views`, `useCollection`; never a fat
      query with `watch`), delete the hand emits, turn `toDto` and protected
      fields into projections and `fields`, use the admin kit.
   4. **Client** (`[client]`): declare the collections the web app reads,
      settle dropped hook options (`invalidateOn` becomes `watch`), replace
      the 4.x `QuickdrawProvider` props.

   Then `[this]`, `[context]`, `[channel]`, `[server]` and `[v4-api]`:
   instance state, the 4.x context, channels, the server set-up
   (`qd.createServer`, with `legacyWire: true` while 4.x clients remain).

4. **Delete each marker when its item is done**, and run the codemod again:
   it changes no code a second time and rewrites the report from the markers
   left.
5. **Check**: `oxlint` (`no-v4-api` lists every 4.x API left, with its
   replacement; `no-todo-schema` every placeholder), the typecheck, the
   tests, and the running app (a change from a second session arrives
   live).

Done when the report says nothing is left to review and lint, the
typecheck and the tests are clean.
