# Downstream upgrade briefs

One brief per app that uses quickdraw: its size, its top hazards and a
suggested order of work, each under a page. Each app's migration card, on
that app's own Conveyor project, is drafted from its brief; nothing here
migrates an app. The procedure every app follows is
[`MIGRATION.md`](../../MIGRATION.md) (for an agent,
[`UPGRADE-PROMPT.md`](../../UPGRADE-PROMPT.md)).

The figures come from the consumer audit of 2026-10-02 behind
[`docs/rfcs/0003-v5-audit.md`](../rfcs/0003-v5-audit.md), except
quickdraw-chat's codemod counts, from a dry run on 2026-10-03. Apps keep
changing: every migration card recounts before it starts.

## Order

| Order | App               | On    | Services    | Methods     | Collections, channels  | Brief                                        |
| ----- | ----------------- | ----- | ----------- | ----------- | ---------------------- | -------------------------------------------- |
| 1     | quickdraw-chat    | 4.1.0 | 7           | 31          | 2, 1                   | [quickdraw-chat.md](quickdraw-chat.md)       |
| 2     | seneschal         | 4.1.0 | 5           | 22          | not counted            | [seneschal.md](seneschal.md)                 |
| 3     | x-tokage-siege    | 4.1.0 | 9           | 58          | 7, 1                   | [x-tokage-siege.md](x-tokage-siege.md)       |
| 4     | foundation        | 4.1.0 | 18          | 136         | 13, not counted        | [foundation.md](foundation.md)               |
| 5     | farseer           | 4.1.0 | 22          | 279         | none, not counted      | [farseer.md](farseer.md)                     |
| 6     | Conveyor          | 4.1.0 | about 31    | about 658   | not counted            | [conveyor.md](conveyor.md)                   |
| last  | makiel            | 3.7   | not counted | not counted | mostly streams and RPC | [makiel.md](makiel.md)                       |
| last  | quickdraw-sunfall | 3.9.1 | not counted | not counted | looks dormant          | [quickdraw-sunfall.md](quickdraw-sunfall.md) |

quickdraw-chat goes first, alone: it is the template the others were copied
from, and 5.0.0 is released only after it runs on the release candidate
([`release-checklist-5.0.md`](../release-checklist-5.0.md)). Anything
awkward there is a framework bug, fixed before release, so every app after
it starts from a corrected framework and a worked example. Conveyor goes
last: it waits for 5.0 (an owner decision) and reshapes its board-load pack
around its brief. makiel and quickdraw-sunfall are on 3.x and the codemod
reads 4.x code, so each needs a decision first: migrate, or stay on 3.x.

## What every app does

1. **Prerequisites.** Node 24, Prisma 7, Zod 3.25 or later (4.2 or later
   where 5.0 reads JSON Schema: MCP tools, the admin kit, projection keys,
   `quickdraw-docs`), and a clean tree on a new branch. An app that stays on
   4.x for a while takes 4.1.1 first, the socket rate limiter crash fix.
2. **Upgrade the packages** from the `next` dist-tag:
   `@fitzzero/quickdraw-core` in every package that imports it;
   `@fitzzero/quickdraw-lint`, `@fitzzero/quickdraw-skills` and `oxlint` as
   dev dependencies; `zod` in the shared package.
3. **Run the codemod**, a dry run first, and commit its output as it is:
   `bunx @fitzzero/quickdraw-codemod@next v5 .` (with `--shared`, `--api`,
   `--web` or `--db-package` for a layout other than the template's).
4. **Work through the report**, `quickdraw-migration-report.md`, one commit
   per step: contracts, access, emits, client, then the rest (instance
   state, server wiring, room events). Never change who may call a method
   without saying so in the commit.
5. **Adopt the lint and skills packages.** Extend `oxlint.base.jsonc` (and
   `oxlint.template.jsonc` in an app built from the template), write a
   baseline with `quickdraw-lint baseline` to adopt the rules before every
   old violation is fixed, delete the local rules the package supersedes,
   and add `quickdraw-skills link` to the root `prepare` script.
6. **Run its tests**: the typecheck, lint (`no-v4-api` and `no-todo-schema`
   clean), its own suites, then the app by hand: sign in, open a live list,
   change a row from a second session and watch it arrive.
7. **Record budgets** with `expectBudget` for its hot paths (the main
   screen's first load, a write with subscribers, the busiest list) and
   commit the `__budgets__/` snapshots.
8. **Ship without a flag day** when other clients exist (mobile, agents,
   scripts): the server with `legacyWire: true`, then the clients, then
   remove the shim once its log names no 4.x caller. The shim serves calls
   only, not subscriptions, collections or channels.

## Hazards every app shares

- Access is closed. A 4.x `"Read"` method with no row id was open to every
  signed-in user; the codemod keeps that as a marked `"authenticated"`, and
  each one is a decision.
- An error that is not a `QuickdrawError` reaches the caller as `INTERNAL`
  with a generic message.
- `db.<model>.update` throws `NOT_FOUND` where `this.update` returned
  `null`, and no lifecycle hook runs.
- There is no default CORS origin, and the socket rate limiter is on (600
  events per minute per socket; subscription events, channels and cancels
  are not counted).
- Moving sign-in to `createAuthRoutes` and `socketAuth` signs everyone out
  once: their tokens carry a session id (`sid`), and 4.x tokens do not.
- A board ported as one fat watched query sends nearly as many bytes as
  4.1 (the benchmark's one missed target): port it to a collection with
  `index` and `views` (`MIGRATION.md`, "Boards").
