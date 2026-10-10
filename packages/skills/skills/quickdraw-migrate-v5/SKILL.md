---
name: quickdraw-migrate-v5
description: Move a quickdraw 4.x app to quickdraw 5.0 (BaseService classes, ServiceRegistry and useService hooks to contracts, defineService and the typed client) with @fitzzero/quickdraw-codemod and the migration guide. Use when asked to "upgrade quickdraw", "migrate to quickdraw 5", when the repo has a quickdraw-migration-report.md, or when lint reports quickdraw/no-v4-api.
---

# Migrate a quickdraw 4.x app to 5.0

The codemod does the mechanical part; you work through what it marks. The
details of every step are in the migration guide:
`node_modules/@fitzzero/quickdraw-codemod/MIGRATION.md` (or `MIGRATION.md` at
the root of the quickdraw repository), and the procedure in
`node_modules/@fitzzero/quickdraw-codemod/UPGRADE-PROMPT.md`. Read the
guide's sections as the report sends you to them.

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
- **One step per commit.** Steps 1 and 2 (the upgrade, the codemod) cannot
  leave the typecheck green: commit them anyway, say so in the message, and
  pass a typecheck hook with `--no-verify` for those two only. After step 2
  every file parses, the format check passes, lint passes with its baseline
  and a second codemod run changes nothing; from step 3 on lint and the
  tests stay green and the typecheck errors only go down.

## Procedure

1. **Prepare.** A clean tree on a new branch. Node 24, Prisma 7, Zod 3.25 or
   later (4.2 or later where JSON Schema is read: MCP tools, the admin kit,
   projection keys). Upgrade `@fitzzero/quickdraw-core` to 5.0 in every
   package that imports it, add `@fitzzero/quickdraw-lint`,
   `@fitzzero/quickdraw-skills` and `oxlint` as dev dependencies, extend
   `oxlint.base.jsonc` (a template app: `oxlint.template.jsonc`, which
   extends the base), set
   `settings.quickdraw.baseline` to `.quickdraw-lint-baseline.json`, make the
   lint scripts run `quickdraw-lint check` instead of `oxlint`, add
   `quickdraw-skills link` to `prepare`, and add `zod` to the shared package
   if it lacks it.
2. **Run the codemod** from the repository root, first with `--dry-run`:

   ```bash
   bunx @fitzzero/quickdraw-codemod v5 . --dry-run
   bunx @fitzzero/quickdraw-codemod v5 .
   ```

   It expects the template's layout (`packages/shared`, `apps/api`,
   `apps/web`, `packages/db`); `--shared`, `--api`, `--web` and
   `--db-package` move each part. It formats its output with the app's
   formatter. Commit its output untouched, then run
   `quickdraw-lint baseline -c .oxlintrc.json` and commit the baseline, so
   lint passes and reports only new violations. Add each file the report
   lists under "Carve-outs" to the template's carve-out script
   (`scripts/strip-game.mjs`'s delete list).

3. **Read `quickdraw-migration-report.md`.** Every item is a
   `// quickdraw-migrate: review [kind] ...` marker above the code it is
   about. Work through it in this order, one commit per step:
   1. **Contracts** (`[contract]`): real schemas for the entity and each
      `todoSchema`; check each method's kind (chosen from its name). The
      codemod writes no `describe` (4.x had no per-method prose): write one
      for the contract and each method, collection, stream, channel and
      event, which lint's `require-describe` lists. MCP tools and the API
      docs read them.
   2. **Access** (`[access]`, `[access-override]`): decide the
      `"authenticated"` forms and the `rowless: true` flags (keep one only
      for a lookup open to anyone; else an `entry` form); port
      `checkAccess`/`checkEntryACL` overrides into the service's policy
      (`owner`, `jsonAcl`, `members`, `inherit`, `everyone`, `anyOf`, `resolver`).
   3. **Emits** (`[emit]`, `[write]`, `[raw-sql]`, `[lifecycle]`,
      `[collection]`, `[projection]`, `[admin]`, `[kit]`): write through
      `db`, declare the collections (boards: `index`, `views`,
      `useCollection`; never a fat query with `watch`), delete the hand
      emits, turn `toDto` and protected fields into projections and
      `fields`, use the admin kit, and move each method a kit implements to
      its kit (or keep it with `// quickdraw: hand-written because ...`).
   4. **Client** (`[client]`): declare the collections the web app reads,
      settle dropped hook options (`invalidateOn` becomes `watch`), replace
      the 4.x `QuickdrawProvider` props.

   Then `[this]`, `[context]`, `[error]`, `[channel]`, `[server]` and
   `[v4-api]`: instance state, the 4.x context, `throw new Error(message)`
   in handlers (5.0 answers it with a generic `INTERNAL`: throw
   `QuickdrawError(code, message)` where the caller should see the message),
   channels, the server set-up (`qd.createServer`, with `legacyWire: true`
   while 4.x clients remain).
   A hand-built sign-in (unmarked: the codemod leaves it) moves onto the
   auth routes kit last, with its `Session` table migration (MIGRATION.md,
   "Hand-built auth to the auth routes kit").

4. **Delete each marker when its item is done**, and run the codemod again:
   it changes no code a second time and rewrites the report from the markers
   left. Run `quickdraw-lint baseline` again when `no-unused-baseline` warns.
5. **Check**: `quickdraw-lint check` (`no-v4-api` lists every 4.x API left,
   with its replacement; `no-todo-schema` every placeholder; `prefer-kit`
   every hand-written method a kit implements; `require-describe` every
   member without a `describe`), the typecheck, the tests,
   and the running app (a change from a second session arrives live).

Done when the report says nothing is left to review, lint is clean without
a baseline, and the typecheck and the tests are clean.
