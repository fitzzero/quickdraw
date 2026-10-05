# Downstream upgrade briefs

One brief per app that uses quickdraw: its size, its top hazards and a
suggested order of work, each under a page. Each app's migration card, on
that app's own Conveyor project, is drafted from its brief; nothing here
migrates an app. The procedure every app follows is
[`MIGRATION.md`](../../MIGRATION.md) (for an agent,
[`UPGRADE-PROMPT.md`](../../UPGRADE-PROMPT.md)), and quickdraw-chat's
migration is the worked example ([quickdraw-chat.md](quickdraw-chat.md)).

The figures come from the consumer audit of 2026-10-02 behind
[`docs/rfcs/0003-v5-audit.md`](../rfcs/0003-v5-audit.md), except
quickdraw-chat's, from its migration. Apps keep changing: every migration
card recounts first, with the codemod's dry run.

## Order

| Order | App               | On    | Services    | Methods     | Collections, channels  | Brief                                        |
| ----- | ----------------- | ----- | ----------- | ----------- | ---------------------- | -------------------------------------------- |
| done  | quickdraw-chat    | 5.0.0 | 7           | 31          | 2, 1                   | [quickdraw-chat.md](quickdraw-chat.md)       |
| 1     | seneschal         | 4.1.0 | 5           | 22          | not counted            | [seneschal.md](seneschal.md)                 |
| 2     | x-tokage-siege    | 4.1.0 | 9           | 58          | 7, 1                   | [x-tokage-siege.md](x-tokage-siege.md)       |
| 3     | foundation        | 4.1.0 | 18          | 136         | 13, not counted        | [foundation.md](foundation.md)               |
| 4     | farseer           | 4.1.0 | 22          | 279         | none, not counted      | [farseer.md](farseer.md)                     |
| 5     | Conveyor          | 4.1.0 | about 31    | about 658   | not counted            | [conveyor.md](conveyor.md)                   |
| stays | makiel            | 3.7   | not counted | not counted | mostly streams and RPC | [makiel.md](makiel.md)                       |
| stays | quickdraw-sunfall | 3.9.1 | not counted | not counted | looks dormant          | [quickdraw-sunfall.md](quickdraw-sunfall.md) |

quickdraw-chat went first, alone, as the release gate: it migrated on the
release candidates, and everything awkward it found was fixed in quickdraw
before 5.0.0, so every app after it starts from a corrected framework and a
worked example. seneschal does not migrate: it re-forks from the migrated
template and ports its own features (an owner decision, 2026-10-04).
Conveyor goes last: it waited for 5.0 (an owner decision) and reshapes its
board-load pack around its brief. makiel and quickdraw-sunfall stay on 3.x
(an owner decision, 2026-10-04): the codemod reads 4.x code, and their
briefs say what staying takes.

## What every app does

1. **Prerequisites.** Node 24, Prisma 7, React 19, Socket.IO 4.8, Zod 3.25
   or later (4.2 or later where 5.0 reads JSON Schema: MCP tools, the admin
   kit, projection keys, output schemas, `quickdraw-docs`; quickdraw-chat
   moved its shared package and api to Zod 4 first), and a clean tree on a
   new branch. An app that stays on 4.x for a while takes 4.1.1 once it is
   on npm (the socket rate limiter crash fix, on the `release/4.x` branch;
   it goes out under the `latest-4` dist-tag, and a `^4.1.0` range takes
   it with `bun update @fitzzero/quickdraw-core`).
2. **Upgrade the packages**: `@fitzzero/quickdraw-core` in every package
   that imports it; `@fitzzero/quickdraw-lint`, `@fitzzero/quickdraw-skills`
   and `oxlint` as dev dependencies; `zod` in the shared package. 5.0.0 is
   npm's `latest` for all four packages since 2026-10-05, so `bun add`
   with no version takes it; the template declares `^5.0.0`.
3. **Run the codemod**, a dry run first, and commit its output as it is:
   `bunx @fitzzero/quickdraw-codemod v5 .` (with `--shared`, `--api`,
   `--web` or `--db-package` for another layout). It keeps class fields,
   getters and constructor work as marked module bindings and a
   `setUp<Service>` function, formats with the app's formatter (a second
   run changes nothing), keeps template carve-outs (`[carve-out]`), and
   marks every decision: `[error]` where 4.x sent a thrown `Error`'s
   message, `[kit]` where a kit implements a method, `rowless: true` where
   a method that named a row now checks none, each access form.
4. **Adopt lint at once, with a baseline**: extend `oxlint.base.jsonc`
   (`oxlint.template.jsonc` in an app built from the template), run
   `quickdraw-lint baseline`, lint with `quickdraw-lint check` from then
   on, delete the local rules the package supersedes, and add
   `quickdraw-skills link` to the root `prepare` script.
5. **Work through the report**, `quickdraw-migration-report.md`, one commit
   per step: contracts, access, emits, client, then the rest (instance
   state, server wiring, room events). Never change who may call a method
   without saying so in the commit; an access matrix per service
   (`describeAccessMatrix`) pins every decision.
6. **Run its tests**, then the app by hand: sign in, open a live list,
   change a row from a second session and watch it arrive, go offline and
   come back.
7. **Record budgets** with `expectBudget` for its hot paths (the main
   screen's first load, a write with subscribers, the busiest list).
8. **Ship without a flag day** when other clients exist (mobile, agents,
   scripts): the server with `legacyWire: true`, then the clients, then the
   shim removed once its log names no 4.x caller (it serves calls only).

## Hazards every app shares

- **Access is closed.** A 4.x `"Read"` method with no row id becomes a
  marked `"authenticated"` form, each a decision; a method taking an `id`
  under a form that checks no row is refused at startup unless it says
  `rowless: true`; rows every signed-in user may read are a policy
  (`anyOf(owner("id"), everyone("Read"))` for public profiles).
- **A missing row**: a write throws `NOT_FOUND` where `this.update`
  returned `null`, and no lifecycle hook runs; a subscribe or an `{ entry }`
  method answers `FORBIDDEN`. An error that is not a `QuickdrawError`
  reaches the caller as `INTERNAL`.
- **Outputs are sent as declared**: an output schema of the method's own
  keeps only what it declares, and a tiered field in one stops a strict
  test app (`tiered-field-in-output`): answer `"entity"` or a projection.
- **Writes signal what they change**: one that matched no row or has
  nothing to write sends nothing, one that sets a value the row already
  held does signal (re-ensure with `upsert({ where, create, update: {} })`),
  raw SQL and nested writes need `ctx.touch`. A count read from a junction
  needs `refreshEntry: true` on its `via`; a query over a model no service
  owns watches its writer's topic, narrowed by model
  (`watch: { service: ["gameScore"] }`).
- **Sign-in moves to the auth routes kit** (`MIGRATION.md`, "Hand-built
  auth to the auth routes kit"): everyone signs in once (tokens carry
  `sid`); the client's `getOAuthUrl`, `logout` and `logoutAllDevices` are
  `signInUrl`, `signOut` and `signOutEverywhere`; a login page lists what
  `GET /auth/providers` serves (`authProviders()`).
- **Cookies and origins**: `__Host-session` over HTTPS, `SameSite=Lax` by
  default (a web app and an API on two sites need one site or
  `sameSite: "none"`); a cookie from a page outside `allowedOrigins` is
  refused on sockets, `/qd` calls and `requireSession` routes (give
  `requireSession` the same session store object as the auth routes, or
  its own `allowedOrigins`: two stores over one table share no list);
  there is no default CORS origin, and the socket rate limiter is on (600
  events per minute per socket).
- **Rooms are per socket**: joined by a method, lost on every reconnect.
  Re-join with `useJoin` (`connection.onHello` outside React); reach rooms
  outside handlers with `qd.rooms` (`rooms.leave(room, { userId })`), and
  clean up in `onRoomLeave`.
- **Optimistic adds** (`cache.addItem`, `onRefused: "keep"`): a call whose
  outcome is unknown stays `checking`, and `retry()` is safe only with an
  id the client made and the server keeps: `newId()` from `./client` (a
  UUID, on plain-http pages too), accepted as an optional `id` by the
  contract and written by the create, an existing id answered `CONFLICT`
  (the template's `postMessage`).
- **Revisions are microseconds** since the epoch: compare them as numbers.
  A non-JS client follows `docs/protocol-v5.md` (positional `qd:event` and
  `qd:stream`, unknown fields and trailing elements ignored).
- **A board** ported as one fat watched query sends nearly as many bytes as
  4.1 (the benchmark's one missed target): port it to a collection with
  `index` and `views` (`MIGRATION.md`, "Boards").
