# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Describes and API docs

- **Every contract member takes a `describe`**: the contract itself, and each
  collection, stream, channel and event, beside each method's. It is a
  non-empty string, optional in the types, and refused when empty.
- **Lint's `quickdraw/require-describe`** (a warning in `oxlint.base.jsonc`)
  reports each contract member without a `describe`, and a static one under
  3 words (`minWords`). A migrated app gets one warning per member: the
  codemod writes none. Set it to `"error"` once the list is empty.
- **`quickdraw-docs` prints more.** A service page leads with the contract's
  describe, the index lists it, each member's section leads with its own,
  and each method shows its default MCP tool name (`{service}_{method}`)
  and, for a query, the MCP read-only hint. Regenerate your docs
  (`quickdraw-docs ... --out docs/api`): `--check` reports every page as
  out of date until you do.
- **The `quickdraw-api-docs` skill** in `@fitzzero/quickdraw-skills` ships
  `docs-api.yml`, a workflow that regenerates the API docs on every push to
  the base branch and commits them, for repositories where a committed
  generated file conflicts in every pull request. Copy it into
  `.github/workflows`; run `quickdraw-skills link` to link the skill.

### Codemod

- **The format step no longer fails when the app's formatter ignores the
  report.** An app whose `.oxfmtrc.json` ignores `**/*.md` made the codemod's
  second oxfmt call (the report alone) exit 2, and the run ended with "oxfmt
  failed on the files written" and nothing else. oxfmt now gets
  `--no-error-on-unmatched-pattern` (Biome `--no-errors-on-unmatched`;
  prettier already had `--ignore-unknown`), so files the config ignores are
  left as written. The formatter runs in batches of at most 100 files and
  about 24,000 characters of relative paths, then lists what is still
  unformatted (`--list-different`) and formats those once more. A failure
  prints the exit code, the formatter's own output and the files it left.

### Releasing

- **A release is a merge to `main`.** `.github/workflows/publish.yml` runs on
  every push to `main`: it publishes every package npm does not have at the
  repository's version, under `latest` (`next` for a prerelease) and with
  provenance, and tags each `<package>-v<version>`. Pushing those tags by hand
  was the release before, which is how 5.0.1 came to sit on `main` unpublished.
  `scripts/auto-release.sh` decides what a push releases, and when the version
  is already on npm and a package's shipped source changed since its tag, it
  takes the next patch and writes it into `packages/*/package.json`,
  `packages/core/src/version.ts` and `bun.lock` for the workflow to commit, so
  a release no longer waits on a bump nobody made. A minor or a major is still
  bumped by hand, a prerelease is never bumped by machine, and a docs- or
  test-only change cuts no release. Every step asks the registry, so a re-run
  publishes only what is missing. The four packages share one version and a
  test holds them to it; a change's entry goes under `## [Unreleased]`, and the
  release that ships it writes the version and the date here.

### Codemod

- **Test code no longer decides which class a service is read from.** The
  codemod read every class under the api's sources, so a test's subclass of
  a service (`class TestTaskService extends TaskServiceCore` in a
  `__tests__` file) hid the real class and became a service of the same
  name, and file order picked which one the contract was written from: on
  one app, a directory rename gave a service's contract none of its 81
  methods. Files under `__tests__` or `testing`, and `*.test.ts(x)` and
  `*.spec.ts(x)` files, are no longer read for services or method modules;
  their 4.x service classes are marked `[service]` and their uses of the
  services are still rewritten. A test-only service gets no contract.
- **One class per service name, chosen the same way every run:** the class
  `registerService("<name>", ...)` instantiates, else the one named after the
  service, else the first by file. Each other class is marked `[service]`.
- **A contract whose class implements none of its method map is not silent:**
  it is marked `[service]`, and the command names the service and the class
  it read on stderr. The report lists `[service]` items first, under
  "Services".

### Fixed

- **A call through the 4.x legacy shim (`legacyWire`) sees the socket it
  arrived on.** Its handler gets `ctx.socketId`, and `ctx.rooms.join(room)`
  joins the 4.x client's socket instead of answering `false`, so an app can
  put an old client in a room and reach it with its own raw emits. The socket
  leaves its app rooms when it disconnects, and `onRoomLeave` and presence
  hear it. The shim still serves request/response calls only, and a
  contract's events still reach only protocol-5 sockets.

## [5.0.1] - 2026-10-08

Fixes from the independent review of 5.0.0 after the farseer migration
(findings R1.1, R1.2 and R1.4).

### Behavior changes for 5.0.0 apps

- **A `resolver` policy without `reads` warns.** While `NODE_ENV` is not
  `"production"` the server logs `[quickdraw:resolver-without-reads]` once
  for each service whose policy is, or combines in `anyOf`, a `resolver`
  that declares no `reads`, and a test app made with `strictWarnings`
  fails to start. Declare what the levels depend on, or `reads: "none"`.
- **A GitHub Codespaces origin is refused** wherever `validateRedirectOrigin`
  decides: an app's own CORS, cookie or MCP origin check that calls it, and
  the mock provider's redirect URIs. `allowCodespaces` is accepted and
  ignored, so code that passes it still compiles; an app that wants a
  Codespace lists a pattern in `allowedPatterns`. The auth routes kit
  already refused them.
- The admin kit's `editable` is opt-in: without it, the kit writes what it
  wrote in 5.0.0.

### Security

- **A `resolver` policy is re-checked when access is revoked (R1.1).** A
  hand-written policy declared no reads, so no tracked write re-checked it:
  a member removed from a table a resolver read kept the live rows,
  collection scopes and change topics it had let them subscribe to, and
  kept receiving their updates. `resolver({ levelsFor, where?, reads })`
  now declares what the levels depend on, in the terms the other policies
  use: `reads: { columns, memberships }` names columns of the service's
  model and membership tables as `members` takes them (`entry` holding this
  service's row id). Tracked writes to them evict cached lookups and
  re-check what the policy decided, as for `owner`, `jsonAcl` and
  `members`; `tools.rows(ids)` reads the declared columns, and
  `tools.memberships(table, ...)` with a copy of a declared table is kept
  with `cacheMs` and evicted like `members`'. `defineService` checks the
  declared columns and tables against the Prisma client at compile time.
  `reads: "none"` says nothing a tracked write changes can change a level
  (the principal's grants alone, say).
- **`validateRedirectOrigin` never allows a GitHub Codespaces origin
  (R1.2).** It allowed any `https://*-*-<port>.app.github.dev` unless
  `allowCodespaces: false` was passed, with no `NODE_ENV` check, so in
  production any Codespace page (anyone can open one) passed an app's CORS,
  cookie or redirect check that used the helper. The allowance is gone, and
  `allowCodespaces` is a deprecated option that does nothing.

### Admin kit

- **`editable`, the fields the admin kit may write (R1.4).** The kit wrote
  every field it shows but `id` and the timestamps, owner and foreign-key
  columns included, unless a `fieldOverrides` entry made one read-only. `admin.handlers(contract, { editable: ["title", "status"] })`
  names the only fields `adminCreate` and `adminUpdate` write: `adminMeta`
  reports every other field `editable: false`, so a generic form leaves it
  read-only, and a write naming one is `VALIDATION` ("is not editable").
  Each name must be a field the kit shows, never `id` or a timestamp, and
  a `fieldOverrides` entry that says otherwise about a field fails when the
  handlers are made. `admin.contract({ entity, editable })` takes the same
  list: the writes' input checks, their types and their JSON Schema (and so
  the MCP tools made from it) name only those fields. Given to both halves,
  the two lists must name the same fields; given to the contract alone, it
  applies to the handlers too. `AdminData`, `AdminCreateInput` and
  `AdminUpdateInput` take the written fields as an optional second type
  argument, and `AdminWritable<Row>` names the default.

## [5.0.0] - 2026-10-05

quickdraw 5.0 rebuilds what an app is written against. A service is
declared once, as a contract in the app's shared package (`defineContract`);
the server implements it with `qd.defineService(contract, { ... })`, an
object instead of a `BaseService` class, and the web app calls it through a
client typed from the same contract (`qd.<service>.<member>`), with no
wrapper hooks or string names. Access is declared per method, decided by one
row policy per service, and closed by default. Entity frames, collection
deltas and change topics follow tracked Prisma writes, so an app sends no
event by hand. The wire is protocol 5. Four packages are released together:
`@fitzzero/quickdraw-core`, the framework; `@fitzzero/quickdraw-lint`, an
oxlint plugin and the configs an app extends; `@fitzzero/quickdraw-skills`,
agent rules and skills; and `@fitzzero/quickdraw-codemod`, which moves a 4.x
app. The design is [`docs/rfcs/0003-v5.md`](docs/rfcs/0003-v5.md) (section
17 records each decision made while building it), and its rationale
[`docs/rfcs/0003-v5-audit.md`](docs/rfcs/0003-v5-audit.md).

### Benchmark

5.0 measured again against 4.1.0 on the final code (5.0.0-rc.6), on the
machine and cpus of the first measurement, in one sitting
(`bench/reports/5.0.0.md`; board-steady: 600 writes to a board 50 viewers
watch): the board query's p95 is 0.15× of 4.1 (122 to 19.0 ms) and
`updateTask`'s 0.12× (120 to 13.8 ms), server CPU per write 0.53×, SQL
statements per write 0.36×, and a reconnect storm serves no snapshots
(11,590 in 4.1). Missed or worse: bytes per write 0.89×, against a target
of 0.30×, because the benchmark app keeps a fat watched board query (a
collection's index is the fix: `MIGRATION.md`, "Boards"); event-loop delay
p99 1.21× in board-burst and 2.6× in fat-read (where the two 4.1 runs
disagree by 25%), while board-steady's is now 0.80× of 4.1; drain after
the last write 0.50 s against 0.26 s (the coordinator's 250 ms window);
restoring a watched query after a reconnect storm, p50 1,056 ms against
10 ms (the deliberate refetch jitter, `reconnectJitterMs`); peak memory in
that storm 1.19× (not explained yet). Against the first measurement, on
5.0.0-alpha.0: encoding a shared run's reply once per group of callers
cut the event-loop delay p99 by half or more and the board query's p95
from 34.6 to 19.0 ms, and SQL statements per write rose from 0.25× to
0.36× of 4.1 because fewer refetches join a shared run in flight (3,943
runs against 2,397, 12 statements each; the statements besides those runs
did not change).

### Upgrading from 4.x

Every 4.x app migrates: `BaseService`, `ServiceRegistry`, the 4.x hooks and
the 4.x wire are gone. [`MIGRATION.md`](MIGRATION.md) is the guide, and
[`UPGRADE-PROMPT.md`](UPGRADE-PROMPT.md) the procedure for an agent (both
ship in `@fitzzero/quickdraw-codemod`): upgrade the packages, run
`bunx @fitzzero/quickdraw-codemod v5 .`, which writes the contracts, the
services and the typed client calls and lists every decision left in a
report, then work through the report. The guide's appendix lists every
removed 4.x name with its replacement, and lint's `no-v4-api` finds each one
in code. What changes for code that compiles:

- **Access is closed.** Every method declares who may call it. A 4.x
  `"Read"` method that named no row was open to every signed-in user; the
  codemod keeps it as a marked `"authenticated"` form, each one a decision.
- **Errors.** Anything a handler throws that is not a `QuickdrawError`
  reaches the caller as `INTERNAL` with a generic message. A write to a
  missing row throws `NOT_FOUND` where `this.update` returned `null`, and no
  lifecycle hook runs; a subscribe, or a method whose access names the row,
  answers a missing row `FORBIDDEN` (`NOT_FOUND` only for a service-wide
  `Admin`).
- **Outputs.** A method's output is sent as it declares it: a projection
  stripped per caller, an output schema of the method's own reduced to what
  its JSON Schema declares.
- **Server defaults.** No default CORS origin; the socket rate limiter is on
  at 600 events per minute per socket (subscription events, channels and
  cancels are not counted); a mutation ignores its caller's cancel; the
  service topic is closed unless the service declares `watchAccess`.
- **Sign-in.** The auth routes kit replaces hand-built routes, and its
  tokens name their session, so everyone signs in once more. The session
  cookie is `__Host-session` over HTTPS by default and `SameSite=Lax`, and
  no page outside `allowedOrigins` can use it: not on a socket, an HTTP
  call or a `requireSession` route.
- **Client.** A mutation of an entity (an input with `id`, an `"entity"`
  output) is optimistic by default; invalidation never cancels a read in
  flight; a reconnect refetches watched queries after a random delay of up
  to 2 s (`reconnectJitterMs`); the cache is dropped when the user changes.
- **Floors.** Node 24, Prisma 7, React 19, TanStack Query 5.20, Socket.IO
  4.8. Zod 3.25 validates; Zod 4.2 or later is needed where 5.0 reads a
  schema's JSON Schema (MCP tools, the admin kit, projection keys, output
  reduction, `quickdraw-docs`).

`legacyWire: true` keeps 4.x request and response callers (mobile clients,
scripts, agents) working while they move; it serves calls only, not
subscriptions, collections or channels. quickdraw-chat, the template the
other apps were copied from, migrated on the release candidates: its pull
requests (fitzzero/quickdraw-chat #46 to #55) are the worked example.
4.x stays on the `release/4.x` branch (4.1.1).

### Contracts and services

- **Contracts** are plain data plus schemas (any Standard Schema), imported
  by the server and the browser alike: `defineContract(name, { ... })` with
  an `entity`, `projections`, field tiers (`fields`), `methods`,
  `collections`, `streams`, `channels` and `events`. A method is a `query`
  or a `mutation` with an `input` and an `output` (a
  schema, `"entity"`, a named projection, `nullable(...)`, `listOf(...)`). A
  query may `watch` a collection's scope or its service's topic, whole or
  narrowed to some of its models (`watch: { service: ["gameScore"] }`).
  Types come from the contract: `InputOf`, `OutputOf`, `EntityOf`,
  `ItemOf`, `FullProjectionOf`, `ReceivedRow` and the rest.
- **Services** are `qd.defineService(contract, { ... })` objects: the
  `model`, the row policy (`access`), the `methods`, and as needed `writes`,
  `affects`, `collections`, `streams`, `watchAccess` and `onRoomLeave`. A
  method is `{ access, handler }`; a handler receives `{ input, ctx, db }`,
  `db` being the tracked Prisma client, and `ctx.services` calls the app's
  other services in process as the same principal. `initQuickdraw` gives
  `qd` the app's types and context; `qd.run(fn)` is a unit of work outside
  a handler (before any server exists too, or `{ detached: true }` inside
  one), and `qd.caller(principal)` calls services in process with the
  principal's grants loaded.
- **Every call runs one pipeline**: input validation, access, "not
  modified" answers (`version`), shared runs (`share: "caller" | "all"`,
  their result encoded once per group of readers), cancellation, a time
  limit (30 s by default), per-socket concurrency caps (16 queries in
  flight, 64 queued), then the output shaped as declared and validated
  outside production. Errors are `QuickdrawError(code, message, data?)`,
  each code with its HTTP status.
- **Refused when the service is defined**: a method whose input may carry a
  top-level `id` under an access form that checks no row, unless it says
  `rowless: true` (kits take `rowless: [names]`); a watch naming a model the
  service neither owns nor writes; a `"service"` watch without
  `watchAccess`.

### Access

- **A form per method**: `"public"`, `"authenticated"`, `{ service: L }` (a
  service grant), `{ entry: L }` (the row policy, on the row the input
  names), `{ service: L, entry: L }`, and `custom`. Levels are `Public`,
  `Read`, `Moderate` and `Admin`; a service-wide `Admin` grant passes every
  check unless the service sets `adminBypass: false`. Grants
  (`serviceAccess`) are loaded for every socket, HTTP call and in-process
  caller, and refreshed when they change.
- **One row policy per service**, for every surface (methods, entity
  subscriptions, collections, channels, streams): `owner`, `jsonAcl`,
  `members`, `inherit`, `everyone`, `anyOf` and `resolver`. A list reads
  only the rows the reader may see: the policy's filter is part of the
  query.
- **Revocation is automatic.** When a grant, an access list or a membership
  changes, a socket that lost access is sent `qd:revoked` and taken out of
  the row, scope or stream.
- **Field tiers** (the contract's `fields`) strip what a reader's level does
  not reach from entity frames, projections and kit replies; a collection
  refuses an index field its tier hides, and the development warning
  `tiered-field-in-output` names a tiered key in an output schema.

### Tracked writes, projections and collections

- **Tracked writes** (`trackPrisma`, on `./prisma`): a write through the
  tracked client records what it changed, and the flush after its unit of
  work (a call, `qd.run`, an interactive transaction once it commits) sends
  every entity frame, collection delta and topic change that follows; a
  rolled-back transaction sends nothing. `ctx.touch` records what raw SQL or
  a nested write changed. A write records nothing when it matched no row,
  had nothing to write, or is an `upsert` with `update: {}` that found its
  row (answered by a `findUnique` in the upsert's place); every other write
  is recorded, one that sets a value the row already held included. A
  service lists the other models it writes in `writes`, and `affects` sends
  a related row again (a message's chat, for its last message).
- **Projections and entity subscriptions**: a subscriber holds rows at its
  own level and by revision, and a resubscribe with the revision it holds is
  answered "not modified" (from `versionColumn`, or a change log of recent
  flushes). Revisions are microseconds since the epoch, compared as numbers.
- **Collections**, declared in the contract: a scope column, or `via` a
  junction table (`refreshEntry: true` sends the entry again on every
  junction change, for a member count); an `order` ending in `id`; keyset
  paging and resume after a reconnect; an `index` (a whole scope's
  membership and order, up to 50,000 rows, with the first page) and `views`
  the client runs over it; change topics a query can watch. The anchor's
  policy decides who opens a scope, and `scopeAccess: "self"` makes a
  user's own list.

### Protocol 5 and transports

- **Protocol 5**: one `qd:call` envelope, a version handshake (`qd:hello`,
  carrying the user, the grants and a `serverId` new at each start), entity
  frames (`qd:e`), collection deltas (`qd:c`), topic changes (`qd:changed`,
  naming the models a service-topic change came from), revocations
  (`qd:revoked`), presence (`qd:presence`), room events, channel messages
  and stream items as positional frames (`qd:event`, `qd:ch`, `qd:stream`),
  and `qd:rotate`, which asks clients to reconnect (`server.rotate`). A
  receiver ignores the object fields it does not know and the array
  elements after the last one it reads, and a later revision of protocol 5
  may only add. The Socket.IO parser is JSON-only (`./parser`).
  [`docs/protocol-v5.md`](docs/protocol-v5.md), generated from the
  protocol's sources, is the specification for clients in other languages.
- **Transports**: Socket.IO, HTTP (`POST /qd/{service}/{method}`, which
  `createServerCaller` on `./utils` calls from server-side rendering),
  in-process callers (`qd.caller`, `ctx.services`) and MCP
  (`./server/mcp`: tools generated from the contracts, custom tools, stdio
  and HTTP servers), all through one dispatcher, plus the `legacyWire` shim
  for 4.x callers. `qd.createServer` attaches to the Express app and HTTP
  server the app already owns, and never listens or exits by itself.

### Rooms, channels, events and streams

- **Rooms** are joined by methods (`ctx.rooms.join`, `leave`, `emit`,
  `emitToUser`), and reached outside handlers through `qd.rooms` and
  `server.rooms` (a game loop, a job), on every node:
  `rooms.leave(room, { userId })` takes a user out everywhere, and
  `rooms.size` counts a room's sockets on this node. `onRoomLeave`, on
  `createServer` and on any service, runs once per socket that leaves, with
  each room's `last`. Presence (`usePresence`, `qd.presence`) tells who is
  in a room and who is online.
- **Events** are typed room events declared in the contract (`useEvent`).
- **Channels** carry fire-and-forget input (cursors, a game's moves);
  `requires: { room }` (a name, a function of the payload, or `{ prefix }`)
  takes only a socket in that room, and gives its handler the room as
  `ctx.room`.
- **Streams** are feeds declared in the contract: a `seed` (the latest items,
  kept per node, or computed for each subscriber from the current state),
  `volatile`, `access` (a form, or `{ room }`: the sockets in that room,
  revoked when they leave it) and `validate`. The server pushes with `push`
  and `pushMany`; the client reads with `useStream`.

### Client

- **The typed client**: `createQuickdrawClient(contracts)` gives
  `qd.<service>.<member>` for every method (`useQuery`, `useMutation`,
  `call`, `key`, `prefetch`, `setData`), collection (`useCollection`),
  stream, channel and event, and `useEntity` and `useEntities` for live
  rows; a misspelled member is a compile error. `<QuickdrawProvider>` owns
  the socket and the `QueryClient` and runs without DOM globals (React
  Native); `useQuickdraw()` gives the connection, `isKnown` (the user is
  final), `reconnecting` and the hello. `createQuickdrawConnection` and
  `call` are the React-free forms.
- **One invalidation coordinator** per `QueryClient`: topic changes are
  coalesced in a 250 ms window, a read in flight is followed by one more
  rather than cancelled, and a reconnect refetches after
  `reconnectJitterMs`.
- **Optimistic updates**: a mutation of an entity patches the cached row
  and its collection items; `cache.addItem` and `cache.addEntity` show a new
  row at once (`useCollection().pending`). A refused call removes it, or
  keeps it with `onRefused: "keep"` (`useCollection().refused`, with
  `retry()` and `dismiss()`). A call whose outcome is unknown (the
  connection dropped after it was sent, or it timed out:
  `isUnknownOutcome`) keeps it `checking` until the scope's next load says.
  `newId()` makes the id such a row needs (a UUID, on plain-http pages
  too), so that load can find it and a retry cannot write it twice.
- **Rooms after a reconnect**: `useJoin(member, input)` runs a joining call
  on every hello (first connect, reconnect, new credentials), with
  `retry()`; `connection.onHello` is the React-free form.
- Also: `adminOf` and `useAdminServices` for admin screens; `signInUrl`,
  `signOut`, `signOutEverywhere` and `authProviders` for sign-in; hydration
  from the state the server rendered.

### Kits

- **Read/write** (`crud`): `get`, `getMany`, `list` (filters, sorts, keyset
  paging), `create`, `update`, `delete`, `reorder`, `bulkUpdate` and
  `bulkDelete`, each method with its own access form.
- **Search** (`search`): one `search` query over named fields
  (`useSearch`).
- **Sharing and membership** (`sharing`, mode `"acl"` or `"members"`):
  `share`, `unshare`, `setLevel` and `listShares`, or `invite`, `remove`,
  `setRole`, `listMembers` and `leave`, over the access list or membership
  table the service's policy reads; nobody gives a level above their own.
- **Admin** (`admin`): `adminList`, `adminGet`, `adminCreate`,
  `adminUpdate`, `adminDelete` and `adminMeta` (field metadata from the
  entity) for service administrators, grants editing with
  `grants: true`, `onWrite` inside the write's transaction and
  `onCommitted` after it.
- Presence, streams and channels (above), and the auth routes (below).

### Auth

- `createAuthRoutes`: Google and Discord sign-in (`.optional(...)` builds
  nothing without credentials), a development mock and guests; sessions in a
  `SessionStore` (the app's own table); `GET {basePath}/providers` for a
  login page (`authProviders()` on `./client`), with a rate limit of its
  own (`rateLimit.providers`); `issueSession` for a flow of
  the app's own; warnings when the routes can sign no one in or a loopback
  `publicUrl` meets public origins.
- `socketAuth` authenticates sockets and HTTP calls by those sessions,
  checking a cookie's `Origin` against `allowedOrigins` (`devCredentials`
  signs in editors and load-test bots outside production); `requireSession`
  and `sessionOf` give the app's own REST routes the same session and
  principal under the same Origin rule (the routes' origin list, found by
  the session store object they share, or `allowedOrigins`); `cookieOriginAllowed` is that rule
  for a custom `authenticate`; the routes, `setSessionCookie` and the
  transports name the cookie by one rule (`sessionCookieNameFor`).

### Several nodes

- `createServer({ cluster })` runs several nodes behind
  `@socket.io/redis-adapter` on Valkey: flushes share one order from a
  counter key, access changes and reloaded grants are broadcast and
  acknowledged, a push to a seeded stream reaches every node, and a node
  whose Valkey subscription comes back sends its clients `qd:rotate`.
  [`docs/deploying.md`](docs/deploying.md) has the wiring, Cloud Run
  included, and `bun run test:cluster` runs the end-to-end and realtime
  suites split across two nodes and a real Valkey.

### Testing, budgets and warnings

- `./testing`: `createTestApp` (a real server in the test process,
  `app.as(principal)`, `app.frames` with typed queries, `strictWarnings`),
  `describeAccessMatrix` (every method against every principal),
  `expectBudget` (statements and bytes per call, committed as snapshots),
  `streamFrames` and `eventFrames`. `./testing/client`:
  `renderWithQuickdraw` and `installJsdomShims`. `./testing/mock`:
  `createMockClient`, with a provider and session of its own (`$Provider`,
  `$session`, `$presence`), for Storybook. `./testing/prisma`: PostgreSQL
  and PGlite test databases (`openPgliteFromTemplate`).
- Development warnings name a mistake as it happens (`unbounded-read`,
  `n-plus-one`, `nested-write`, `ambient-write`, `oversized-response`,
  `repeated-call` and `tiered-field-in-output` on the server,
  `repeated-mutation` and `repeated-invalidation` on the client), and a
  strict test app throws them. `createServer({ stallWatchdog: true })`
  watches the event loop, and `otelOnCall` (`./server/otel`) reports calls
  to OpenTelemetry.

### Lint, skills, codemod and docs

- `@fitzzero/quickdraw-lint`: 23 oxlint rules (untracked, foreign, nested
  and raw SQL writes, hand-sent frames, inline auth guards, unbounded reads,
  database calls and emits in loops, layering, bypasses of the typed client,
  `prefer-kit`, `no-v4-api`, `no-todo-schema`, and three design-system rules
  in the template config), `oxlint.base.jsonc` and `oxlint.template.jsonc`,
  and `quickdraw-lint baseline` and `quickdraw-lint check`, so an app adopts
  the rules before fixing its old code.
- `@fitzzero/quickdraw-skills`: four rules and two skills
  (`quickdraw-new-service`, `quickdraw-migrate-v5`), linked into an app's
  `.claude/` by `quickdraw-skills link`.
- `@fitzzero/quickdraw-codemod`: `quickdraw-codemod v5 <repo> [--dry-run]`
  writes the contracts from the 4.x method maps, `defineService` objects
  from the classes (fields, getters and constructor work kept as marked
  module bindings and a `setUp<Service>` function) and the typed client for
  the hooks, with a `// quickdraw-migrate: review [<kind>]` marker on every
  decision (`[error]` on a thrown `Error` whose message 4.x sent, `[kit]` on
  a method a kit implements, `[carve-out]` in a template carve-out, an
  access form, `rowless`, a lifecycle hook) and
  `quickdraw-migration-report.md` listing them. It formats with the app's
  formatter, and a second run changes nothing.
- `quickdraw-docs` renders API pages from the contracts (`--services` adds
  who may call what, `--check` is for CI); [`docs/clients.md`](docs/clients.md)
  lists the ways in, [`docs/deploying.md`](docs/deploying.md) covers several
  nodes and proxies, and [`examples/godot`](examples/godot) is a GDScript
  client for Godot 4 on protocol 5 that CI runs against a real server.

### Packaging

- ESM only: one entry per export (`.`, `./server`, `./server/auth`,
  `./server/express`, `./server/mcp`, `./server/otel`, `./prisma`,
  `./client`, `./utils`, `./parser`, `./testing`, `./testing/client`,
  `./testing/mock`, `./testing/prisma`), `"use client"` opening `./client`,
  every peer dependency optional. No published manifest names a
  `workspace:` range, and each package is published from its tag through
  npm trusted publishing, with provenance.

## Release candidates

The sections below are the release candidates' own entries, `5.0.0-rc.0` to
`5.0.0-rc.7`, kept for the record: each says what changed since the one
before, with the behavior changes a release-candidate app met. The 5.0.0
entry above is all a 4.x app needs.

### [5.0.0-rc.7]

The template's findings on `5.0.0-rc.6` (quickdraw-chat PR #54, F11.1 to
F11.4): an optimistic item that a load ended on the client but not on the
screen, the provider list's rate limit, `requireSession`'s origin list,
and the id guidance. No version moves until the release candidate is cut.

#### Behavior changes for rc.6 apps

- **`GET {basePath}/providers` has a rate limit of its own.** It no longer
  counts against `/me`, `/logout` and `/logout-all`: `rateLimit.providers`,
  by default `createPublicApiLimiter()`, 60 requests per minute per IP. A
  limiter left out keeps its default, so an app that gives `signIn` and
  `session` and has no `express-rate-limit` gives `providers` too, or its
  auth routes answer `INTERNAL` as they do when any default lacks the peer
  (Auth).
- **`requireSession` says why when it has no origin list.** A session
  cookie it refuses with no list at all is logged once, as an error, and
  outside production its 403 names the fix instead of blaming the page
  (Auth).

#### Client

- An optimistic item that a load of its scope ended stayed on screen when
  that load left the scope's state as it was (F11.1): `pending`, or
  `checking` after a reconnect whose resume brought no deltas (the server
  had written the row and its frame had arrived, and only the answer was
  lost), until something else rendered the list again; a finished item
  that a later load answered without (not a member of its scope) stayed
  shown, past its expiry too. The additions removed what they ended and
  the overlay store then removed it again, found nothing, and told no
  view. Now the additions only decide what ends and the store's one
  removal tells the views of each service once, so every end shows: a
  load or delta that holds or names the item, a load that answers without
  it, a refusal, a dismissal, an expiry. Dropping the oldest of 1,000
  additions or layers tells the views of the service it was dropped from,
  which may be another's, and a refusal that drops some of a call's items
  and keeps others tells the views once instead of twice.
- `newId()` on `./client` (F11.2): an id for a row the client creates and
  the server keeps, a version 4 UUID from `crypto.randomUUID()`, or made
  from `crypto.getRandomValues()` where that is missing; no dependency.
  The guidance named `crypto.randomUUID()`, which browsers give only to
  secure pages (https, localhost), so a dev server opened at its LAN
  address over plain http would throw on every send. The client rule,
  `useCollection().checking` and the README name it, and the README's
  optimistic create sends one (its contract's `create` takes an `id`).

#### Auth

- `GET {basePath}/providers` is counted by its own limiter (F11.3):
  `rateLimit.providers`, by default `createPublicApiLimiter()` (60 per
  minute per IP, what the template's own route had). It shared the
  `session` limiter (120 per 15 minutes per IP), so 120 login-page loads
  from one address (an office, a classroom, a proxy without
  `trust proxy`) made sign-out answer 429. The list stays `no-store`: the
  mock provider comes and goes with `ENABLE_MOCK_OAUTH`, without a deploy.
- `requireSession` finds the routes' `allowedOrigins` by the session store
  object they were given, never by its table (F11.4), so a second
  `prismaSessions(prisma)` over the same table has no list: it refused
  every cookie request with an `Origin`, from an allowed page too, with a
  message that blamed the page. That stays, and now shows: with no list
  at all (no `allowedOrigins`, no `createAuthRoutes` over that store
  object) the first refused cookie logs an error naming both fixes (pass
  the routes' `sessions` object, or `allowedOrigins`) to the new `logger`
  option (default the console), and the 403 names them outside
  production. The JSDoc, README, MIGRATION and the services rule say "the
  same store object".

### [5.0.0-rc.6]

The fixes from the final independent review of the release candidates
(`5.0.0-rc.2` to `rc.5`), the template's last open findings (F8.3 to
F8.6) and the owner's QA of its deployment (F9.1 to F9.3, with F10.1 to
F10.4). No version moves until the release candidate is cut.

#### Behavior changes for rc.5 apps

- **Writes that set a value a row already holds signal again.** rc.5 left
  out an update whose interested columns held the same values after it as
  the tracker read before it, and that lost real changes; such a write now
  sends its frames, deltas and topic changes, as in rc.4. Re-ensure a row
  with `upsert({ where, create, update: {} })`, which still signals nothing
  when the row is there (Tracked writes, below).
- **A method's own output schema is sent as it declares it.** A key the
  handler returns beyond the schema no longer leaves the server, on any
  transport: a client that read such a key stops getting it, so declare
  it or answer `"entity"` (Outputs and field tiers). `tiered-field-in-output`
  now reads nested schemas too, so a strict test app over an output that
  declares a tiered key at any depth fails to start.
- **`requireSession` checks the cookie's Origin.** A REST route that takes
  the session cookie from a page outside `allowedOrigins` (by default the
  auth routes' list over the same session store object) answers 403
  `FORBIDDEN` (Auth).
- **An unknown outcome is not a refusal.** A mutation whose connection
  dropped after it was sent, or that timed out, keeps its optimistic items
  `pending` (and in `useCollection().checking`) until the scope's next load
  says; only then is one refused. `retry()` is safe after it only with an
  id the client made and the server keeps (Client).
- **A refused item's `retry()` goes through the mutation hook**, whose
  `onSuccess`, `onError` and `onSettled` now run for it, and a refused item
  shows in the render that shows the mutation's error (Client).

#### Tracked writes

- Behavior change: a write that sets a column to the value it already
  held is recorded again, as in rc.4. rc.5 skipped an `update`, an
  `updateMany` or an upsert when its interested columns held after the
  write the values the tracker read before it, but that read is not
  atomic with the write: in an array-form `$transaction` it runs before
  the whole batch, so a batch that set a task open, done, then open again
  told the open tasks' list it was removed; and a write landing between
  the read and the write lost a real change, leaving subscribers on a
  value the database no longer held, which a resubscribe with their
  revision then answered "not modified". What records nothing is now
  decided by the write alone: one that matched no row, a `data` (or an
  upsert's `update`) with nothing to write, and an upsert with
  `update: {}` that finds its row.

#### Outputs and field tiers

- Behavior change: a method whose output is a schema of its own (not
  `"entity"`, not a projection) is sent as that schema declares it, on
  every transport and whatever `outputValidation` is. An object keeps the
  keys its JSON Schema's `properties` declare (every key only where
  `additionalProperties` allows them, or for a record), an array reduces
  each item, a union keeps what any branch declares, and a value the schema
  allows to be anything goes as it is. rc.5 sent what the handler returned,
  so a `rename` with the output `{ id, name }` that answered
  `db.user.update(...)` sent `email` and `serviceAccess` to a service-wide
  `Moderate` grant. The reduction is compiled once per method from the
  schema's Standard JSON Schema, and a call copies only the objects that
  lose a key: a page of 200 rows costs about what `JSON.stringify` takes to
  write it. An output schema without JSON Schema (Zod 3) is sent as
  returned.
- `tiered-field-in-output` reads every depth of an output schema (`email`
  in `{ user: { id, email } }`, the rows of a list, the values of a
  record) and says where the key is declared (`meta.path`). Its advice is
  now "answer `"entity"` or a projection, or drop the key from the
  schema": rc.5's "leave the key out" silenced the warning while the key
  still went out. A kit's methods are not checked, since a kit strips its
  own replies. For an output without JSON Schema, a reply that carries a
  tiered key raises it in development.

#### Wire

- One rule for every frame, both ways, stated in `protocol/envelope.ts`
  and `docs/protocol-v5.md` before the protocol freezes: a receiver
  ignores the object fields it does not know and the array elements after
  the last one it reads, and a later revision of protocol 5 may only add
  fields to objects and append elements to arrays (anything else takes a
  new protocol number). The JS client dropped a `qd:event` frame with more
  than three elements; it now reads the first three, as its `qd:stream`
  reader and the GDScript client already did. `check:godot` plays a newer
  server: a field more in every `qd:hello`, elements appended to
  `qd:stream` and `qd:event`, a field added to `qd:presence`, `qd:changed`
  and `qd:revoked`.

#### Client

- Behavior change: a call whose outcome is unknown is not a refusal. When
  the connection drops after a mutation was sent (`INTERNAL` "No answer:
  the connection to the server is down") or it times out (`TIMEOUT`), the
  server may have made the write: the items its optimistic update added
  stay shown and `pending`, named by the new `useCollection().checking`,
  until the scope's next load (the reconnect's resume; while the socket is
  up, a load asked for at once). A load that holds an item's id ends it,
  its own copy shown, and one sent after the failure that answers without
  it refuses it (kept with `onRefused: "keep"`, with the call's error).
  rc.5 refused it at once, so after the reconnect the list showed the
  server's row and the kept copy, and `retry()` wrote a second row. A
  refused item now also ends once its scope holds its id.
  `isUnknownOutcome(error)` on `./client` tells such failures apart (a call
  that timed out in the send buffer, never sent, is a plain failure). Only
  an id the client made, which the server keeps, can be found: with a
  provisional one the load refuses the item even when the server made the
  row, and `retry()` is safe only with such an id.
- A refused optimistic item shows in `useCollection().refused` in the
  render that shows the mutation's error: the overlay store applies a
  failure in TanStack's notify batch of the mutation's change to error, so
  `isPending` is never still true beside it. Its `retry()` sends the call
  through the mutation hook that sent it, so the hook's `isPending`,
  `onSuccess`, `onError` and `onSettled` follow the retry (F8.3; rc.5 sent
  it past the hook).
- A collection scope whose load was refused (`FORBIDDEN`, `NOT_FOUND`,
  `UNAUTHENTICATED`) is loaded once more when the user's access may have
  changed: on new service grants (`qd:access`), and when an `added` delta
  of another held scope names the scope's anchor row (an invite adds the
  chat to the user's own list, and its messages open without a remount);
  every connect loads it again too (F8.4). One load per signal, so a scope
  that stays refused does not loop. Optimistic items added to it meanwhile
  show once it opens, until its own copies arrive.

#### Auth

- Behavior change: `requireSession` applies the `/qd` calls' Origin rule
  to the session cookie (F8.5; the final review reproduced a cross-site
  form POST reaching a route as the user). From an `Origin` outside
  `allowedOrigins` it answers 403 `{ error: "FORBIDDEN", message }`; a
  request without `Origin` is accepted unless `Sec-Fetch-Site` names
  another site; a bearer token is unaffected. The list is the new
  `allowedOrigins` option, by default that of the `createAuthRoutes`
  writing to the same session store object; with neither, no page may use
  the cookie there. `cookieOriginAllowed(request, allowedOrigins)` on
  `./server/auth` (type `CookieOriginRequest`) is the rule for a custom
  `authenticate` or route: the HTTP form, or the handshake's with
  `transport: "socket"`.
- MIGRATION's Discord Activity example sets no cookie: its page sends the
  token as `auth.token`, and a `SameSite=None` cookie is for a page on
  another site that calls the API with credentials (F8.6).
- `createAuthRoutes` serves `GET {basePath}/providers`, `{ providers: [{
id, name, kind }] }`: the sign-ins served now, in order (a provider
  `google.optional` built nothing for is not in it, the mock only while it
  is mounted and enabled), and the routes it returns have `providers()`
  answering the same (F9.1, F10.1; type `AuthProviderInfo` on
  `./server/auth`). An OAuth provider object may give a `name`;
  `google()` and `discord()` give "Google" and "Discord". `./client` gains
  `authProviders({ apiUrl?, basePath? })` (type `AuthProviderInfo`), so a
  login page renders only what the API serves; the README's sign-in
  example does.
- A loopback `publicUrl` is reported: the routes warn when they are made
  if every allowed origin is a page on another machine (F10.2), and the
  first request that arrives for another host (`X-Forwarded-Host`, else
  `Host`) logs an error naming it, once (F9.2: a hosted instance without
  `API_URL` sent browsers to `http://localhost:<port>`). Routes with
  nothing that can sign anyone in (only a mock that is off) warn when they
  are made (F10.3).
- `docs/deploying.md` has "Behind a proxy, in production or not" (`trust
proxy`, `publicUrl`, the cookie's name by `X-Forwarded-Proto`; F9.3), and
  the README's server example reads `trust proxy` from `TRUST_PROXY`
  instead of setting it unconditionally (F10.4).

#### Smaller fixes

- `inherit` from a parent whose policy lets every row through
  (`everyone(level)`, alone or in `anyOf`) filters a list by
  `{ [via]: { not: null } }` instead of an `in` list of every parent id,
  which read the whole parent table on every list, collection and scope
  check. A policy's filter is computed once per service, principal and
  level within one access check, so asking the parent's filter first costs
  nothing more.
- `createServer` warns at startup when an admin kit edits grants
  (`admin.handlers(c, { grants: true })`) without `auth.serviceAccessSource`:
  a user whose grant is lowered keeps it on open sockets until they
  connect again.
- `useJoin` drops a join answered after its hello was replaced: with new
  credentials the hello is cleared before the old socket closes, and a
  reply that arrived then gave `onJoined` the last user's data.
- MIGRATION says, where it says a missing row is `NOT_FOUND`, that a
  subscribe or a method whose access names the row (`{ entry }`) answers
  `FORBIDDEN` (only a service-wide `Admin` gets `NOT_FOUND`).
- The README names the public types added since rc.1 where their feature
  is: `ReceivedRow`, `FullProjectionOf`, `ServiceModelsWatch`,
  `ChannelRoomOf`, `AdminOutputOf`, `StreamImplementation`, `RoomLeft`,
  `JsonColumnValue`, `HttpCredentialSource`, `EventQuery`, `MatrixCell`,
  `MatrixInputFactory` and `MockSession`.

### [5.0.0-rc.5]

Round 6 of the fixes the quickdraw-chat migration found: the framework
findings of the independent review of its finale (F7.1 to F7.8) and of its
last migration card on `5.0.0-rc.4` (F6.1 to F6.8). No version moves until
the release candidate is cut.

#### Security

- Behavior change: an HTTP call (`POST /qd/...`) that authenticates with
  the session cookie gets the Origin check sockets get. `socketAuth`
  answers it `FORBIDDEN` (403) when its `Origin` is not in
  `allowedOrigins`; rc.4 answered such a call, relying on its required
  JSON content type and the app's CORS policy alone, so an app whose CORS
  reflected any origin with credentials let another site's page call
  methods as the user (F7.1). A call without `Origin` stays signed in: a
  browser sends `Origin` with every POST, so it comes from curl or a
  server rendering a page with the user's forwarded cookie
  (`createServerCaller`), and is refused only when `Sec-Fetch-Site` names
  another site. A bearer token needs no Origin. The transport tells any
  `authenticate` where an HTTP call's token came from
  (`HttpAuthenticateRequest.credential`: `"cookie"` or `"bearer"`, type
  `HttpCredentialSource` on `./server`), and answers a
  `QuickdrawError("FORBIDDEN")` thrown by `authenticate` as it is (other
  throws stay `UNAUTHENTICATED`).

#### Tracked writes

- A write that changed nothing is no longer recorded, so it sends no
  entity frame, collection delta, topic change, `refreshEntry` or `affects`
  hop (F7.2): an `updateMany`, `updateManyAndReturn` or `deleteMany` that
  matched no row (in an array-form batch, an `updateMany` answering count
  0); a `data` or an upsert's `update` with nothing to write (`{}`, or only
  `undefined` values), for which Prisma writes nothing; and an `update`, an
  `updateMany` or an upsert that found its row, when every column it sets
  is an interested one (scope, `where`, junction, membership, owner and
  access columns, read before the write) and holds the same value after.
  Decided from the values the tracker holds: a write that sets any other
  column is recorded as before, and the `@updatedAt` column Prisma moves on
  such a write is not signalled, as no write's is on its own. Before, a
  game that re-ensured a chat membership on every page load
  (`upsert({ update: {} })`) re-sent the chat to every member's list and
  made every watcher of the service's topic read again. rc.6 withdraws the
  equal-values case, which lost real changes (see there).
- An upsert whose `update` sets nothing reads its row in the upsert's
  place: `findUnique` with its `where` and selection answers it when the
  row exists (one statement, as the upsert was, and fewer in SQL than
  Prisma's own emulated upsert), and the upsert runs after the read only
  when the row is missing (one statement more, recorded as a create that
  may have found its row). In an array-form batch it is recorded as before.
- An `updateMany` with nothing to write answers `{ count: 0 }` through the
  tracked client too, as Prisma does (the rewrite to `updateManyAndReturn`
  answered the number of rows matched).

#### Contracts and topics

- A query watches its service's topic narrowed to some of its models:
  `watch: { service: ["gameScore"] }` (type `ServiceModelsWatch`, in
  `ServiceWatch`), invalidated only after a flush that wrote one of them
  (F7.3, F6.1). `watch: "service"` was invalidated by a write to any model
  the service lists in `writes`, so high scores were read again on every
  chat-membership write of the same service. The names are the service's
  `model` and its `writes`, by the client's model name; `defineContract`
  checks the shape (a non-empty list of distinct names) and `defineService`
  refuses a name that is neither, and still needs `watchAccess`.
- Wire, additive (protocol v5 unchanged): a `qd:changed` frame of the
  `service` topic carries `models`, the models whose writes changed it in
  that flush (`modelKey` names: the service's model for its rows, `affects`
  hops and scopes a deleted anchor closed; the junction's for a `via` link;
  the written model for `writes`), sorted. The topic stays one per service.
  A client ignores the field, or reads it: the JS client's narrowed watches
  skip a frame naming none of their models, and treat a frame without
  `models` (an rc.4 server, or the last frame of a watch the socket lost)
  as naming all. `connection.watch({ ..., models })` is the React-free
  form. `docs/protocol-v5.md` documents the field.

#### Access

- A new development warning, `tiered-field-in-output` (F7.4): field tiers
  strip only projection outputs (`"entity"`, a named projection,
  `nullable(...)`, `listOf(...)`), so a method whose own output schema
  names a key the contract tiers sends it to every caller its access
  admits (quickdraw-chat's `updateUser` answered a user's `Admin`-only
  `email` to a service-wide `Moderate` grant). When a dispatcher is made
  (`createServer`, `createTestApp`), each such method and key is warned
  about once, naming the fix (answer `"entity"` or a projection, or leave
  the key out); `createTestApp({ strictWarnings: true })` throws it, so
  the test app fails to start. The keys are the top-level keys of every
  object the output may be (union branches and a list's rows included),
  read from its JSON Schema; a Zod 3 output is not checked. Not warned: a
  method whose access admits no caller below the field's level
  (`{ service: "Admin" }` while the Admin bypass is on, `{ entry: L }` with
  `L` at the field's level or above, both halves of a two-part form).
  Behavior change for rc.4 apps: a strict test app over such a method no
  longer starts until the method answers `"entity"`.

#### Client

- `useJoin(...)` returns `retry()`: it runs the joining call again at once
  on the current socket, after a refusal the user can act on; it does
  nothing while there is no socket to join with or `enabled` is false,
  since the next hello joins anyway (F6.3). Before, a refused first join
  could be tried again only by toggling `enabled`.
- An optimistic addition can outlive its refusal:
  `cache.addItem(collection, scope, item, { onRefused: "keep" })` (and
  `addEntity(row, { onRefused })`; types `AddItemOptions`, `OnRefused`).
  A refused call then moves the item from `items` to the new
  `useCollection().refused`: each a `RefusedItem` with `item`, `error`,
  `dismiss()` and `retry()`, until the app dismisses it or `retry()` sends
  the same call again (the update adds the item anew, `pending`; it
  resolves once the call settles and never rejects, a second refusal
  showing in `refused` again) (F6.4). The default stays `"drop"`.
  `OverlayView` gains `refused(collection, scope)`.

#### Docs, skills and tools

- The `quickdraw-new-service` skill starts with the Prisma model: add it,
  then `bun run db:migrate --name <change>` and `bun run db:generate` in
  `packages/db` (Prisma 7's `migrate dev` no longer generates the client);
  six steps instead of five. Its server example imports with `.js`
  (`"../../quickdraw.js"`), as the template's NodeNext API needs (TS2835
  without it); the README project's test checks every relative import of
  the skill's server examples carries `.js`. A NodeNext compile of the
  example was not feasible: core's own sources, mapped into that project,
  are bundler-resolved (F7.6).
- The README and the client rule say a row that does not exist is
  `FORBIDDEN` (fail closed, as a row the reader may not see; `NOT_FOUND`
  only for a service-wide `Admin`), so a page tells "deleted" from "no
  access" only while it holds the row (the `r` frame, `isRemoved`; a
  collection's `removed`), and words a later refusal "not found or not
  shared with you" (F7.8).
- `quickdraw-docs --services` imports the services module with everything
  it imports, through the same `tsx` fallback as the contracts module: a
  workspace package whose `package.json` points at its build must be built
  first, which the README now says, and the command's error names it when
  a built file is missing (F6.7).
- The generated Streams intro no longer says "starting from the latest
  few": a subscriber starts from the stream's seed; a contract-only page
  (no `--services`) says "none in the contract; the service may compute
  one" instead of "none (default)", and a page made with `--services` says
  "computed by the service when a socket subscribes" when it is (F6.8).
- The GDScript client holds no feed after its `qd:stream:sub` was refused
  on a live connection: `is_subscribed` is false and the feed is not
  subscribed again after a reconnect; a refusal lost with the connection
  keeps it. A held feed refused after a reconnect is forgotten and
  reported through `revoked` (`reason` `"refused"`, with its `error`)
  (F6.6). An app that copied `examples/godot/addons/quickdraw/quickdraw_client.gd`
  copies it again.

#### Testing

- `<mock.$Provider session={...}>` gives its subtree a session of its own,
  laid over the mock's (`$session`) field by field: the real
  `useQuickdraw()` and `usePresence`, and the mock's collection views and
  admin grants, read it there, so the stories a Storybook docs page
  renders side by side each show theirs (F6.2). An invalid one throws
  while rendering, naming `$Provider`.

#### Kits, auth and lint

- The admin kit takes `onCommitted({ method, id, before?, after }, ctx)`
  beside `onWrite`: it runs once the write has committed, in a detached
  unit of work; the reply does not wait for it, a throw is logged, and a
  rolled-back write calls nothing (F6.5). Use it for effects that must not
  happen before the data is durable; `onWrite` stays inside the write's
  transaction.
- Behavior change: `setSessionCookie` defaults to `SameSite=Lax` in
  production, as the auth routes kit's own sign-in does (F7.5); rc.4
  defaulted to `None`. An app that needs the cookie inside a third-party
  frame passes `{ sameSite: "none" }` itself.
- Lint: `no-raw-socket` follows values made by `socket.io-client`'s `io()`,
  `connect()`, `Manager` and `.socket()` whatever they are named, through
  variables and `this` fields, and reports `qd:` event names on any
  receiver; `prefer-kit` reports a hand-written method that duplicates what
  a kit spread beside it serves (F7.7). Both report more than in rc.4: fix
  the code, or state the reason with
  `// quickdraw: hand-written because <reason>`.

#### Upgrading from rc.4

- Regenerate a checked-in API reference (`quickdraw-docs`): the Streams
  introduction's wording changed, so `--check` fails until it is rewritten.
- Re-copy the GDScript reference client if a game uses it.
- A strict test app refuses a hand-written output that names a tiered
  field: answer `"entity"`, use a projection, or drop the field.

### [5.0.0-rc.4]

Rounds 3, 4 and 5 of the fixes the quickdraw-chat migration found: round 3
on `5.0.0-rc.1` (findings F3.1 to F3.11, from its web port), round 4 on
`5.0.0-rc.3` (findings F4.1 to F4.14, from its game and the Godot client on
protocol v5), round 5 on `5.0.0-rc.3` (findings F5.1 to F5.7, from its
template polish). No version moves until the release candidate is cut.

#### Protocol

- Breaking wire change for `5.0.0-rc.3` clients: `qd:stream` is a
  positional array, `[service, stream, scope, item]` (`scope` `null` for a
  global stream), like `qd:event`, instead of the object `{ s, stream,
scope?, item }`. A frame carries no key names: 28 bytes fewer per scoped
  frame and 15 per global one, per subscriber (measured in the stream and
  wire tests; at quickdraw-chat's 20 Hz that is 560 bytes a second per
  client). Positions are fixed and a later protocol only appends after
  `item`, so a client reads four elements and ignores the rest. The JS
  client, the GDScript reference client and `docs/protocol-v5.md` move
  together: an app that copied `examples/godot/addons/quickdraw/quickdraw_client.gd`
  must copy it again (F4.7).

#### Realtime

- A stream's seed can be computed when a socket subscribes: `defineService(contract, { streams:
{ world: { seed: (scope, ctx) => items } } })` answers each `qd:stream:sub`
  with what the function returns (the current world, where the items that
  follow are deltas), on whichever node the subscriber is connected to,
  under its principal once the stream's `access` admitted it. The socket
  joins the feed in the tick the function is called, so one that returns at
  once misses nothing and repeats nothing; one that returns a promise may
  also see items pushed while it runs, which then arrive both ways. A throw
  answers the subscribe with that error and leaves the feed; items are
  checked against the stream's schema. A contract `seed: n` (the latest
  items, kept per node) and a seed function cannot be declared together. A
  node that started after the pushes now seeds such a stream correctly
  (F4.1).
- A service declares its own room-leave hook: `defineService(contract, {
onRoomLeave(leave, ctx) })`, typed as `createServer`'s option. Every
  server the service runs in (`createServer`, so `createTestApp` and a
  benchmark's server too) runs each service's hook and its own
  `onRoomLeave`, which stays, once per socket leave, each in a detached
  unit of work of its own; one that throws is logged (with `owner`: the
  service's name or `"createServer"`) and stops none of the others. A
  server root that forgot to pass the game's handler leaked players
  silently (F4.2).
- Rooms are joined again after a reconnect: `useJoin(member, input, {
enabled?, onJoined? })` on `./client` runs a joining call (any query or
  mutation member, a mock's too) on every `qd:hello` (first connect, every
  reconnect, new credentials) and when its input changes by value, never
  on a re-render, and returns `{ status: "idle" | "joining" | "joined" |
"error", isJoined, data, error }` for the current socket; a refusal
  stands until the next hello, `RATE_LIMITED` is tried again after its
  backoff. `connection.onHello(listener)` is the React-free form (each
  hello, and the current one in a microtask). The README's board example
  joins with it; a room joined once from a query was silently lost on
  every reconnect (F4.3).
- `rooms.size(room)` on `qd.rooms`, `server.rooms`, `dispatcher.rooms` and
  `ctx.rooms`: the sockets in an app room on this node, anonymous ones
  included, synchronous, for a tick loop (local by design; `presence.count`
  stays the cluster-wide count of users). A method's `ctx.socketId` names
  the socket its call arrived on (`undefined` over HTTP, MCP or in process)
  (F4.4).
- A channel's `requires: { room: { prefix: "world:" } }` takes a socket in
  any app room whose name starts with the prefix (the one it joined first,
  if several); refused at definition for an empty or reserved prefix. Every
  room form gives the handler the room it matched as `ctx.room` (typed
  `string` for a channel that requires a room, `undefined` otherwise), so a
  game of many worlds need not repeat the world's id in every input frame
  (F4.5).
- A stream's `access: { room }`: open to the sockets in that app room,
  signed in or not (a name, `{ prefix }`, or for a scoped stream a function
  of the scope, `(worldId) => \`world:${worldId}\``); a socket that leaves the
room or is taken out of it is revoked from the feed at once
(`qd:revoked { kind: "stream" }`). Refused at definition for a reserved
  room, a form mixed with another, or a computed room on a global stream
  (F4.6).
- A write to a model a service lists in `writes` changes that service's
  topic, and a query may declare `watch: "service"` (its client then joins
  the service topic, which `watchAccess` opens), so a query over a model no
  service owns (a game's high scores) is invalidated without an app event.
  A service without a model may now be watched when it writes something,
  and `defineService` refuses a query that watches `"service"` on a
  service without `watchAccess`, whose topic would stay closed (F4.9).
- `streams: { <name>: { validate: "development" } }` checks pushed items
  (and computed seeds) only while the dispatcher checks outputs
  (`outputValidation`, on unless `NODE_ENV` is `"production"`); unchecked,
  an item goes out as pushed. The default stays `"always"` (F4.14).

#### Kits

- `admin.handlers(contract, { onWrite })`: `onWrite({ method, id, before?,
after }, ctx, db)` runs after each `adminCreate`, `adminUpdate` and
  `adminDelete`, in one transaction with the write (`db` its tracked
  client; a throw undoes the write and fails the call), with the entity's
  rows before and after, every field. Without it nothing changes: no
  transaction, no extra read. `KitHandler<Db, Out>` gains its output type
  (default `never`, as before), and the admin kit's handlers resolve with
  their method's output type, so a wrapper reads what a handler returned
  and returns it on with no cast (F4.8).
- With `admin.handlers(contract, { grants: true })`, the grants field's
  configuration in `adminMeta` says `kind: "grants"`, so a screen with a
  grants editor of its own finds it without its name, and
  `fieldOverrides` take `showInForm`: `{ serviceAccess: { showInForm: false } }`
  keeps the field out of a generic create or edit form while the kit still
  reads and writes it. Both are optional members of `AdminFieldConfig`,
  present only on the grants field and on an overridden one, so other
  `adminMeta` answers do not change; an override may not set `kind`
  (F5.5).

#### Testing

- `app.frames` and `frames.waitFor` take an event query with `where`, a
  predicate over the event's frames with `data` typed by the event
  (`EventQuery<E, D>`), and `./testing` adds `streamFrames(contract, stream,
where?, scope?)` and `eventFrames(contract, event, where?)`, which match
  one stream's items or one event's payloads typed by the contract. Realtime
  tests cast `StreamFrame` and `EventFrame` by hand before (F4.13).

#### GDScript reference client

- `is_subscribed(service, stream, scope)` (true while the client holds
  the feed, which it subscribes to again after each reconnect) and
  `off_event(service, event, callback)`; `check:godot` checks both, and
  `server_id` (F4.11). Re-copy `addons/quickdraw/quickdraw_client.gd`: it
  also reads the positional `qd:stream` frame (F4.7, F4.12).

#### Server

- `qd.run(fn)` before the app created any dispatcher (a boot-time seed
  before `createServer`) runs `fn` in a unit of work of its own instead of
  throwing: its tracked writes raise no ambient warning and flush once it
  settles to the dispatcher the client is attached to by then, which before
  any server is none, so they reach no one (no socket can be subscribed
  yet). Work the run started and did not await writes as ambient once it
  settled. `ctx.touch` records nothing there (F4.10).
- `qd:hello` carries `serverId`, random and new each time a server starts,
  so a client tells a restarted server (or another node) from a network
  blip; `docs/protocol-v5.md`, the JS client's hello and the GDScript
  client's `server_id` carry it (F4.11).
- `qd.caller(principal)` and `server.dispatcher.caller(principal)` give a
  principal that carries no `serviceAccess` the grants the server's
  `auth.loadServiceAccess` loads, as a socket's handshake and an HTTP call
  do: once per caller, at its first call, and again at the next call after
  the server applied new grants to a user (`server.access.refresh`, a
  tracked write to `auth.serviceAccessSource`, another node's broadcast),
  as a socket's are refreshed. A principal that carries grants (even `{}`)
  keeps exactly those; a failed load rejects the call with `INTERNAL` (the
  error as `cause`) and is tried again at the next call; a dispatcher
  without a server's `auth` loads nothing. Before, an app's REST route that
  called a service in process ran with no grants at all, not even the ones
  every user gets by default, so a method behind `{ service: L }` answered
  `FORBIDDEN` (F5.1).

#### Auth

- `requireSession(keys, { loadPrincipal? })` builds the request's principal
  as `socketAuth` builds a socket's (default `{ userId, kind: "user" }`; a
  `loadPrincipal` answering `null` is a 401, one naming another user an
  error passed to `next`), and `sessionOf(req)` on `./server/auth` returns
  `{ userId, sessionId, principal }` for a request it let through, typed
  (`sessionOf<AppPrincipal>(req)`), with no cast of `req`; it throws a
  `TypeError` for a route mounted without `requireSession`. `req.userId`,
  `req.sessionId` and now `req.principal` are set as well. The README's
  auth routes kit section shows a REST route calling a service in process
  (`requireSession`, `sessionOf`, `qd.caller`) as a compiled example, and
  MIGRATION's example lost its cast (F5.1, F5.4).

#### Client

- `useQuickdraw()` gains `isKnown` (the server's hello on the current
  credentials arrived: `userId` is final, `null` meaning anonymous; false
  again from new credentials until their hello) and `reconnecting`. A gate
  on `isConnected` or `userId` alone flashed the signed-out state before the
  hello and unmounted the page on every reconnect (F3.4).
- An optimistic update can add a row: `cache.addItem(collection, scope,
item)` and `cache.addEntity(row)` in a mutation's `optimistic` show the
  item at once, in its place by the collection's `order`;
  `useCollection` returns `pending`, the ids of added items whose call is
  in flight. A refused call removes it; the reply's `id` and values replace
  its own; the scope's own copy replaces it with no gap and no second copy
  (F3.2).
- Breaking: `getOAuthUrl`, `logout` and `logoutAllDevices` are removed (they
  called routes the auth routes kit does not serve and, with cookie
  sessions, signed nobody out). `signInUrl(provider, { apiUrl?, basePath?,
returnTo? })`, `signOut()` and `signOutEverywhere()` use the kit's routes
  with the session cookie and the stored token, and reject when refused;
  lint's `no-v4-api` names them (F3.3).
- Hydration reads the state a server renders, never the live connection:
  `useQuickdraw()`, the hello the hooks wait for, `usePresence`, streams and
  overlays hydrate as a connection that never opened, then render the live
  state, so a boundary that hydrates after the provider connected no longer
  fails ("Hydration failed", a regression from 4.1) (F3.5).
- `useAdminServices` asks only the services the user's grants allow (from
  the hello; `Admin` by default, `{ requires }` to change it), and a refused
  service is not asked again until the grant changes, reconnects included
  (F3.6). `adminOf(qd, key)` gives every service's admin members one shape
  typed by field name (`AdminScreen`), for a screen driven by `adminMeta`
  (F3.7). The README's admin example reads the list again after its own
  write: the kit's rows are not live (F3.8).
- `qd.<service>.<query>.setData(input, updater)` writes a query's cached
  result for an event that carries it; a read in flight is followed by one
  more (F3.9).

#### Testing

- `createMockClient` has a provider of its own, `mock.$Provider`, in which
  the real `useQuickdraw()` and `usePresence` read the mock's session:
  `createMockClient(contracts, { session })`, `mock.$session({ userId,
serviceAccess, isConnected, isKnown })` and `mock.$presence(room, users)`.
  Its views select for the session's user and `useAdminServices(mock)`
  follows its grants (F3.1).
- `@fitzzero/quickdraw-core/testing/mock`: the mock alone, naming no Testing
  Library, for browser bundles such as Storybook; `./testing/client`
  re-exports it (F3.10).
- `installJsdomShims()` on `./testing/client` (element scrolling,
  `Blob.prototype.arrayBuffer`) and `openPgliteFromTemplate(options)` on
  `./testing/prisma` (a worker's PGlite database from the global setup's
  template, under jsdom too). The README's `renderWithQuickdraw` example now
  runs in CI, with the per-worker database pattern documented (F3.11).

#### Lint and codemod

- The policy builders listed in `no-v4-api`'s messages, the codemod's
  access markers and the upgrade procedure name `everyone`.

#### API docs

- `quickdraw-docs <contracts> --services <module>` reads the services'
  definitions (each export, or in a list or map) and adds to each page who
  may call what: an "Access" section (the row policy in words, whether a
  service-wide `Admin` grant passes every check, `watchAccess`, the field
  levels), each method's access form in words and its `rowless`, who may
  open a collection's scope, a channel's access, a stream's computed seed
  and validation. A contract with no service says so; a service with no
  contract is an error. Pass the flag to `--check` too. Without it the
  pages are as before (F5.3).
- Wording: one character, one item and a seed of one are singular ("at
  least 1 character", "the latest item"); the safe-integer bounds Zod
  gives every integer are not written, and a bound of 0 reads
  "non-negative" (an exclusive one "positive"); other exclusive bounds read
  "more than" and "less than". A stream's `access: { room }` was written
  as `{  }` (F5.6). Regenerate committed pages (`docs:check` reports them).

#### Skills

- `quickdraw-new-service` and `quickdraw-testing.md` follow the template's
  layout: a service at `apps/api/src/services/<name>/index.ts`, registered
  in the `services` list of `apps/api/src/services/index.ts` that every
  root takes, its integration test at
  `apps/api/src/__tests__/services/<name>.int.test.ts` (the database lane;
  a `<name>.test.ts` runs in the unit lane, without a database), and an
  app's own rules win where they name other paths. The rules describe REST
  routes (`requireSession`, `sessionOf`, `qd.caller` with the user's
  grants), `qd.run` before `createServer`, the admin kit's grants field and
  `onWrite`, `hello.serverId`, `signInUrl` and `signOut`, and the
  template's provider path (F5.2).

#### Packaging

- The README the core package ships links what lies outside
  `packages/core` (the lint, skills and codemod packages, `docs/`, the
  migration guide) on GitHub: its relative links were dead inside
  `node_modules`. A test checks that no shipped Markdown copy links out of
  its package (F5.7).

#### The framework's own tests

- The end-to-end revocation test failed now and then on a busy machine:
  both `qd:revoked` frames of one access change invalidate the service's
  method queries, the second inside the coordinator's window after the
  first read, so a refused query is read once more about 250 ms later and
  shows neither data nor error meanwhile; the test checked that view at
  once. It now waits for that read's answer. The shared counter's and the
  cluster broadcasts' "does not wait" tests check that the call settles
  before any timer could fire instead of a 10 ms and a 25 ms wall-clock
  bound.

### [5.0.0-rc.3]

Round 2 of the fixes the quickdraw-chat migration found on `5.0.0-rc.1`
(findings F2.1 to F2.18, from its server port), and the room primitives
its game port needs. No version moves until the release candidate is cut.

#### Core

- A `via` collection's entry created or touched (`ctx.touch`, or an
  `upsert` that may have updated it) in a flush that also deletes one of its
  junction rows is `removed` from the scope that lost the link; before, the
  member kept the chat in their list (F2.1).
- `via({ model, entry, scope, refreshEntry: true })`: for an item read from
  the junction (a member count), every junction create, update or delete
  sends the entry again, `updated`, to each scope that still holds it, on one
  server and behind a cluster (F2.2).
- Rooms outside handlers: `qd.rooms`, `server.rooms` and `dispatcher.rooms`
  (`ServerRooms`) send a contract's room event (`emit`, `emitToUser`) from a
  game loop or a job, to every node. `rooms.leave(room, { userId })` (also
  on `ctx.rooms`) takes every socket of a user out of an app room on every
  node: they stop hearing it, a channel that requires the room drops their
  messages, each is sent `qd:presence { room, users: [] }`. Behind a cluster
  it is broadcast and answered (F2.9).
- `createServer({ onRoomLeave })`: once per socket that leaves app rooms
  (its own leave, a removal, a disconnect), on the node holding it, with the
  principal, the reason and each room's `last` (no socket of that user left
  in the room on any node, for a game's `playerLeft`), in a unit of work of
  its own; a throw is logged and `close()` waits for it.
- `qd.run(fn, { detached: true })` (and `dispatcher.run`): a unit of work of
  its own even inside a handler or a transaction, for background work the
  handler does not await (F2.8).
- `everyone(level)`: every signed-in user has `level` on every row (public
  profiles: `anyOf(owner("id"), everyone("Read"))`), covering subscriptions
  and lists as `rowless: true` on a method does not. `anyOf` with a member
  that lets every row through filters nothing out (Prisma reads `{}` inside
  `OR` as matching nothing) (F2.7).
- The admin kit edits grants with `admin.handlers(contract, { grants: true })`:
  `serviceAccess` is shown and written, for callers whose service-wide grant
  is `Admin` only, whatever form a method runs under; the tracked write
  refreshes the user's sockets like any grant change. Hidden and unwritten
  by default, as before (F2.3).
- Behind a cluster, a joining socket's presence list, read from every node,
  is dropped when the socket left the room before it arrived.

#### Auth

- `requireSession({ sessions, jwtSecret })`: an Express middleware for the
  app's own REST routes over the auth routes kit's sessions, verifying the
  JWT once and setting `req.userId` and `req.sessionId` (F2.11).
- The guest route answers `{ userId, name? }` when `createUser` returns
  `{ userId, name }`, and the session's `token` with
  `guest({ createUser, token: true })`, for clients without cookies (F2.12).
- `socketAuth({ devCredentials })` signs a socket in by the user id its
  handshake names, for editors and load-test bots; it throws when given in
  production and refuses such a handshake there anyway (F2.13).
- `google.optional(...)` and `discord.optional(...)` build nothing without
  credentials, and `createAuthRoutes` skips `undefined`, `null` and `false`
  providers (F2.14).

#### MCP

- When stdin ends, the stdio server lets the calls in flight finish and
  writes their replies before `closed` resolves; `close()` still cancels
  them (F2.10).
- The docs say the tool list is the same for every caller, not filtered by
  the principal (F2.17).

#### Testing

- `app.as(principal)` loads a principal's grants through
  `auth.loadServiceAccess` when it carries none, at each call, as a socket's
  and an HTTP call's are loaded (F2.6).
- `describeAccessMatrix`: a case's `input` may be a function of the cell
  (`{ name, principal }`), so a mutation that runs once per row gets a fresh
  row in every cell, whatever the order of the principals (F2.16).

#### Codemod

- An `[error]` marker on each `throw new Error(...)` in a migrated handler:
  4.x sent the message to the caller, 5.0 answers it with a generic
  `INTERNAL` unless it is a `QuickdrawError` with a code (F2.5). The report
  is formatted with the app's formatter since `5.0.0-rc.2` (F2.18).

#### Docs

- `MIGRATION.md`: "Hand-built auth to the auth routes kit": the `Session`
  table and its migration from a 4.x token-keyed table, the route and
  `?error=` code renames, `onLogin`, optional providers, development
  credentials, a custom flow on `issueSession`, the cookie's name (F2.4).
- A projection's relation count selects the relation's ids and counts them
  in `map`: Prisma's `_count` aggregates the whole relation table on every
  read (F2.15).
- `docs/releasing.md`: push release tags one at a time; GitHub starts no
  workflow for more than three tags in one push.

### [5.0.0-rc.2]

Round 1 of the fixes the quickdraw-chat migration found on `5.0.0-rc.1`
(findings F1.1 to F1.15). No version moves until the release candidate is
cut.

#### Core

- A handler may return a Prisma row whose `Json` column (`JsonValue`) sits
  where the wire has an object, an array or a record: `RowFor` accepts a
  JSON column's value there (`JsonColumnValue`, on `./server`). String,
  number and boolean columns are checked as before; the output schema checks
  the JSON's shape outside production (F1.4).
- A field the contract's `fields` map tiers is optional in the rows a reader
  receives: `EntityOf`, `ProjectionOf`, `ItemOf`, the projection outputs of
  `OutputOf`, so `useEntity`, `useEntities`, `useCollection` items, method
  results, server callers and the testing mocks. `FullProjectionOf` (new)
  keeps every key, and handlers, `project` and `map` use it. Index rows stay
  whole: a collection refuses an index field its tier hides (F1.5).

#### Lint

- `quickdraw-lint baseline` records every rule's violations, oxlint's own
  too (keyed by the code oxlint reports them under). New:
  `quickdraw-lint check`, the lint command for an app with a baseline: it
  runs oxlint, applies the baseline to oxlint's native rules as the quickdraw
  rules apply it to themselves, reports their unused allowances as
  `no-unused-baseline`, and exits 1 on a remaining error. A file oxlint
  cannot parse is never recorded (F1.3).
- `oxlint.base.jsonc`'s path overrides are `**/`-prefixed, so explicit types
  in `packages/shared` and `packages/db` and the web app's relaxed budgets
  apply when lint runs from a package directory (F1.10).
- `oxlint.template.jsonc` extends the base: a template app extends it alone
  (F1.15).

#### Codemod

- A service class's fields are kept as marked module bindings with their
  initializers, its getters as functions its reads call, and its
  constructor's other code, field assignments included, in an exported
  `setUp<Service>(...)` that takes the constructor's parameters it uses.
  Nothing is dropped silently but the Prisma client's field and a field
  holding another service (whose uses are marked) (F1.1).
- A call of the 4.x base class (`super.x(...)`) is dropped under a marker
  that names it: the output always parses, which a new test checks on every
  file (F1.2).
- It formats what it writes with the app's formatter (oxfmt, prettier or
  Biome, when installed), builds the report from the formatted files and
  writes its table the way formatters do, so the output passes a format
  check and a second run changes nothing at all (F1.6).
- A wrapper hook's file of helper types goes with the wrappers (F1.7).
- A marker is never a trailing comment: inside a one-line literal it goes
  above the line (F1.8).
- In the web app, a local type only a rewritten hook's type arguments named
  goes, a one-argument `UseCollectionResult<Item>` gets its second argument,
  and an import left with only `type` names becomes `import type`. Handlers
  in a file whose helpers import the tracked `db` use it rather than shadow
  it (F1.3, F1.9).
- A 4.x `DTO | null` mutation of one row answers `"entity"`, marked in the
  contract and above its handler: a tracked write throws `NOT_FOUND` rather
  than answering null, and only `"entity"` is optimistic by default (F1.12).
- A service inside a template carve-out (`quickdraw-game:start` ...
  `:end`) keeps its markers in `contracts/index.ts` (and around helpers only
  it uses), its new contract file carries a `[carve-out]` marker the report
  lists under "Carve-outs", and an entity key a DTO declares inside a
  carve-out keeps the carve-out's markers in the contract's `keys` (F1.13).

#### Packaging and guides

- The codemod ships `UPGRADE-PROMPT.md` beside `MIGRATION.md`, both with
  their links pointing at the repository on GitHub; the core README says
  where they ship (F1.11).
- `UPGRADE-PROMPT.md` and the `quickdraw-migrate-v5` skill say which steps
  cannot leave the typecheck green (the upgrade, the codemod) and what must
  hold after each, and adopt lint with a baseline and `quickdraw-lint check`
  (F1.14).
- The four packages' `bin` paths drop their `./` prefix, which `npm publish`
  reported as `"bin[...]" script name ... was invalid and removed` (F1.15).

### [5.0.0-rc.1]

The first published release candidate (`5.0.0-rc.0` below was cut on
`dev` but never published; this one carries it plus pack H).

The next release candidate: pack H on top of `5.0.0-rc.0`. The four
packages move to `5.0.0-rc.1` when it is tagged
([`docs/release-checklist-5.0.md`](docs/release-checklist-5.0.md)).

#### Pack H: agent guardrails, the multi-node proof and non-JS clients

- **Breaking for `5.0.0-rc.0` users.** On a service with an access policy,
  `defineService` refuses a method whose input may carry a top-level `id`
  (in any branch of a union, and beside a `Date`, a `Set` or another value
  JSON Schema cannot write) under a form that checks no row (`"public"`,
  `"authenticated"`, `{ service: L }` below `Admin`): anyone the form admits
  would reach any row by its id. The message names the method and the two
  ways out: a form the policy decides (`{ entry: L }`, or
  `{ service: L, entry: L }` to keep a grant), or `rowless: true` on the
  method when every caller the form admits may reach any row on purpose.
  Kits take it as `rowless: [names]` in their options (`crud.handlers`,
  `admin.handlers`, `sharing.handlers`). Not checked: an input without JSON
  Schema (Zod 3), an input that is the id itself, and a row named by
  another key. The codemod writes `rowless: true`, marked, where it maps a
  4.x method that named a row to a form that checks none.
- Revisions are microseconds since the epoch: Valkey's clock behind a
  cluster, and on one server `max(Date.now() * 1000, last + 1)`. A client
  still compares them as opaque numbers (safe integers); `versionColumn`
  times compare as their milliseconds times 1,000.
- Lint: `prefer-kit` (a warning) reports a method written by hand that a
  kit implements (`get`, `list`, `create`, `search`, `share`, `adminList`,
  ..., or `getTask`, `listTasks`, `createTask`, `updateTask` and
  `deleteTask` for model `"task"`; `remove` only on a membership model or
  beside another sharing method) in a service that spreads no kit (a spread
  variable or call counts as one). A
  `// quickdraw: hand-written because <reason>` comment above it keeps it.
  The codemod marks such methods `[kit]` in its report.
- Loop warnings, in development: the server's `repeated-call` (one
  connection sends the same call with the same input more than 10 times
  within a second, or is refused `RATE_LIMITED` more than 30 times within a
  minute; thrown in a test app made with `strictWarnings`); the client's
  `repeated-mutation` (one `useMutation` mutates more than 5 times within a
  second, named with its component) and `repeated-invalidation`
  (`qd.invalidate` asks for one query key more than 20 times within a
  second, or the invalidation coordinator refetches it that often; counted
  after the coordinator's coalescing, so a busy watched topic is not named).
- `createServer({ cluster: { client?, keyPrefix?, timeoutMs? } })` runs
  several nodes behind `@socket.io/redis-adapter` on Valkey
  ([`docs/deploying.md`](docs/deploying.md)). Flushes share one order from a
  counter key (`{keyPrefix}:rev`) that needs persistence or replication: a
  lost key is warned about once and starts again at Valkey's clock, and a
  counter that does not answer puts the node on its own clock until a
  probe answers. Behind a cluster, unlike on one server: entity and
  collection changes go out as whole rows (`u`, `updated`), decided by the
  row read at flush time; a flush costs one counter round trip and a read a
  GET of it; access changes and reloaded grants are broadcast and
  acknowledged, failing open after `timeoutMs`, and after one goes
  unanswered broadcasts stop waiting until every node answers a probe; a
  push to a seeded stream goes to every node; `lastSeen` is kept in Valkey
  for 30 days; a node whose Valkey subscription comes back sends its own
  clients `qd:rotate` so they catch up; `close()` lets the node's sockets
  leave while the other nodes still hear it. A publish node-redis rejects
  while Valkey is down is logged once per outage instead of ending the
  process as an unhandled rejection. The proof is `bun run test:cluster`
  (two nodes, a real Valkey) and CI's `cluster` job.
- Channels take `requires: { room: RoomSelector }`: the app room the
  sending socket itself must have joined, a name or a function of the
  payload, checked in memory and failing closed.
- Docs and examples: [`docs/protocol-v5.md`](docs/protocol-v5.md), the
  wire for clients in other languages, generated from the protocol's
  sources (`bun run protocol:sync` in `packages/core`; CI checks it), with
  its fixed limits apart from its defaults;
  [`docs/clients.md`](docs/clients.md), the ways in;
  [`docs/deploying.md`](docs/deploying.md), several nodes, Valkey and Cloud
  Run; and [`examples/godot`](examples/godot), a GDScript client for
  Godot 4 that CI runs against a real server, which keeps its socket
  through a `qd:rotate` window and reconnects with full jitter.

### [5.0.0-rc.0] (never published)

The release candidate for quickdraw 5.0, published under npm's `next`
dist-tag for all four packages: `@fitzzero/quickdraw-core`,
`@fitzzero/quickdraw-lint`, `@fitzzero/quickdraw-skills` and
`@fitzzero/quickdraw-codemod`. 5.0 rebuilds what a 4.x app is written
against (services, access, the wire protocol, the client hooks), so every
app migrates: start with [`MIGRATION.md`](MIGRATION.md), which lists every
removed 4.x name with its replacement, and run the codemod it describes.
`legacyWire: true` keeps 4.x request and response callers working during a
rollout. The design is [`docs/rfcs/0003-v5.md`](docs/rfcs/0003-v5.md)
(section 17 records each decision made while building it), the rationale
[`docs/rfcs/0003-v5-audit.md`](docs/rfcs/0003-v5-audit.md).

#### Pack A: foundations

- A bun workspace with turbo holding the four packages and the private
  benchmark harness, with the 4.1.0 baseline recorded. CI on every pull
  request (lint, format, typecheck including tests, build, dist smoke test,
  publint, arethetypeswrong, tests, secret scan) and owner-triggered,
  tag-driven publishing with npm trusted publishing (`docs/releasing.md`).
- The 4.1 modules 5.0 keeps (auth helpers, Express rate limits, the socket
  rate limiter, the Redis adapter helper, env and encryption utilities),
  with 4.1's packaging defects fixed.

#### Pack B: core runtime

- Contracts (`defineContract`, `query`, `mutation`) shared by server and
  client; protocol v5, one `qd:call` envelope with a version handshake and a
  JSON-only parser; a method pipeline with validation, access,
  not-modified replies, `share`, cancellation, time limits and per-socket
  concurrency caps; `QuickdrawError` codes.
- `qd.createServer` on the app's own Express app, transports for Socket.IO,
  HTTP (`POST /qd/{service}/{method}`), in-process callers and MCP, and the
  `legacyWire` shim for 4.x callers.

#### Pack C: data plane

- Tracked writes (`trackPrisma`): entity frames and collection deltas
  follow from the writes themselves, so hand emits are gone.
- Access is declared and closed by default: a form per method and one row
  policy (`owner`, `jsonAcl`, `members`, `inherit`, `anyOf`, `resolver`) for
  every surface, with automatic revocation. Projections and field tiers,
  entity subscriptions by revision, and collections with keyset paging,
  resume, a whole-scope index, views and change topics.

#### Pack D: client

- `createQuickdrawClient(contracts)`: typed `qd.<service>.<member>` hooks
  with no wrapper files or string names, and a provider that runs without
  DOM globals. An invalidation coordinator, optimistic entity mutations,
  live entities and collections, and `./testing/client`.

#### Pack E: kits

- Read/write, search, sharing and membership, admin, presence, streams and
  channels, and auth routes (`createAuthRoutes`, `socketAuth`: Google,
  Discord, mock and guest sign-in, sessions, `__Host-` cookies), all through
  the same pipeline, access and emits.

#### Pack F: enforcement

- `@fitzzero/quickdraw-lint`: 19 oxlint rules with tests and baselines;
  `no-v4-api` names every removed 4.x API and its replacement. Budgets
  (`expectBudget`), development warnings, a stall watchdog and an
  OpenTelemetry hook.
- `@fitzzero/quickdraw-skills`: agent rules and skills, linked into
  `.claude/` by `quickdraw-skills link`; `quickdraw-docs` renders API pages
  from contracts.

#### Pack G: proof and release

- The benchmark against 4.1.0 (below); `@fitzzero/quickdraw-codemod` with
  the migration guide (`MIGRATION.md`, `UPGRADE-PROMPT.md`, the
  `quickdraw-migrate-v5` skill); the release checklist
  (`docs/release-checklist-5.0.md`) and an upgrade brief per app
  (`docs/downstream/`).
- The pack G finale round fixes:
  - A shared run's result is stripped and JSON-encoded once per group of
    callers whose levels hide the same fields, not once per caller, and the
    socket transport sends each caller of a group the same bytes; a
    transport's `respond` receives that copy (`SharedData`).
  - The socket rate limiter allows 600 events per minute per socket by
    default (it was 100), in `createServer` and in `createRateLimiter()`
    without `maxRequests`.
  - `<QuickdrawProvider reconnectJitterMs>` sets the longest random delay
    before a watched or stale query is refetched after a reconnect (2,000 ms
    by default, `0` at once); the coordinator's `refetchAfterReconnect`
    takes the same as `jitterMs`.
  - An unannotated function `id` selector in one method no longer widens
    `ctx.principal` to nullable in a service's other methods, and
    `MethodImplementation<…, "authenticated">` with `satisfies` takes every
    access form but `"public"`, `{ service, entry }` included. The codemod
    writes `id` functions unannotated and types `MethodOf` for
    `"authenticated"`.
  - One rule names the session cookie, written and read
    (`sessionCookieNameFor`): `createAuthRoutes`, `setSessionCookie`,
    `socketAuth`, the HTTP transport and `extractBearerOrCookieToken` give
    a request a configured name, else `session` when the cookie has a
    domain, else `__Host-session` over HTTPS (`req.secure`,
    `X-Forwarded-Proto: https`, an `https:` `Origin`, or an OAuth
    callback's `https:` return origin) and `session` over plain HTTP, and
    each reads first the name it would set. Over HTTPS without a domain the
    plain `session` is never read, so a planted plain cookie cannot stand in
    for `__Host-session`. The transports read `COOKIE_DOMAIN` as the routes
    do; a `cookie.domain` given only to the routes logs a startup warning
    until the cookie is named.
  - `AdminFieldConfig.filterable` is optional (default `false`), so 4.x
    field configurations still type.
  - The codemod: a file that already binds a service object's name imports
    it under an alias (no more `const chatService = chatService`); every
    workspace package that depends on quickdraw is migrated, with
    `server/testing/prisma` rewritten to `testing/prisma`; uses of a 4.x
    instance's members, a dynamic `import()` of a service class and a
    hook's `error` read as a string are marked; a `jsonAcl("acl")` it
    writes is marked for duplicate list entries (5.0 takes the highest
    level, 4.x took the first); a dry run lists the report as `A` when it
    would create it; and its published manifest names no `workspace:`
    range.
  - The docs: the README's installs carry `@next`, its quick start
    authenticates with `socketAuth` and shows the pieces it imports, and
    no example keeps a trailing comment (a test lints every example with
    `oxlint.base.jsonc`); `MIGRATION.md` lists the peers' new floors; the
    benchmark report's figures are recomputed from its data.

#### Benchmark

5.0 against 4.1.0 on one machine in one sitting (`bench/reports/5.0.0.md`;
board-steady: 600 writes to a board 50 viewers watch): the board query's p95
is 0.28× (122 to 34.6 ms), SQL statements per write 0.25×, server CPU per
write 0.55×, and a reconnect storm serves no snapshots (11,590 in 4.1).
Missed or worse: bytes per write 0.89×, against a target of 0.30×, because
the benchmark app keeps a fat watched board query (a collection's index is
the fix: `MIGRATION.md`, "Boards"); event-loop delay p99 1.7× to 3.7× (5.1×
in fat-read, where the two 4.1 runs disagree by 43%), from a shared run's
replies encoded back to back (the finale round's first fix);
drain after the last write 0.51 s against 0.26 s (the coordinator's 250 ms
window); restoring a watched query after a reconnect storm, p50 968 ms
against 10 ms (the deliberate 0 to 2 s refetch jitter, now
`reconnectJitterMs`); peak memory in that storm 1.17× (not explained yet).
Measured on 5.0.0-alpha.0, before the finale round; `bench/reports/5.0.0.md`
now holds the rerun on the final code ([5.0.0], Benchmark).

## [4.1.1] - 2026-10-04

### Fixed

- The socket rate limiter no longer crashes the process when a client sends
  an event whose name is not a string. Socket.IO accepts a numeric event
  name; `applyRateLimitMiddleware` called `eventName.startsWith` on it inside
  `process.nextTick`, an uncaught `TypeError` that exited the server. Such
  events now pass the limiter uncounted. (A 4.x patch, on the `release/4.x`
  branch; 5.0 carries the same guard.)

## [4.1.0] - 2026-08-01

Client portability groundwork for non-DOM runtimes (React Native, workers).
The client package's only browser touchpoints are now the optional
`localStorage` token helpers in `utils/auth` — the provider and every hook
run without `document`/`window`.

### Added

- `QuickdrawProvider` accepts a `transports` prop (default
  `["websocket", "polling"]`, socket.io's browser behavior). React Native
  clients should pass `["websocket"]` — the polling fallback assumes browser
  XHR semantics. Applies whenever the socket is (re)created, including
  `authToken`-change reconnects.

### Fixed

- `useSubscription` with `refetchOnWindowFocus: true` no longer crashes in
  runtimes without `document` (React Native, workers) — the visibility
  listener is inert there; reconnect re-subscription already covers the
  app-resume case.

## [4.0.0] - 2026-07-28

The collection-subscriptions major (RFCs 0001 + 0002, `docs/rfcs/`). See
`UPGRADE-PROMPT.md` for the 3.x → 4.0 migration guide.

### Added

- **Collection subscriptions** — the missing primitive for live lists. A
  collection is "rows of this service, grouped by a scope id derived from the
  row"; membership is a pure function of the row:
  - `defineCollection(name, { resolveScopeId, checkScopeAccess, snapshot, toItem?, defaultLimit?, revOf? })`
    declared in the constructor next to `defineMethod`/`defineChannel`, with a
    new `TCollections` generic on `BaseService`. `resolveScopeId` may return
    `null` (predicate filtering) or `string[]` (fan-out scopes).
  - The CRUD trio emits `added`/`updated`/`removed` deltas to scope rooms
    automatically, including scope moves (removed-from-old + added-to-new) and
    predicate entry/exit — no more hand-typed `*:created/deleted` events.
  - Manual choke points for hand-rolled write paths: `emitCollectionUpsert`,
    `emitCollectionRemove`, `emitCollectionMove`, `emitCollectionReset`, plus
    adapter-safe `kickFromCollection(collection, scopeId, userId?)`.
  - Wire protocol: `{service}:collection:subscribe` (cursor-less calls join the
    scope room and may carry a full membership `ids` list, capped at 5,000 with
    `idsTruncated`; cursor-bearing calls are pure paging) and
    `{service}:collection:unsubscribe`. Deltas carry per-item last-writer-wins
    `rev`s; reconnect correctness comes from re-snapshot + `ids` pruning, not
    an event log.
  - Client: `useCollection(serviceName, collection, scopeId, options)` →
    `{ items, byId, totalCount, isLoading, hasMore, loadMore, refresh, … }`,
    riding the existing ref-counted subscription registry (dedup across
    components, re-snapshot on reconnect). Merge logic lives in the pure,
    exhaustively tested `collectionCache` module: id-keyed upserts, rev LWW,
    removal tombstones, delta buffering during in-flight snapshots, cursored
    page merge that never prunes.
  - ACL model: collection items are _scope-visible_ — anyone passing
    `checkScopeAccess` sees every item in full. Strip sensitive fields in
    `toItem`/`snapshot`; per-subscriber tiering inside a collection is
    deliberately unsupported.
- **Write lifecycle hooks** on `BaseService`: `beforeCreate`/`afterCreate`,
  `beforeUpdate`/`afterUpdate`, `beforeDelete`/`afterDelete`. `before*` may
  veto by throwing; `delete()` finally sees the deleted row. The pre-write
  fetch happens only when a service has collections or overrides an
  update/delete hook.
- **`TDto` generic + `toDto()`** — services whose wire shape differs from the
  Prisma row declare it once; `emitUpdate(id, data: Partial<TDto>)` kills the
  `dto as unknown as Partial<TEntity>` cast. `toDto` feeds auto-emission,
  subscribe payloads, and default collection items.
- **Richer socket auth** in `createQuickdrawServer`: `authenticate` may return
  a structured `QuickdrawIdentity` (`{ userId?, principalType?, claims?,
serviceAccess? }`) for multi-principal apps; new `loadServiceAccess(userId)`
  callback replaces the long-standing empty-serviceAccess TODO; the server now
  actually emits `auth:info` (`{ userId, serviceAccess, principalType }`); and
  authenticated sockets join `user:{userId}` so `emitToUserRoom` works out of
  the box.
- **`BaseRpcService`** — first-class delegate-less services (methods,
  channels, ACL, room emits; no CRUD, no subscriptions). Replaces the
  `BaseService<never, never, never, TMethods>` contortion.
- **Typed room events**: augmentable `QuickdrawEventMap` types
  `emitToRoom`/`emitToRoomVolatile`/`emitToUserRoom` and `useRoomEvents`, with
  graceful degradation to `string`/`unknown` while the map is empty.
- **Static room helpers** from the package root: `serviceRoom`,
  `serviceFullRoom`, `collectionRoom`, `collectionEventName`, `userRoom` —
  usable from shared modules and when emitting into another service's rooms.
- **Client query fixes**: `useServiceQuery` passes through `refetchInterval` /
  `refetchIntervalInBackground`; rate-limit backoff (server `RATE_LIMITED`
  reports and 429 acks pause all reads until the window elapses — rejected
  events would otherwise re-trip the limiter forever); hook errors carry the
  server code via `ServiceCallError`; `reconnectBehavior:
"invalidate-queries"` (opt-out) on `QuickdrawProvider` heals plain query
  reads after reconnects.
- **ESLint plugin**: new `quickdraw/no-manual-collection-events` (warn in the
  base config's services override) flags hand-emitted
  `*:created/deleted/updated/reordered` events; the existing
  `no-direct-prisma-mutations` rule is now registered.

### Changed (breaking)

- **`emitUpdate` is room-based and two-tier.** Elevated subscribers join
  `{service}:{id}:full` at subscribe time; full payloads go to the full room,
  protected-fields-stripped payloads to everyone else. This fixes entity
  updates never crossing nodes under the Redis adapter. Consequences:
  - The per-socket emission fallback is removed — `emitUpdate`, `emitToRoom`,
    and `emitToRoomVolatile` require the service to be registered (`setIo`).
  - The subscriber's tier is fixed at subscribe time (a `serviceAccess` change
    takes effect on re-subscribe), and live emits have exactly two tiers; a
    custom `filterEntityForSubscriber` still shapes initial subscribe payloads.
  - `emitUpdate(entryId, data)` takes `Partial<TDto>` (was `Partial<TEntity>`).
- **`subscribe`/`batchSubscribe` return DTO-shaped data**
  (`Partial<TDto> | null`), mapped through `toDto` and filtered per tier.
  `filterEntityForSubscriber`/`getProtectedFields`/`stripProtectedFields`
  retype from `TEntity` to `TDto`.
- **Admin types deduped to one canonical shape each** (the shapes the server
  actually sends): `AdminListPayload {page?, pageSize?, where?, orderBy?}`,
  `AdminListResponse {items, total, page, pageSize, totalPages}`,
  `AdminSetACLPayload {entryId, acl}` (replacing `AdminSetEntryACLPayload`),
  `AdminSubscribersResponse {entryId, subscribers, count}`, and
  `{entryId}`-keyed payloads + truthful responses for
  getSubscribers/reemit/unsubscribeAll. The divergent aspirational variants in
  the root export are gone.
- `adminUnsubscribeAll` evicts subscribers via rooms (adapter-safe,
  cluster-wide) instead of only clearing the local map.
- `create()`/`update()` emit `toDto(entity)` instead of the raw entity.

### Fixed

- Entity updates now propagate across nodes with the Redis adapter (the
  `subscribers`-map iteration never did; it remains only for
  `adminGetSubscribers` introspection).
- `useServiceQuery` no longer silently ignores `refetchInterval`.
- The client `auth:info` listener finally has a server counterpart.
- `SocketTextField` no longer swallows a consumer-provided `type` or `onBlur`
  (the defaults-after-options footgun class from the option-merge audit).

## [3.9.1] - 2026-07-03

### Fixed

- Session cookies default `maxAge` to 7 days (was 30), matching the default
  JWT expiry — a cookie that outlives its JWT just keeps sending a token the
  server rejects. Pass `maxAgeMs` to `setSessionCookie` if your JWT lifetime
  differs. (Backfilled entry; 3.9.1 shipped without one.)

## [3.9.0] - 2026-07-03

### Added

- **Shared oxlint base config** — `oxlint.base.jsonc` ships with the package; consumers extend it from their root `.oxlintrc.json` (`"extends": ["./node_modules/@fitzzero/quickdraw-core/oxlint.base.jsonc"]`) so framework lint best practices update with the package. Includes the strict rule set (type-safety `no-unsafe-*` family, complexity budgets, pedantic category) and pre-wires the `quickdraw` jsPlugin with path-scoped overrides for `services/**`, client code, shared/db packages, and tests. See README "Linting" for merge-semantics caveats (`plugins`/`ignorePatterns` are not inherited). The `./eslint-config` ESLint flat-config export is now considered legacy.

### Changed

- Repo now dogfoods the base config via `.oxlintrc.json` (the previous `oxlintrc.json` was never auto-discovered by oxlint — the repo was linting with defaults). Pre-existing violations are downgraded to `warn` as tracked debt.
- Removed legacy `.cursor/` and `.serena/` tooling configs and the stale `pnpm-lock.yaml` (bun is the package manager); added `CLAUDE.md`.

## [3.8.0] - 2026-07-02

### Added

- **Channels** — first-class fire-and-forget events for high-frequency traffic (game input, cursor positions, typing indicators), the counterpart to request/response methods:
  - `BaseService.defineChannel(name, access, handler, { schema, ratePerSecond, burst, requireRoom })` with a new 5th `TChannels` type param on `BaseService`. No ack, no response; zod validation required; handler errors are logged, never sent to the client.
  - Per-socket, per-channel token bucket (`ratePerSecond`, default 30; `burst`, default 2×) replaces the global rate limiter for channel events. Excess messages are silently dropped; sustained extreme flooding disconnects the socket.
  - Access checks are fully synchronous and in-memory: auth always required; `Moderate`/`Admin` check `socket.serviceAccess`; entry-level access via `requireRoom` (socket must already be in the room, which was ACL-gated at subscribe time). Zero DB reads on the hot path.
  - Channels route as `channel:<serviceName>:<channelName>` — shared helper `channelEventName()` + `CHANNEL_EVENT_PREFIX` exported from the root entry, making the wire contract easy to speak from non-JS clients (e.g. game engines).
  - `BaseService.emitToRoomVolatile(room, event, data)` — volatile room broadcast for tick-rate server→client state (backpressured clients drop frames instead of queueing).
  - Client: `useChannelSend(serviceName, channelName)` → `{ send, isReady }` (volatile emit). Receiving needs nothing new — pair with `useRoomEvents`.
  - Shared types: `ServiceChannelDefinition`, `ServiceChannelContext`, `ServiceChannelMap`.
- **`excludePrefixes` option** for `createRateLimiter` — skip rate limiting for event-name prefixes; pass `[CHANNEL_EVENT_PREFIX]` so channel traffic bypasses the global limiter.
- **`socketPath` prop** for `QuickdrawProvider` — custom Socket.io path for path-rewriting proxies (e.g. Discord Activities require `/.proxy/api/socket.io`).

## [3.7.0] - 2026-06-09

### Added

- **Mock OAuth provider** (`/server`): `createMockOAuthProvider`, `registerMockOAuthProvider`, `isMockOAuthEnabled` — a real authorization-code flow served by the app's own API for local development. Renders a seeded-user picker, mints single-use codes and short-lived tokens in memory, and returns GoogleUser-compatible userinfo with `id` = email (stable `providerAccountId` across re-seeds). Hard-blocked in production: routes never mount, and handlers re-check `NODE_ENV` per request. Enable with `ENABLE_MOCK_OAUTH=true`.
- **Origin validation** (`/server`): `validateRedirectOrigin` + `OAUTH_RETURN_ORIGIN_COOKIE` for OAuth redirect/CORS allowlisting — CLIENT_URL, `EXTRA_ALLOWED_ORIGINS`, GitHub Codespace origins, localhost in dev, and app-specific `allowedPatterns`.
- **Session cookies** (`/server`): `setSessionCookie` / `clearSessionCookie` / `SESSION_COOKIE` — httpOnly, secure + SameSite=None in production (cross-site API origins), Lax in dev, optional `COOKIE_DOMAIN`.
- **REST auth middleware** (`/server`): `createRequireAuth({ getSession })` — session-cookie or Bearer JWT auth with injected session revocation lookup; plus `extractBearerOrCookieToken`.
- **Encryption utilities** (`/server`): AES-256-GCM `encrypt` / `decrypt` / `isEncrypted` / `decryptIfEncrypted` / `tryDecrypt` keyed by `ENCRYPTION_KEY` (64-char hex) for at-rest secrets like stored OAuth tokens.
- **New subpath `/server/express`**: Express rate-limit factories (`createAuthLimiter`, `createWebhookLimiter`, `createPublicApiLimiter`, `createJsonRateLimiter`, …) built on the optional `express-rate-limit` peer. JSON 429 body + Retry-After.
- **New subpath `/server/testing/prisma`**: dual-mode Prisma test databases — `createPrismaTestGlobalSetup` picks real PostgreSQL (per-worker databases cloned from a migrated template DB) when `TEST_DATABASE_URL` is set, else PGlite with a fingerprint-cached gzip data-dir template. Also exports `resetDatabase` (dynamic TRUNCATE with deadlock retry), `workerDatabaseUrl`, `buildPgliteTemplate`, `setupPostgresWorkerDatabases`, and friends. Optional peers: `@electric-sql/pglite`, `pg`.
- **ESLint plugin rules**: `no-raw-service-room-string` (configurable `additionalPatterns`), `no-raw-button-strings`, `no-raw-tooltip-strings`, `no-raw-typography-strings`.

## [3.6.0] - 2026-04

### Added

- `refetchOnWindowFocus` option for `useSubscription`

## [3.4.0] / [3.3.x] / [3.2.0] - 2026-03

### Added

- 3.4.0: `useRoomEvents` hook and `invalidateOn` option for `useServiceQuery` (changelogged below under its original 1.3.0 heading)
- 3.3.x: `defineMethod` visibility opened up in `BaseService` for external access
- 3.2.0: subscription batching (`batchSubscribe`)

## [3.5.0] - 2026-03-27

### Fixed

- `batchSubscribe` now joins socket rooms for all ACL-allowed IDs before entity resolution, matching `subscribe()`'s behavior. Previously, clients batch-subscribing to an ID that passed access checks but had no entity yet would not join the room and would miss future updates. This is a non-breaking behavioral fix — return values are unchanged (missing entities still return `null`), but sockets now correctly receive updates for entities created after subscription time.

## [1.3.0] - 2026-03-20

### Added

- `useRoomEvents` hook for lifecycle-managed custom socket event listeners
  - Handles `socket.on`/`socket.off` cleanup automatically
  - Re-attaches listeners on reconnect
  - Handler functions stored in refs to avoid effect churn
  - Pair with `useSubscription` (room membership) for room-scoped events
- `invalidateOn` option for `useServiceQuery`
  - Listens for socket events and auto-refetches the query
  - Debounces rapid-fire events within 100ms
  - Ideal for keeping list queries in sync with real-time changes
- `UseRoomEventsOptions` type
- ESLint rule `no-raw-socket-on` — flags `socket.on()` in components, suggests `useRoomEvents`
- ESLint rule `no-raw-socket-emit` — flags `socket.emit()` in components, suggests `useService`/`useServiceQuery`
- Quickdraw ESLint plugin now included in `client` config with socket rules enabled as warnings

## [1.2.0] - 2026-01-17

### Added

- `useServiceQuery` hook for read operations with TanStack Query caching
  - Automatic request deduplication across components
  - Configurable `staleTime` and `gcTime` for cache management
  - `skipCache` option to force fresh fetch
  - `enabled` option for conditional fetching
  - Background refetching when data becomes stale
- `UseServiceQueryOptions` and `UseServiceQueryResult` types

### Fixed

- `useService` and `useServiceMethod` now return memoized objects to prevent infinite render loops when used in `useCallback`/`useEffect` dependencies

## [1.1.0] - Previous

### Added

- Subscription registry for deduplication across components
- HMR/Fast Refresh safe subscription handling

## [0.1.0] - Initial

### Added

- Initial package structure with server/client/shared subpath exports
- `BaseService` class with typed CRUD, subscriptions, and ACL support
- `ServiceRegistry` for auto-discovering and wiring service methods
- `createQuickdrawServer()` helper for one-liner server setup
- JWT utilities for token creation and verification
- OAuth providers for Discord and Google
- `QuickdrawProvider` with TanStack Query integration
- `useService` hook for typed service method calls
- `useSubscription` hook for real-time entity subscriptions
- Socket input components: Checkbox, TextField, Select, Slider, Switch
- Server and client testing utilities
