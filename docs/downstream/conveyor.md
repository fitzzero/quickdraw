# Conveyor: upgrade brief

On 4.1.0. By far the largest app, and last in line: it waited for 5.0 (an
owner decision, with no 4.2 stopgap), and its own board-load pack is
reshaped around this brief. Plan the migration as several packs.

## Size

About 31 services and 658 methods (the audit of 2026-10-02). About 734 raw
Prisma writes (605 in services, 129 more in 37 `$transaction` blocks)
against about 51 through the framework, and 77 hand emits to delete; 24
`checkEntryACL` and 16 `checkBatchSubscriptionAccess` overrides, 67 inline
`checkProjectAccess` calls, 116 `"Read"` methods with no row id; about 207
call sites in non-browser clients. Recount before planning.

## Top hazards

1. **Non-browser clients.** The agent, MCP, k3 and deploy-runner clients
   call through `packages/shared/src/socket-core/call-with-ack.ts`. They
   need `legacyWire: true` on the server until each moves to
   `createQuickdrawConnection` (React-free, from `./client`, re-joining its
   rooms with `connection.onHello`), and the shim serves calls only:
   confirm, before the server cutover, that none of them subscribes (the
   audit left this unverified). Remove the shim when its log, which names
   each 4.x caller once, stays quiet.
2. **The writes.** About 734 raw writes move to the tracked `db`. Writes in
   an interactive `$transaction` are tracked when it commits; array-form
   transactions are not rewritten (there `createMany` is tracked only with
   explicit ids); nested writes and raw SQL need `ctx.touch`. A write that
   matched no row or has nothing to write signals nothing, and one that
   sets a value a row already held does signal. Delete the 77 hand emits,
   and the AST test that hunts forgotten ones
   (`card-emit-enforcement.test.ts`), only once the writes are tracked.
3. **Access.** The 24 and 16 overrides become `inherit` (from the
   project, via `projectId`) and `members` policies, the 67 inline
   `checkProjectAccess` calls become `entry` or `{ scope, of: project, id }`
   forms, and the 116 marked `"authenticated"` methods each get the form
   their inline check enforced; a method that takes an `id` under a form
   that checks no row is refused at startup until decided. Nothing may get
   looser or tighter without a decision. REST routes call services as
   `qd.caller(principal)`, which loads the user's grants.
4. **The board.** `useBoardData.ts` (1,097 lines of safety nets around 4.x
   `useCollection`) is replaced by a `cardsByProject` collection with
   `index` and `views`: every `order` column but `id` must be an index
   field, no `order` column may sit above the collection's access tier, and
   the index stops at 50,000 rows. A fat watched board query is the
   benchmark's one missed target (`MIGRATION.md`, "Boards"). A query that
   must watch the service's topic narrows it to the models it reads
   (`watch: { service: ["card"] }`), so a write to another model of the
   service does not refetch it.
5. **Its own safety code.** Conveyor replaced 4.x's `invalidateOn`,
   reconnect policy and rate-limit backoff, and keeps `CardRemovalShadow`
   so a late upsert cannot resurrect a deleted card. 5.0's coordinator,
   revisions (microseconds, compared as numbers), tombstones, resume and
   `useJoin` cover these; delete each one with a test that proves the 5.0
   behavior, not before.
6. **Limits at its scale.** The socket rate limiter is on (600 events per
   minute per socket) and subscription events run 8 in flight, 64 queued
   per socket. Measure its busiest sockets against both; Cloud Run's
   60-minute socket cap becomes `qd:rotate` plus resume, and several
   instances share one order through `createServer({ cluster })` on Valkey
   (`docs/deploying.md`).

## Suggested order

1. A migration branch: the codemod's output committed as it is, lint with
   a baseline, then the contracts.
2. Access, service by service, with `describeAccessMatrix` tests.
3. Writes and emits per service cluster; the enforcement test goes last.
4. The board: the reshaped board-load pack, on `cardsByProject`.
5. The cutover: the 5.0 server and web client together, with
   `legacyWire: true` for the agent, MCP, k3 and deploy-runner clients.
6. Those clients on protocol 5, then `legacyWire` removed; the admin
   screens on the admin kit; budgets for the board's first load and a card
   move with many viewers.
