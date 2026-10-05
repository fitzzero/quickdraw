# Changelog

All notable changes to this project will be documented in this file.

## [5.0.0-rc.5] (unreleased)

Round 6 of the fixes the quickdraw-chat migration found: the framework
findings of the independent review of its finale (F7.1 to F7.8) and of its
last migration card on `5.0.0-rc.4` (F6.1 to F6.8). No version moves until
the release candidate is cut.

### Security

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

### Tracked writes

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
  made every watcher of the service's topic read again.
- An upsert whose `update` sets nothing reads its row in the upsert's
  place: `findUnique` with its `where` and selection answers it when the
  row exists (one statement, as the upsert was, and fewer in SQL than
  Prisma's own emulated upsert), and the upsert runs after the read only
  when the row is missing (one statement more, recorded as a create that
  may have found its row). In an array-form batch it is recorded as before.
- An `updateMany` with nothing to write answers `{ count: 0 }` through the
  tracked client too, as Prisma does (the rewrite to `updateManyAndReturn`
  answered the number of rows matched).

## [5.0.0-rc.4]

Rounds 3, 4 and 5 of the fixes the quickdraw-chat migration found: round 3
on `5.0.0-rc.1` (findings F3.1 to F3.11, from its web port), round 4 on
`5.0.0-rc.3` (findings F4.1 to F4.14, from its game and the Godot client on
protocol v5), round 5 on `5.0.0-rc.3` (findings F5.1 to F5.7, from its
template polish). No version moves until the release candidate is cut.

### Protocol

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

### Realtime

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

### Kits

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

### Testing

- `app.frames` and `frames.waitFor` take an event query with `where`, a
  predicate over the event's frames with `data` typed by the event
  (`EventQuery<E, D>`), and `./testing` adds `streamFrames(contract, stream,
where?, scope?)` and `eventFrames(contract, event, where?)`, which match
  one stream's items or one event's payloads typed by the contract. Realtime
  tests cast `StreamFrame` and `EventFrame` by hand before (F4.13).

### GDScript reference client

- `is_subscribed(service, stream, scope)` (true while the client holds
  the feed, which it subscribes to again after each reconnect) and
  `off_event(service, event, callback)`; `check:godot` checks both, and
  `server_id` (F4.11). Re-copy `addons/quickdraw/quickdraw_client.gd`: it
  also reads the positional `qd:stream` frame (F4.7, F4.12).

### Server

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

### Auth

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

### Client

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

### Testing

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

### Lint and codemod

- The policy builders listed in `no-v4-api`'s messages, the codemod's
  access markers and the upgrade procedure name `everyone`.

### API docs

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

### Skills

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

### Packaging

- The README the core package ships links what lies outside
  `packages/core` (the lint, skills and codemod packages, `docs/`, the
  migration guide) on GitHub: its relative links were dead inside
  `node_modules`. A test checks that no shipped Markdown copy links out of
  its package (F5.7).

### The framework's own tests

- The end-to-end revocation test failed now and then on a busy machine:
  both `qd:revoked` frames of one access change invalidate the service's
  method queries, the second inside the coordinator's window after the
  first read, so a refused query is read once more about 250 ms later and
  shows neither data nor error meanwhile; the test checked that view at
  once. It now waits for that read's answer. The shared counter's and the
  cluster broadcasts' "does not wait" tests check that the call settles
  before any timer could fire instead of a 10 ms and a 25 ms wall-clock
  bound.

## [5.0.0-rc.3]

Round 2 of the fixes the quickdraw-chat migration found on `5.0.0-rc.1`
(findings F2.1 to F2.18, from its server port), and the room primitives
its game port needs. No version moves until the release candidate is cut.

### Core

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

### Auth

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

### MCP

- When stdin ends, the stdio server lets the calls in flight finish and
  writes their replies before `closed` resolves; `close()` still cancels
  them (F2.10).
- The docs say the tool list is the same for every caller, not filtered by
  the principal (F2.17).

### Testing

- `app.as(principal)` loads a principal's grants through
  `auth.loadServiceAccess` when it carries none, at each call, as a socket's
  and an HTTP call's are loaded (F2.6).
- `describeAccessMatrix`: a case's `input` may be a function of the cell
  (`{ name, principal }`), so a mutation that runs once per row gets a fresh
  row in every cell, whatever the order of the principals (F2.16).

### Codemod

- An `[error]` marker on each `throw new Error(...)` in a migrated handler:
  4.x sent the message to the caller, 5.0 answers it with a generic
  `INTERNAL` unless it is a `QuickdrawError` with a code (F2.5). The report
  is formatted with the app's formatter since `5.0.0-rc.2` (F2.18).

### Docs

- `MIGRATION.md`: "Hand-built auth to the auth routes kit": the `Session`
  table and its migration from a 4.x token-keyed table, the route and
  `?error=` code renames, `onLogin`, optional providers, development
  credentials, a custom flow on `issueSession`, the cookie's name (F2.4).
- A projection's relation count selects the relation's ids and counts them
  in `map`: Prisma's `_count` aggregates the whole relation table on every
  read (F2.15).
- `docs/releasing.md`: push release tags one at a time; GitHub starts no
  workflow for more than three tags in one push.

## [5.0.0-rc.2]

Round 1 of the fixes the quickdraw-chat migration found on `5.0.0-rc.1`
(findings F1.1 to F1.15). No version moves until the release candidate is
cut.

### Core

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

### Lint

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

### Codemod

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

### Packaging and guides

- The codemod ships `UPGRADE-PROMPT.md` beside `MIGRATION.md`, both with
  their links pointing at the repository on GitHub; the core README says
  where they ship (F1.11).
- `UPGRADE-PROMPT.md` and the `quickdraw-migrate-v5` skill say which steps
  cannot leave the typecheck green (the upgrade, the codemod) and what must
  hold after each, and adopt lint with a baseline and `quickdraw-lint check`
  (F1.14).
- The four packages' `bin` paths drop their `./` prefix, which `npm publish`
  reported as `"bin[...]" script name ... was invalid and removed` (F1.15).

## [5.0.0-rc.1]

The first published release candidate (`5.0.0-rc.0` below was cut on
`dev` but never published; this one carries it plus pack H).

The next release candidate: pack H on top of `5.0.0-rc.0`. The four
packages move to `5.0.0-rc.1` when it is tagged
([`docs/release-checklist-5.0.md`](docs/release-checklist-5.0.md)).

### Pack H: agent guardrails, the multi-node proof and non-JS clients

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

## [5.0.0-rc.0] (never published)

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

### Pack A: foundations

- A bun workspace with turbo holding the four packages and the private
  benchmark harness, with the 4.1.0 baseline recorded. CI on every pull
  request (lint, format, typecheck including tests, build, dist smoke test,
  publint, arethetypeswrong, tests, secret scan) and owner-triggered,
  tag-driven publishing with npm trusted publishing (`docs/releasing.md`).
- The 4.1 modules 5.0 keeps (auth helpers, Express rate limits, the socket
  rate limiter, the Redis adapter helper, env and encryption utilities),
  with 4.1's packaging defects fixed.

### Pack B: core runtime

- Contracts (`defineContract`, `query`, `mutation`) shared by server and
  client; protocol v5, one `qd:call` envelope with a version handshake and a
  JSON-only parser; a method pipeline with validation, access,
  not-modified replies, `share`, cancellation, time limits and per-socket
  concurrency caps; `QuickdrawError` codes.
- `qd.createServer` on the app's own Express app, transports for Socket.IO,
  HTTP (`POST /qd/{service}/{method}`), in-process callers and MCP, and the
  `legacyWire` shim for 4.x callers.

### Pack C: data plane

- Tracked writes (`trackPrisma`): entity frames and collection deltas
  follow from the writes themselves, so hand emits are gone.
- Access is declared and closed by default: a form per method and one row
  policy (`owner`, `jsonAcl`, `members`, `inherit`, `anyOf`, `resolver`) for
  every surface, with automatic revocation. Projections and field tiers,
  entity subscriptions by revision, and collections with keyset paging,
  resume, a whole-scope index, views and change topics.

### Pack D: client

- `createQuickdrawClient(contracts)`: typed `qd.<service>.<member>` hooks
  with no wrapper files or string names, and a provider that runs without
  DOM globals. An invalidation coordinator, optimistic entity mutations,
  live entities and collections, and `./testing/client`.

### Pack E: kits

- Read/write, search, sharing and membership, admin, presence, streams and
  channels, and auth routes (`createAuthRoutes`, `socketAuth`: Google,
  Discord, mock and guest sign-in, sessions, `__Host-` cookies), all through
  the same pipeline, access and emits.

### Pack F: enforcement

- `@fitzzero/quickdraw-lint`: 19 oxlint rules with tests and baselines;
  `no-v4-api` names every removed 4.x API and its replacement. Budgets
  (`expectBudget`), development warnings, a stall watchdog and an
  OpenTelemetry hook.
- `@fitzzero/quickdraw-skills`: agent rules and skills, linked into
  `.claude/` by `quickdraw-skills link`; `quickdraw-docs` renders API pages
  from contracts.

### Pack G: proof and release

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

### Benchmark

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
Measured on 5.0.0-alpha.0, before the finale round.

## [4.1.1] - 2026-10-04

### Fixed

- The socket rate limiter no longer crashes the process when a client sends
  an event whose name is not a string. Socket.IO accepts a numeric event
  name; `applyRateLimitMiddleware` called `eventName.startsWith` on it inside
  `process.nextTick`, an uncaught `TypeError` that exited the server. Such
  events now pass the limiter uncounted. (A 4.x patch released from `main`;
  5.0 carries the same guard.)

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
