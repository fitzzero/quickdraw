# Upgrade to quickdraw 5.0

Paste this file to a coding agent (or follow it yourself) to move an app from
quickdraw-core 4.x to 5.0. The details of every step are in
[`MIGRATION.md`](MIGRATION.md) (also shipped as
`node_modules/@fitzzero/quickdraw-codemod/MIGRATION.md`); this page is the
procedure.

5.0 rebuilds what a 4.x app is written against: `BaseService` classes become
`qd.defineService(contract, { ... })` objects over contracts in the shared
package, access is declared per method, frames and deltas follow tracked
writes, and the web app calls a typed client. A codemod does the mechanical
part and marks everything that needs a decision.

## Rules

- **Never change who may call a method silently.** The codemod's access forms
  admit exactly the callers 4.x admitted. Change one only as a decision the
  person you work for agrees to, and say so in the commit.
- **Keep every service name** (`"taskService"`): stored grants in
  `User.serviceAccess` and JSON access lists name them.
- **Leave `todoSchema` only where you cannot write the schema yet.** It
  validates nothing; lint's `no-todo-schema` lists every one.
- **One step per commit**, with lint, typecheck and tests green at the end of
  each step, so a reviewer can follow the migration.

## 1. Prepare

1. Start from a clean working tree on a new branch.
2. Check the prerequisites in `MIGRATION.md` ("Before you start"): Node 24,
   Prisma 7, Zod 3.25 or later (4.2 or later for MCP tools, the admin kit and
   projection keys).
3. Upgrade the packages:

   ```bash
   bun add @fitzzero/quickdraw-core@next      # in every package that imports it
   bun add -d @fitzzero/quickdraw-lint@next @fitzzero/quickdraw-skills@next oxlint
   ```

   Add `zod` to the shared package's dependencies if it has none. Extend
   `@fitzzero/quickdraw-lint`'s `oxlint.base.jsonc` from the app's
   `.oxlintrc.json`, and add `quickdraw-skills link` to the root `prepare`
   script (`MIGRATION.md`, "Lint, skills and agents").

## 2. Run the codemod

```bash
bunx @fitzzero/quickdraw-codemod@next v5 . --dry-run   # read what it would change
bunx @fitzzero/quickdraw-codemod@next v5 .
```

Commit its output as it is, before changing anything by hand, so the review
can tell the codemod's changes from yours.

## 3. Read the report

`quickdraw-migration-report.md` at the repository root lists every
`// quickdraw-migrate: review [kind] ...` marker the codemod left, with its
file and line, grouped by kind. Each marker sits above the code it is about
and says what to do. Work through it in this order, one commit per step:

1. **Contracts** (`[contract]`): give the entity and every `todoSchema` a real
   schema, and check each method's kind (a query only reads).
2. **Access** (`[access]`, `[access-override]`): decide each `"authenticated"`
   form (4.x let every signed-in user call a `"Read"` method that named no
   row) and each `rowless: true` (a `"Public"` method that named a row: keep
   it for a lookup open to anyone, else give the method an `entry` form),
   and port each `checkAccess` or `checkEntryACL` override into the
   service's `access` policy (`owner`, `jsonAcl`, `members`, `inherit`,
   `anyOf`, `resolver`).
3. **Emits** (`[emit]`, `[write]`, `[raw-sql]`, `[lifecycle]`, `[collection]`,
   `[projection]`, `[admin]`, `[kit]`): write through `db` instead of
   `this.create/update/delete`, declare each 4.x collection in its contract
   (boards with `index` and `views`; `MIGRATION.md`, "Boards"), then delete
   the hand emits; turn `toDto` and protected fields into projections and
   `fields`; replace `installAdminMethods` with the admin kit, and move each
   method a kit implements to its kit (or keep it with a
   `// quickdraw: hand-written because <reason>` comment above it).
4. **Client** (`[client]`): declare the collections the web app reads, settle
   the hook options 5.0 dropped (`invalidateOn` becomes a contract `watch`),
   and replace the 4.x `QuickdrawProvider` props.

Then the rest (`[this]`, `[context]`, `[channel]`, `[server]`, `[v4-api]`):
instance state, the 4.x context, channels, and the server set-up
(`qd.createServer`; keep 4.x clients working with `legacyWire: true` while
they update, `MIGRATION.md`, "Running 4.x and 5.0 clients together").

Delete each marker when its item is done, and run the codemod again: it
changes no code a second time, and rewrites the report from the markers that
remain.

## 4. Check

- `oxlint`: `no-v4-api` names every 4.x API that is left, with its
  replacement; `no-todo-schema` every placeholder; `prefer-kit` every
  hand-written method a kit implements that does not say why.
- The typecheck: the codemod's output typechecks against 5.0 apart from what
  its markers cover, so what fails is the work that is left.
- The tests, and the app itself: sign in, open a board, change a row from a
  second session and watch it arrive.

Done when the report says nothing is left to review, lint and the typecheck
are clean, and the tests pass.
