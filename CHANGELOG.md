# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Upgrading from 5.1.3

What an app on 5.1.3 checks, each with the entry below that says more:

- `socketOptions.retries` is a `TypeError`, unless it is `0` (Client:
  "`socketOptions` refuses Socket.IO's `retries`").
- An HTTP call whose `authenticate` or `loadServiceAccess` throws anything
  but a `QuickdrawError` `UNAUTHENTICATED` or `FORBIDDEN` is answered
  `INTERNAL` (500), not 401 (Server: "an HTTP call whose `authenticate`
  cannot run"), and an MCP `principal` hook that does, or that returns a
  principal of the wrong shape, is answered `INTERNAL`, not
  `UNAUTHENTICATED` (Server: "an MCP call whose `principal` hook cannot
  run").
- `createMcpHttpRouter` answers `POST {path}` (`/mcp`) itself, as MCP's
  Streamable HTTP transport, and GET and DELETE there 405, so an app's own
  `/mcp` handler mounted after it no longer gets them (Server:
  "`createMcpHttpRouter` serves MCP's Streamable HTTP transport").
- `access.cacheMs` needs the storage adapter's `onWrite`, or
  `createDispatcher` throws a `TypeError` (Server: "With `cacheMs`, a check
  later in the same call sees the call's own access writes").
- The root `db` used inside a `db.$transaction(async (tx) => ...)` callback
  runs outside the transaction, a root `createMany` and `updateMany`
  included: it neither rolls back with it nor sees its rows, and on PGlite
  it waits for the transaction to end. Write through `tx` (Server: "each
  client's work is tracked in the transaction it runs in").
- The admin kit's `onWrite` gets the development checks, so a loop of
  writes there is an `n-plus-one`, which a strict test app throws (Server:
  "The admin kit's `onWrite` gets the development checks").
- `setupRedisAdapter` gives the adapter it builds the server's
  `cluster.timeoutMs` (1 s by default) as its new `requestsTimeout`, where
  the Redis adapter's own default is 5 s, which also bounds the app's own
  `fetchSockets` through it, and a `cluster.timeoutMs` that is not above 0
  makes it throw a `TypeError` (Server: "`setupRedisAdapter` gives the
  adapter it builds the server's `cluster.timeoutMs`").
- On a `binary: true` server behind a cluster adapter, a node of an earlier
  version reads `null` for each binary value a stream pushes from a node of
  this version: replace every node at once (Server: "A stream's binary
  items reach the other nodes as binary").
- Every call waits for its socket's own `qd:hello`, so a test double or a
  fake server must send one (Client: "A call goes out only on a socket
  whose own hello names its user").
- A mutation made before new credentials (`setAuth`) whose attempt starts
  while they await their hello is refused `CANCELLED` and never sent, even
  for the same user, so a global `onError` that ignores `CANCELLED` drops
  those writes (Client: "A mutation is sent only as the user who made it").
- A mutation that switches the user itself (an anonymous sign-in or
  sign-up, then `setAuth`) no longer shows its `data` and `isSuccess` to
  the user it signs in: act on its result in `onSuccess` (Client: "A
  mounted mutation hook shows a call only to the user it ran as").
- `useChannel` sends a burst's messages, up to 64 at once, where the server
  got only the first, and a burst counts against the channel's server rate
  and its flood guard (Client: "`useChannel` sends every message of a
  burst").
- Lint's write rules count a `Tracked` only when the file imports it from
  quickdraw (one re-exported from the app's own module no longer silences
  `no-untracked-write`), and check `this.<member>` and destructured
  bindings typed with it, so an upgrade can report new errors (Lint: "The
  write rules count quickdraw's `Tracked` alone").
- A mock client made with `session: { isKnown: false }` reads nothing
  before `$session({ isKnown: true })`, and the same user known again after
  `isKnown: false` reads its queries again, which `calls` counts (Testing:
  "The mock client follows its session as the real client does").

### Client

- **Live data for scripts, without TanStack: a live store on
  `./client/core`.** `liveStoreOf(connection)` is the connection's live
  store: the live stores the hooks use, over an in-memory cache of their
  own, so a Node script, a CLI or a worker holds live rows, collection
  scopes and stream feeds with neither React nor TanStack Query installed.
  `holdCollection(live, { contract, collection, scope }, listener)` (with
  `view`, `load` and `limit` too),
  `holdEntity(live, { contract, id }, listener)` and
  `holdStream(live, { contract, stream, scope, max }, listener)` hold one,
  typed by the contract, and return `{ current(), release() }` (a scope's
  holding adds `loadMore`, `loadItems` and `refresh`). A snapshot is what
  `useCollection`, `useEntity` and `useStream` return, without the
  optimistic fields. The listener hears each new snapshot at most once a
  microtask, the first once `hold*` has returned (so it may call its
  holding's `release()`), and none after `release()`, after which
  `current()` keeps the last. The store follows the connection as the
  hooks' live data does: what it holds resumes by revision after a
  reconnect (a scope no other socket holds is read again, since the server
  buffers a scope's deltas only while some socket subscribes to it) and
  loads from scratch for another user, the cache empties on
  another user's hello or when the server ends the session, while new
  credentials await their hello the holdings show nothing, and an entry
  goes a tick after its last holding ends. A connection takes one kind of
  live data, since two on one socket unsubscribe each other's rows and
  scopes: `liveStoreOf` throws for a connection a `QueryClient`'s live data
  follows (a `QuickdrawProvider`'s, `liveDataOf`'s), and `liveDataOf` for
  one a live store follows.
- **`placeholderFromSession` guards an app's own TanStack hook against the
  last user's placeholder.** A hook an app writes over a member's `key` and
  `call` (`useInfiniteQuery`, `useQueries`), the form the client rule
  documents and `no-untyped-client` allows, gave TanStack its
  `placeholderData` as it was: with `keepPreviousData`, the first render
  after the next user's hello showed the last user's pages as its
  placeholder. `placeholderFromSession(queryClient, placeholderData)` on
  `./client` is the guard a member's `useQuery` uses: it asks a
  `placeholderData` function only about a query the cache still holds, and
  passes a value as it is. Call it on every render, in the component:
  `placeholderData: placeholderFromSession(queryClient, keepPreviousData)`;
  TanStack reuses a placeholder without asking while the option is the same
  function. Such a hook also shows what the cache still holds while new
  credentials await their hello, which a member's hooks hide: show its data
  only while `isKnown`. It is not on `./client/core`, which names no
  TanStack type.
- **Live entries never take a placeholder.** `useEntity`, `useCollection`
  and `useSearch`'s held scope observe their entry with a query that took
  the `QueryClient`'s `placeholderData` default (`keepPreviousData` in
  `defaultOptions.queries`, or `setQueryDefaults(["qd"], ...)`). TanStack
  makes that placeholder from the last entry the hook's observer showed,
  which the cache session never empties. So until a new id or scope
  answered, `useEntity` and `useCollection` showed the last one's row or
  items, with `isLoading: false`, and `useSearch` showed its results through
  the last scope's state (an item that state held, as it held it; one it
  had removed, not at all): another row or scope of the same user's, or, for
  a hook keyed by the user, the last user's, at their access tier, after a
  switch of users or a session the server ended. The entry's query now
  gives `placeholderData: undefined`, which no default overrides, so a
  re-keyed `useEntity` or `useCollection` shows `isLoading` and no data
  until its answer, under a `keepPreviousData` default too. `useEntities`
  was never affected: each id has an observer of its own.
- **A row or scope held without a hook keeps its entry past `gcTime`.**
  The live stores wrote their entries into the `QueryClient` without
  observing them, and TanStack collects a query `gcTime` after it is built,
  or after its last observer leaves, unless one observes it then: five
  minutes in a browser and in React Native (a `QueryClient` in Node
  collects nothing unless given a `gcTime`). So code that held a row or a
  scope through `liveDataOf(connection, queryClient)`, with no hook to show
  it, lost the entry `gcTime` after its first load though it still held
  it: `getQueryData` found nothing, and the next frame or idle check loaded
  the scope again from its first page, or asked for the row again. The
  stores now observe each row and scope they hold, from when they hold it
  until a tick after its last holder lets it go, with the query a hook
  observes its entry with, which never fetches: the entry stays while it is
  held, and TanStack collects it `gcTime` after no hook shows it any more,
  as before. Another user's hello still empties every held entry, and an
  entry removed from the cache stays removed until the stores write it
  again. The hooks were never affected: each observes its entry while
  mounted. Devtools show the stores' observer on each entry they hold.
- **`useJoin` shows `data` only to the user who joined.** What the last
  join returned stayed shown while new credentials awaited their hello, was
  carried into the next user's `joining` state, and stayed beside that
  user's refusal (`error`) for good. A join now keeps the user its hello
  named (`null`, anonymous, counts as a user), carries the last `data` only
  for that same user, and shows it only while the connection's hello names
  them. A reconnect with the same credentials keeps the hello, so `data`
  stays through it as before; new credentials hide it until their hello,
  and the same user's shows again while the join runs.
- **`useJoin` shows `data` only for the input it joined.** The carry above
  compared the user, not the input: when a component changed what it joins
  (room `r1` to `r2`) for the same user, the first render reported `r2`
  joined with `r1`'s answer before `r2`'s join had even started, kept that
  answer while `r2` joined, and showed it beside `r2`'s refusal. A join now
  keeps its input's key (by value, as the re-join compares it), and the hook
  shows `data`, `isJoined` and `error` only for the input it renders with: a
  new input shows `joining` from its first render, with no `data`, until its
  own answer. A reconnect for the same user and input keeps `data` as
  before.
- **A mounted mutation hook shows a call only to the user it ran as.** A
  member's `useMutation` returned TanStack's state as it was, and TanStack
  keeps it on the hook's observer, outside the cache the session empties: a
  component that stayed mounted while the user changed showed the next user
  the last user's `data`, `error`, `variables` and status, while the next
  user's hello was awaited and after it, a call in flight at the switch
  included (its `isPending`, then the error its dropped socket gave it).
  The hook now records who each call runs as when it is issued (the user
  the hello names, `null` for anonymous; with no hello held, the user the
  next hello names, below), and shows its state only while the
  connection's hello names that user, else an idle result.
  A reconnect with the same credentials keeps the hello, so a finished
  call stays shown through it; new credentials hide it until their hello,
  which shows it again if it names the same user. `throwOnError` throws
  only an error the hook shows. The call itself still settles, and
  `onSuccess`, `onError` and `onSettled` still run, for the user who made
  it: the observer is not reset, which would drop the callbacks a
  `mutate(variables, options)` gave a call still in flight.
  A call made while no hello is held (before the first, while new
  credentials await theirs, after the server ended the session) shows,
  pending and then its answer or error, while none is held under the
  credentials it was made under, then only to the user the next hello
  makes it (below), settled or not: a hello that does not make it anyone's
  (another user's cookie after a session the server ended) shows it to
  nobody, and new credentials hide it.
  A mutation that switches the user itself (an anonymous sign-in or
  sign-up, then `setAuth`) hides its `data` and `isSuccess` once the new
  hello arrives: act on its result in `onSuccess`.
- **TanStack's mutation cache follows the user too.** The session emptied
  quickdraw's queries and overlays on another user's hello or a session the
  server ended, but never TanStack's mutation cache, so `useMutationState`
  and `useIsMutating` over quickdraw's keys (`["qd", …]`) still listed the
  last user's mutations, their `variables`, `data` and `error`, to the next
  user: after a switch from Ada to Ed, Ed's `useMutationState` read
  `success:ada-note`, and a call of Ada's the switch refused read
  `pending:ada-held` in Ed's first render, then `error:ada-held`. The same
  hello now takes quickdraw's mutations out of that cache: a settled one at
  once, a running one at once too (it runs on, out of the cache, settles,
  and its callbacks run for the user who made it), and one TanStack holds
  paused (offline, or queued behind another of its `scope`) the moment it
  settles, since TanStack resumes only the paused mutations its cache holds:
  until it resumes, and is refused, those hooks still see it. One taken out
  that pauses later (offline when its retry, or its first attempt after an
  async `onMutate`, comes) is never resumed, as after
  `queryClient.clear()`: never sent, its callbacks not run. A session the
  server ended leaves them to its next hello, which keeps them when it names
  the same user, whose calls may still go out as them (taking a call out at
  the end itself would reorder its `scope`, or lose a retry waiting for its
  delay, once that user is back), and takes them out for anyone else. The
  same user's new credentials keep their mutations. Quickdraw's mutations
  are a mutation hook's, marked `meta.qd` whatever `mutationKey` its options
  give, and any keyed under `["qd", …]`; the app's own, under keys of its
  own, stay.
- **A mutation is sent only as the user who made it.** TanStack runs a
  mutation's function late (after an async `onMutate`, after a pause while
  offline, behind a `scope` queue) and again for every retry, and the call
  went out as whoever the connection's socket then spoke for: a call Ada
  made could run on the server as Ed, with Ada's input, once Ed signed in
  meanwhile (`mutate` and `setAuth` in one click handler, an offline pause
  then a switch, `retry` across one; a refused item's `retry()` held across
  one), and a late answer could then show Ada Ed's result. Each call is now
  bound, as it is made, to its user and to the connection's credentials
  epoch, a count of credential changes and sessions the server ended, and
  every attempt first checks each call of the hook still on its way with
  that very input (TanStack hands an attempt only its input): under other
  credentials, only a hello naming the same user lets it go out (a
  refreshed token), and under the same ones, a hello naming another user
  (a cookie that changed) stops it. A call made with no hello is the next
  hello's user's, even once it settled (so a refused item's `retry()` is
  theirs), if that hello comes under the same credentials; after a session
  the server ended, only if it names the session's user again, so a
  cookie that signs someone else in finds it nobody's: neither shown nor
  sent once a hello names anyone. A stopped call fails `CANCELLED`, never
  sent, before its optimistic update runs: "The user changed before the
  call was sent" when a hello names someone it was not made as, else "The
  credentials changed before the call was sent" or "The session ended
  before the call was sent" (made under other credentials, or before a
  session the server ended, and no hello names its user since). `onError`
  and `onSettled` run, `mutateAsync` rejects, and the hook's `retry` is
  not asked about it. A refused item's `retry()` keeps the call's own
  user, and a retry stopped so shows the item in `refused` again, with
  that `CANCELLED`, unless the cache was emptied for another user
  meanwhile. A paused call that TanStack drops unsettled
  (`queryClient.clear()` while offline) no longer holds its input against
  later calls. **Behavior change:** a call whose attempt starts while new
  credentials await their hello is refused this way, even for the same
  user, as a call waiting in the send buffer then always was (it is not
  held until the hello: send it again from `onError`); a call made while
  no hello is held now shows while none is held (it showed idle until the
  next hello, and a failure before any hello was never shown), so a slow
  first connect shows the call pending, and a call after the server ended
  the session shows its failure to the signed-out page. A call made while
  the socket is down, or between a reconnect's connect and its hello, is
  held for that hello, `.call()` included (below).
- **A call goes out only on a socket whose own hello names its user.** A
  socket speaks for whoever its credentials named when it connected, which
  a session cookie can change unseen (another tab's sign-in), and a call
  made while it was down waited in Socket.IO's send buffer, which the next
  connect flushed before the new socket's `qd:hello`: once a cookie named
  Ed at a reconnect, Ada's `.call()` write ran as Ed with her input and her
  code got his answer, a `.call()` read handed her his, and a hook's call
  was saved as him; an attempt that started between a reconnect's connect
  and its hello passed #154's check against the hello a drop keeps, and
  went out on Ed's socket. Every call (`call`, `callData`, a member's
  `.call()`, the hooks') is now bound, as it is made, to the user it is
  made as (#154's tickets), and goes out only on a confirmed socket:
  connected, and its own hello in. From a connect or a drop until that
  hello the connection holds calls itself, never in Socket.IO's buffer,
  and the hello sends each one whose user it names, oldest first and
  before anything else it sets off (the joins it runs, a first hello's
  resume), and fails the rest `CANCELLED` ("The user changed before the
  call was sent"). Reads are held like writes. `setAuth`, `close` and a
  refused session fail the held calls `CANCELLED`, as they failed the
  buffered ones; one whose time runs out while held fails `INTERNAL` "Not
  sent: the connection to the server is down" (one that timed out in the
  buffer said "No answer", as a lost answer still does). A channel message
  sent in the same window ran as Ed too (a channel that requires no room
  takes one from any signed-in socket): `useChannel`'s `send` now drops it
  until the socket's own hello, and `isReady` reads false meanwhile, as a
  drop keeps the last hello. **Behavior change:** a
  call made before the first hello now goes out after it, and the reads
  that resume live rows and collections, still sent from the connect, may
  go before or after the calls held across a drop (they went after
  Socket.IO's buffer): both catch up, since a write's change reaches the
  subscription the resume set up, and their answers follow the hello,
  which drops them if it names another user. A first connect the server
  refuses ends a session no hello named, so whoever signs in next claims a
  call made after it (the README now says so). A ticket made with no hello
  also stops waiting once other credentials come first.
- **Nothing Socket.IO buffers after a missed ping goes out on the next
  socket before its hello.** The hold above starts at a connect or a drop,
  but a socket still reads connected for a moment after its engine's ping
  is overdue (a timer the browser throttled, a device asleep), until
  engine.io closes it a microtask after the next emit notices. Socket.IO
  puts what is emitted then in its send buffer, and the next connect sent
  that buffer before the new socket's `qd:hello`: with a cookie naming Ed,
  Ada's call made then ran as Ed and her code got his answer, and her
  channel message ran as him; Ada's own reconnect sent hers before her
  hello. A call Socket.IO buffers so is now taken back out of the buffer
  at once and held for the next hello like any other: that hello sends it
  if it names the call's user, after the hello, and fails it `CANCELLED`
  ("The user changed before the call was sent") if not. The drop then fails
  whatever else the buffer still holds `CANCELLED` ("The connection
  dropped before it was sent"): a channel message (dropped, as before the
  hello), the reads that resume live data (asked for again at the
  connect), and anything an app emitted on the socket itself before the
  drop. What an app emits on the socket itself while it is down still
  waits in that buffer for the next connect (`no-raw-socket`).
- **`socketOptions` refuses Socket.IO's `retries`.** With
  `socketOptions: { retries: n }`, Socket.IO kept every emit it
  acknowledges in a queue of its own and sent it again at the next connect,
  before the new socket's `qd:hello`, past the hold and the take-back
  above, and after a timeout, while the server may still be running it,
  which `call` never does. A call in flight at a drop, with a cookie naming
  Ed at the reconnect, ran as Ada and again as Ed, and Ada's code got Ed's
  answer. `createQuickdrawConnection` (and the provider) now throws a
  `TypeError` for a `retries` that turns Socket.IO's queue on, and
  `SocketClientOptions` no longer has the field; `0`, or none, is left
  alone, as is `ackTimeout`, which only times acknowledgements out.
- **An app's own hook reads in the provider's first commit.**
  `QuickdrawProvider` bound the typed client to its connection, and opened
  the connection, in passive effects, which React runs after its
  children's. A hook an app writes over a member's `key` and `call` (such
  as TanStack's `useQuery` or `useInfiniteQuery`), mounted with the
  provider, starts its read in its own passive effect, before either: it
  failed `INTERNAL` ("needs a mounted `<QuickdrawProvider>`", then "Not
  connected to the server"), which only TanStack's retry hid. The provider
  now registers its cache session, binds the client and opens the
  connection in layout effects, which run before every passive effect of
  the commit, so that read is sent; strict mode and a new provider (another
  `url`) keep it so. They still run only on the client, after a commit: a
  server render, which shares the client between requests, binds nothing.
  A read made during render (`useSuspenseQuery` in that first commit) runs
  before any effect and still fails at first; TanStack's retry reads again.
- **Behavior change: `useChannel` sends every message of a burst.** `send`
  emitted `qd:ch` with Socket.IO's volatile flag, which drops a message
  whenever a write is in flight, and engine.io marks its transport busy
  from each write until the next tick: of three messages sent in one
  handler or effect, the server got the first. `send` now drops a message
  only while the connection is backed up (64 packets waiting to be sent,
  or more than 32 KiB unsent in the WebSocket), the rule a peer link's
  `fast` relay messages already followed, and otherwise sends it: of a
  burst, 64 go out, and the rest are dropped until the connection has sent
  them (on a WebSocket, by the next tick). It still drops one until the
  socket's own hello, as before.

### Server

- **Behavior change: a count across nodes keeps the answers that came
  when one node is silent, and presence no longer falls back to
  `fetchSockets`.** Socket.IO hands a request's answers over together.
  While one node did not answer, `qd.stream(...).subscribers()` and
  presence (`users`, `count`, `isOnline`) lost every other node's answer
  too: a count fell to this node's own sockets, and presence read every
  node's sockets for 30 s. That read threw after the adapter's timeout
  while a node stayed frozen; a frozen node no longer makes presence
  throw. Both now wait for the adapter's own request timeout plus 250 ms,
  and count the answers that came. That timeout is the Redis adapter's
  `requestsTimeout`, or the fixed 5 s of socket.io-adapter's cluster
  adapters (the sharded Redis, streams, Postgres and Mongo adapters), which
  expose none; any other adapter waits `cluster.timeoutMs`. They warn
  how many nodes answered, at most once every 10 minutes. quickdraw never
  changes an adapter the app built: with the Redis adapter's default
  `requestsTimeout` of 5,000 ms, a read in a degraded cluster takes about
  5.25 s instead of 1 s, so lower it for faster answers. During a rolling
  deploy from 5.1.0 or earlier, whose nodes never answer a presence
  request, the users on those nodes are missing from presence while old
  and new nodes overlap; behind an adapter with no request timeout to wait
  for (neither a `requestsTimeout` nor a cluster adapter's 5 s), every other
  node's users are.
- **A starting node takes the room hosts of the nodes that answered when
  one node is silent.** Its ask for the other nodes' hosts (host mode
  behind a cluster adapter) waited `cluster.timeoutMs` and dropped every
  answer when one node did not answer in time. With three or more nodes and
  one silent, it learned no host: behind the Redis adapter it never asks
  again, and behind other adapters only `cluster.timeoutMs` later. It now
  waits as presence does and keeps the answers that came.
- **`setupRedisAdapter` gives the adapter it builds the server's
  `cluster.timeoutMs` as its `requestsTimeout`** (1,000 ms by default,
  where the Redis adapter's own default is 5,000), so that node's presence
  reads and counts answer that soon in a degraded cluster. Its new
  `requestsTimeout` option sets another value. The value also bounds the
  app's own `fetchSockets` through that adapter.
- **A session's token expires with its session, never before.**
  `issueSession` signed the token's `exp` as a span from the current whole
  second, so the token ended up to 999 ms before its session, and a 1 s
  session's token could expire milliseconds after it was issued. It now
  signs the session's `expiresAt`, rounded up to the second;
  `createJWT` takes that time in seconds since the epoch as well as a
  span.
- **`createMcpHttpRouter` serves MCP's Streamable HTTP transport.** MCP
  clients that speak it (Claude Code's `claude mcp add --transport http`,
  the MCP SDK's `StreamableHTTPClientTransport`) could not connect to the
  router, which served only 4.1's `GET /mcp/tools` and `POST /mcp/invoke`,
  so an app wrote its own `/mcp` transport over `callMethod`. `POST {path}`
  (`/mcp` by default) now takes JSON-RPC messages and answers them in one
  JSON body, statelessly, in protocol versions 2025-11-25, 2025-06-18 and
  2025-03-26: `initialize` answers the client's version when it is one of
  them, else the latest, and `initialize`, `ping`, `tools/list` and
  `tools/call` are answered as on stdio (a failed call is a tool result
  with `isError` carrying its code). Each call runs as the bearer token's
  principal through the registry's `principal` hook, behind the router's
  `allowedOrigins` and `allowedHosts`, within its body limit and in the
  caller's lane, as `invoke`'s calls do, and a client that goes away
  cancels its call. A request needs `Content-Type: application/json` (415
  otherwise) and an `Accept` that allows `application/json` (406); an
  `MCP-Protocol-Version` the endpoint does not speak is 400 (without one, a
  request is 2025-03-26's); notifications and responses alone get 202. A
  batch is 2025-03-26's only, of at most 16 messages and one `tools/call`,
  so a rate limit in front of the route, which counts a POST once, counts
  every call. No `Mcp-Session-Id` is ever sent, and one a client sends is
  ignored. GET and DELETE at `{path}` itself, which went to the app's next
  handler, are now answered 405 with `Allow: POST`; other methods still go
  to it. Server-sent events, sessions, resumability and OAuth discovery are
  not served, and `notifications/cancelled` does nothing: a client cancels
  a call by closing its request. `createMcpHttpRouter` takes `name` and
  `version` for `initialize`'s `serverInfo` (default `"quickdraw"` and
  quickdraw-core's version). The stdio server shares the JSON-RPC handling
  and still speaks 2024-11-05.
- **The admin kit's hook transaction takes time limits.** The transaction
  the kit writes in with `prepare`, `onWrite` or `onCommitted` took the
  database client's default, Prisma's 5 seconds, so a large cascade
  written in `prepare` (a user's delete clearing their rows in every
  service) could fail on time alone. `admin.handlers`' new option
  `transaction: { timeoutMs, maxWaitMs }` gives it others: how long it may
  run before the client rolls it back, and how long it may wait for a
  connection to start on (Prisma's default is 2 seconds). A write that
  runs past `timeoutMs` is undone and fails `INTERNAL`. Each must be a
  positive number of milliseconds a timer honors (at most 2147483647), and
  `transaction` without a hook, which opens no transaction, is a
  `TypeError` from `admin.handlers`. The call's own time limit still
  applies: raise the method's `timeoutMs` (on its kit entry) or
  `limits.callTimeoutMs` above the transaction's, or the caller gets
  `TIMEOUT` for a write that commits. `AdminTransactionOptions` is on
  `./server`.
- **The admin kit's `onWrite` gets the development checks.** Its
  statements ran unchecked, as the kit's own do, so a loop of writes in it
  was never reported. It now runs `checked`, as `prepare` and the other
  kits' callbacks do: twelve rows written one by one there are an
  `n-plus-one`, which a strict test app throws.
- **With `cacheMs`, a check later in the same call sees the call's own
  access writes.** A tracked write evicted the cached access lookups it
  changed only when its call's unit of work flushed, after the response. Until
  then, checks on that node still saw a membership, owner or access list the
  write had already changed: `ctx.access` and a `ctx.services` call later in
  the same handler, and every other request, for as long as the writing call
  ran on (a handler past its timeout, a long `qd.run` job). The cache now
  evicts as soon as the write is durable: a write outside a transaction at
  once, a transaction's writes at its commit (a savepoint's when the
  transaction around it commits), and a rolled-back write never, which leaves
  the cache as it was. A write made through another dispatcher on the same
  tracked client evicts too. The flush still evicts again, and revocation
  and `onAccessChanged` still happen at the flush. Servers behind a cluster
  adapter still evict when the flush's access change reaches them, and a job
  on a bare `createDispatcher` still broadcasts nothing, so its writes reach
  the servers' caches only after `cacheMs`. `cacheMs` now needs the storage
  adapter's `onWrite` (`trackPrisma`'s has it): an adapter without one is a
  `TypeError` from `createDispatcher`, and one that cannot report writes can
  pass `onWrite: () => () => {}` to evict only at the flush. Apps without
  `cacheMs` are unchanged.
- **A `createServer` that fails to start leaves nothing attached to the
  tracked client.** It attached its dispatcher before it checked
  `http.maxBodyBytes` and `http.rateLimit`, and before Socket.IO made its
  adapter, so a start that failed there left the dispatcher on the client
  for the life of the process: the access cache's write listener
  (`cacheMs`) stayed, writes made outside a call flushed to the failed
  server again once a later one on the client closed, and a test or
  supervisor that retried `createServer` on one client piled them up. The
  HTTP options are now checked with the others, before the dispatcher
  exists. A start that fails after it (Socket.IO refusing its options, an
  adapter that cannot be made) detaches it again before the error goes on,
  as `close()` does. The router goes on the app, and the startup checks
  start, only once the sockets are made, so a failed start leaves no router
  on the app and nothing on its HTTP server.
- **A call that answered `TIMEOUT` and went on to commit is logged.** At its
  time limit (`timeoutMs`, else `limits.callTimeoutMs`, 30 s) a call answers
  `TIMEOUT` and aborts `ctx.signal`, but a handler that runs on still
  commits what it writes, and its flush pushes it: the server only stopped
  waiting. The server now warns, in every environment, under
  `quickdraw.call` with the call's request id, when a call that answered
  `TIMEOUT` at its time limit goes on to commit writes. The warning names
  the method, its time limit and the writes, and says to set `timeoutMs`
  above the method's slowest path or to check `ctx.signal` before writing.
  A shared run warns once. A nested `ctx.services` call's writes flush with
  its caller's run, so the warning fires only when that outermost call
  answered `TIMEOUT`. `UnitOfWork` gains an optional `recorded`, the writes
  its `flush` will hand on, which `trackPrisma`'s units implement; a unit
  of work that leaves it out is never warned about. The upgrade guide
  ("Defaults that changed"), `UPGRADE-PROMPT.md`, the README and the
  services rule now say what `TIMEOUT` means, and what a method that waits
  on an outside API does about it.
- **Behavior change: an HTTP call whose `authenticate` cannot run is
  answered `INTERNAL` (500), not `UNAUTHENTICATED` (401).** The HTTP
  transport answered every failure of `authenticate` and
  `loadServiceAccess` with 401, an outage of the session store included,
  so a server render (`createServerCaller`) that sends `UNAUTHENTICATED`
  to the sign-in page sent its user there for a database blip. It now
  follows the socket handshake's rule: a `QuickdrawError`
  `UNAUTHENTICATED` is answered 401 and a `FORBIDDEN` 403, as before
  (logged at debug), and anything else
  `{ code: "INTERNAL", message: "Internal error" }` with 500 (logged at
  error, as before), which `createServerCaller` rejects with. `INTERNAL`,
  rather than a 503 with `retryAfterMs`: it is the code both transports
  already answer the server's failures with, a reply's status is always
  its code's, and the server cannot know when its store is back.
  `createHttpRouter` answers the same.
- **A development warning names an `authenticate` that throws a plain
  error.** Since the change above, a plain `Error` thrown for bad
  credentials reads as an outage: the client keeps the user and retries
  for ever. While `NODE_ENV` is not `"production"`, the server now logs
  `[quickdraw:authenticate-threw]` once (per server, under
  `category: "quickdraw.dev"`) when `authenticate` throws anything but a
  `QuickdrawError`, naming the fix: throw
  `QuickdrawError("UNAUTHENTICATED")` to refuse, or return `null` for an
  anonymous caller. It comes before any call, so a strict test app logs it
  rather than throwing it. A `QuickdrawError` of any code is never warned
  about; `socketAuth` refuses with one.
- **Behavior change: an MCP call whose `principal` hook cannot run is
  answered `INTERNAL`, not `UNAUTHENTICATED`.** The MCP registry answered
  every failure of its `principal` hook with `UNAUTHENTICATED`, an outage
  of the token or session store included, so an agent whose good token
  could not be checked during a database blip was told it was refused, and
  could drop or rotate it. The hook now follows the rule `authenticate`
  follows on sockets and HTTP (above): a `QuickdrawError`
  `UNAUTHENTICATED` or `FORBIDDEN` it throws is answered
  `UNAUTHENTICATED`, 401 from `POST /mcp/invoke`, as before (logged at
  debug), and anything else, a principal of the wrong shape included,
  `{ code: "INTERNAL", message: "Internal error" }`: 500 from
  `POST /mcp/invoke`, and over stdio a tool error carrying that code
  (logged at error, as before, once). A hook that throws a plain `Error`
  to refuse a token should throw `QuickdrawError("UNAUTHENTICATED")`
  instead, as `bearerAuth` does, or the agent is told the server failed
  rather than that its token is bad.
- **A development warning names an MCP `principal` hook that throws a
  plain error.** Since the change above, a plain `Error` thrown there for
  a bad token reads as an outage, and the agent is never told its token is
  refused. While `NODE_ENV` is not `"production"`, the registry now logs
  `[quickdraw:mcp-principal-threw]` once (per registry, under
  `category: "quickdraw.dev"`) when its `principal` hook throws anything
  but a `QuickdrawError`, naming the fix: throw
  `QuickdrawError("UNAUTHENTICATED")` to refuse, or return `null` for an
  anonymous caller. It is a kind of its own beside `authenticate-threw`,
  for another hook whose caller gets another answer, and like that one it
  is never thrown, even from a registry over a strict test app's
  dispatcher. A principal of the wrong shape, or a `QuickdrawError` of any
  code, is not warned about.
- **A nested transaction that rolls back sends none of its writes.**
  Prisma 7 runs `tx.$transaction(async (inner) => ...)` inside an
  interactive transaction as a savepoint of it, but `trackPrisma` opened no
  frame for it: its writes went straight into the outer transaction's, so
  when the savepoint rolled back and the outer transaction caught the error
  and committed, subscribers still got the rows it created and the values
  it set (a real PostgreSQL showed both: a create that never happened, and
  an update's `after` with a status the database never kept). The
  transaction client a callback gets now opens a frame of its own for
  `$transaction`, either form: a nested transaction's writes join the one
  around it when the savepoint is released, and are dropped when it rolls
  back. The callback's client is otherwise Prisma's.
- **Behavior change: each client's work is tracked in the transaction it
  runs in.** A write through `db` inside `db.$transaction(async (tx) => ...)`
  runs on a connection of its own and commits at once, and a
  `db.$transaction` begun there commits on its own, but the tracker
  recorded both into the transaction's frame: when the transaction rolled
  back, their frames were dropped though their rows stayed. Worse, the
  hook ran a root `createMany` or `updateMany` there as its `...AndReturn`
  form through the transaction's client, which moved the write into the
  transaction, so it rolled back with it, and read a root `update`'s,
  `upsert`'s or `deleteMany`'s rows through it too (a real PostgreSQL
  showed a root `deleteMany` recorded as deleting a row the transaction
  created and then committed, so neither was sent). And a transaction's
  client used elsewhere wrote to whatever transaction was active there:
  inside a transaction of its own begun in the callback, or in an
  array-form batch, which then sent frames for writes its rollback undid;
  a `createMany` on it ran in the inner transaction; and once its
  transaction ended, its `createMany` and `updateMany` ran on the root
  client instead of being refused. Each interactive transaction now begins
  on a client of its own, with the hook over that transaction's runtime,
  so the hook tells every transaction's client, and its savepoints', from
  the root client's and from each other's. The root client's reads and
  writes go through the root client, and its writes skip every open
  transaction frame for the unit's, as do those of a transaction begun on
  it (an array-form batch too, which Prisma runs as one of its own even
  on `tx`), unless the batch runs them. A transaction's client reads and
  writes in its own transaction wherever it is used, and once that ended,
  its work runs as written, which Prisma refuses. In development, the
  root client's statements inside a callback count toward the N+1 checks
  as a unit's, no longer as the transaction's by-id writes. On PGlite,
  which has one connection, root work inside a callback waits for the
  transaction to end, now a root `createMany`, `updateMany` and an
  `upsert` with an empty `update` (whose existence read used to run in the
  transaction) too: a test that makes one there runs into the
  transaction's timeout; write it through `tx`.
- **Behavior change: a volatile stream drops an item only while the
  socket's connection is backed up.** Its frames went out with Socket.IO's
  volatile flag, which drops a frame whenever a write to that socket is in
  flight, and its transport stays busy from each write until it is done:
  of the items pushed in one tick a subscriber got the first (in
  production, 1 of 8 prices per poll), and an item pushed right after any
  other frame or answer to the socket, in the same tick, never arrived. A
  volatile frame now skips a socket only while 64 relay messages and
  volatile frames sent to it wait on its connection: the count the peer
  links' relay kept for its `fast` messages, now shared by both. Of a
  burst, a socket on a free connection gets 65 items (one goes at once, 64
  wait for it), and the rest are dropped until the connection sends what
  waits: push a snapshot instead of a bigger burst. Behind a cluster
  adapter a volatile stream's items now go to every node as a seeded
  stream's do (`quickdraw:stream-push`, tagged with the deployment), with
  their binary values beside them (next entry), and each node sends them
  to its own sockets, checking each one, instead of through the adapter's
  room broadcast. During a rolling deploy a node of an earlier version
  still sends with the flag.
- **A stream's binary items reach the other nodes as binary.** On a server
  that sends binary (`createServer({ binary: true })`), a push goes to the
  other nodes as a server-side event, which Socket.IO's Redis adapter sends
  as JSON, unlike its room broadcasts: behind it a seeded stream's `Buffer`
  item reached the other nodes' subscribers, and their seeds, as
  `{ type: "Buffer", data: [...] }`, a `Uint8Array` as an object of its
  indexes and an `ArrayBuffer` as `{}`, and a volatile stream's would have
  too now that it goes the same way. The sending node now takes each
  binary value (an `ArrayBuffer` or a view of one) out of the items, sends
  it beside them by its place, its kind and its bytes in base64, and the
  receiving node puts it back, so a subscriber on any node gets the item as
  a subscriber on the pushing node does. A server that sends JSON only does
  none of it. During a rolling deploy a node of an earlier version gets
  `null` in each binary value's place from a node of this version.

### Testing

- **The mock client follows its session as the real client does.** A
  `$session` that named another user changed only what `useQuickdraw()`
  read: the mock's cache and its mutation hooks kept the last user's state,
  so after `$session({ userId: "ed" })` a component rendered `ed
get=ada-note rename=success data=ada-input vars=ada-input`, and a
  switch-of-users test could pass a component that leaned on the leak, or
  fail a correct one. The mock's cache now follows its own session through
  the real cache session: another user's hello removes its quickdraw
  queries and mutations, and the same user's first hello after none reads
  every query again. Its mutation hooks run under the real mutation hook's
  rules, from the same code (`useUserMutation`): a call is shown only to
  the user it was made as, `throwOnError` throws only what it shows, and a
  call whose user changed before its attempt fails `CANCELLED`, its stub
  never called. Its query hooks read once a hello names the session's user,
  show nothing cached while it awaits one (`$session({ isKnown: false })`
  after a known session, as new credentials await theirs), and take no
  placeholder of a result the cache no longer holds. Under a `$Provider`
  with a `session` prop, the hooks follow that session; the one cache
  follows the mock's own. It does not model two of the real client's
  rules: a mutation attempt that starts while new credentials await their
  hello calls its stub where the real client refuses it `CANCELLED`, and
  calls are not held until the socket's hello. **Behavior change:** a mock
  made with `isKnown: false` no longer reads before
  `$session({ isKnown: true })`, and the same user known again after
  `isKnown: false` reads its queries again, so `calls` counts that read.
- **`withSavepoints` lets a nested transaction run on PGlite.** Prisma 7
  runs `tx.$transaction(...)` inside an interactive transaction as a
  savepoint, through the driver adapter's `createSavepoint`,
  `rollbackToSavepoint` and `releaseSavepoint`, and refuses it on an
  adapter without them, as `pglite-prisma-adapter` 0.7 is: an app's test of
  code that nests transactions failed on PGlite while it passed on
  PostgreSQL. `withSavepoints(factory)` on `./testing/prisma` wraps a
  driver adapter factory so each transaction gets the three, running the
  SQL `@prisma/adapter-pg` runs, which PGlite runs as PostgreSQL does:
  `new PrismaClient({ adapter: withSavepoints(new PrismaPGlite(pglite)) })`.
  An adapter with savepoints of its own keeps them, and every other member
  of the factory is its own. Core's own test database uses the same
  function.
- **A mock client's stub counts one call for a mount right after its
  answer is set.** A new answer (`mockResolvedValue`, `mockRejectedValue`,
  `mockImplementation`, `mockReset`) refetched the method's cached queries
  a few microtasks later, and by then a component rendered just after the
  answer was set had read it already: the refetch asked the stub a second
  time, so `calls` counted 2 for one mount (a test had to wait a macrotask
  before rendering). The queries to refetch are now the ones cached when
  the answer is set, each holding a result, or a read in flight, of an
  older answer; a query cached later reads the new answer with its own
  first fetch. A new answer still refetches each of those once, and a
  query rendered while its stub had no answer still shows the answer when
  it comes.

### Lint

- **The write rules count quickdraw's `Tracked` alone, and read it on more
  bindings.** A type named `Tracked` or `TrackedTransaction` counted
  whatever declared it, so an app's own `type Tracked<C> = C` silenced
  `no-untracked-write`. The type now counts when the file imports it from
  `@fitzzero/quickdraw-core` or `@fitzzero/quickdraw-core/prisma`, under
  any name (`import type { Tracked as T }`) or through a namespace import,
  or through the file's own type alias of it; one of the app's own, or one
  imported from another module, is not read. The rules also read it on a
  destructured binding whose pattern's type gives it one (`{ db }: { db:
Tracked<Db> }`, nested, with a default, or through the file's interface
  or type alias), and on `this.<member>` its class declares so (`private
readonly prisma: Tracked<Db>`, a private `#db`, or a constructor's
  parameter property), whose writes `no-nested-write` and
  `no-foreign-write` now check as `db`'s. The message names the module to
  import the type from.
- **`no-plain-error-refusal`** reports a plain error thrown to refuse
  credentials: `throw new Error(...)` (or another built-in error, with or
  without `new`) in a function given as `auth.authenticate` to
  `createServer` (`qd.createServer`) or `createHttpRouter`, as
  `loadPrincipal` to `socketAuth`, or as `principal` to
  `createMcpRegistry`, written there or declared in the same file. A throw
  inside a nested function, a `try` with a `catch` or a `catch` clause is
  left alone, and so is an error class of the app's. A function imported
  from another module is not seen; the warnings above cover it. A warning
  in the base config, so an upgrade never breaks lint.

### Codemod

- **An import a destructuring default uses is kept.** The import cleanup
  every file the codemod writes gets did not count a name given as a
  destructuring default as used, so an import whose one use was one (a 4.x
  list handler's `const { page = 1, pageSize = DEFAULT_PAGE_SIZE } = payload`)
  was removed, and the migrated file failed to compile (TS2304). Every
  part of a destructuring element but its key (`{ key: name }`) now counts
  as a use: object and array pattern defaults, a renamed parameter's
  (`{ c: d = LIMIT }`) and a `for...of` pattern's.
- **Writers that take the Prisma client are typed to take the tracked
  one.** A module function with a parameter typed as the app's Prisma
  client (`prisma: PrismaClient`, or `Prisma.TransactionClient`), which
  writes through it or hands it to a function that does, kept its 4.x
  type: the compiler took the untracked client there, and lint's
  `no-untracked-write` reported its writes when the parameter was named
  `prisma` (farseer's harness writers, whose every caller passed
  `this.prisma`). When every call the run sees gives it the tracked client
  (a handler's `db`, the tracked `db` the run imports where 4.x passed
  `this.prisma`, a client typed `Tracked<...>`, a transaction's `tx` on one,
  or the parameter of another writer typed here), the codemod wraps the
  type: `Tracked<PrismaClient>`, or `TrackedTransaction<...>` when a caller
  gives it a transaction's client or its 4.x type took one, imported from
  `@fitzzero/quickdraw-core/prisma`. A writer a caller gives anything else
  keeps its type, and so do one nothing in the run calls, one passed
  around rather than called, and one that only reads. The summary counts
  the writers typed.
- **An import the codemod adds goes after the file's imports, never inside
  a comment.** It went in at an index into the file's statements, which
  counts comments and directives too: in a file that opens with a comment
  block, a typed writer's `Tracked` import landed inside that comment,
  sometimes mid-sentence, and under `"use client"` a `qd` import went in
  before an existing import. It now follows the file's last import. The
  import cleanup also keeps the blank line under a directive or a header
  comment when it removes the file's first import, which took it along.

## [5.1.3] - 2026-10-23

### Peer links

- **Two players of an app room can link their clients.** On a server
  created with `createServer({ peers: true })` (off by default: its hello
  then lists `"peer"` in `features` and the limits in `limits.peers`),
  `createPeerLink(connection, { room, to, offerer })` on `./client` opens
  WebRTC data channels to socket `to`: `rel`, ordered and reliable, and
  `fast`, unordered and never resent. When those cannot form (ICE failed,
  nothing open within 5 s, no WebRTC as in Node, `relay: "always"`), the
  server relays the same messages. `onPeerRequest(connection, listener)`
  answers a peer that links to this socket. A link has `send`, `on`,
  `close`, `state`, `path`, `closeReason`, `stats` and a `clock` synced
  from pings on `fast`. It works without React.
- **Two new frames.** `qd:peer { room, to, sig }` carries a link's signals
  (a description, a candidate, `relay`, `bye`), acknowledged when asked;
  the receiver gets `{ room, from, userId, sig }`, with the sender's user
  as the server knows it. `qd:relay [room, to, label, text]` carries a
  link message through the server, never acknowledged; one on `fast` is
  dropped while the sender's or the receiver's connection is backed up.
  The server forwards both only between two signed-in sockets of the
  frame's room, and never reads what a link carries.
- **Limits.** A socket signals at most 64 peers at once (`CONFLICT`) and 20
  signals a second (a burst of 40; `RATE_LIMITED` with `retryAfterMs`). A
  session description holds at most 16,384 characters, and each string of
  a candidate 1,024. The relay takes messages of at most 64 KiB (UTF-8),
  only between two sockets that signalled each other, at most 120 a second
  to each peer (a burst of 240) and 1 MiB a second in all (a burst of
  2 MiB), and drops the rest silently. A socket that keeps flooding either
  frame is disconnected, as for channels. The socket rate limiter counts
  `qd:peer`, but a `bye`, and not `qd:relay`; `createRateLimiter` takes a
  `skip(eventName, args)` option for that, which `createServer`'s
  `rateLimit` takes too.
- **Leaving ends links.** A socket that leaves a room, is taken out of it
  or disconnects ends its links there: the server sends a `bye` to each
  peer it signalled and each that signalled it. A link that closes says
  `bye` too, a refused one included, so the server frees the pair's place.
  On the direct path it says `bye` before its data channels close, and a
  side whose data channel closed waits 2 s for the peer's `bye` before it
  moves to the relay, so a closed link never comes back as a request.
  Behind a cluster adapter the frames cross nodes, and the node that holds
  the target socket checks it.
- **Testing.** `createLoopbackPeerLink({ ms, jitter, loss })` on
  `./testing` links two ends in one process, with a delay and jitter per
  message and loss on `fast` alone; closing one end closes the other after
  the `rel` messages sent ahead of it.
- **A link can play over a bad network.** `link.setLag({ ms, jitter, loss })`
  holds every message of a real link, both ways and on either path, `ms`
  plus up to `jitter` milliseconds, and loses a `fast` one with
  probability `loss` (`stats.simulatedLoss` counts the app's, never
  `dropped`), so a browser test or a bench plays on the real WebRTC path.
  `rel` messages are never lost and keep their order. The clock's pings
  wait too, so `clock.rtt` reads the lagged round trip. `setLag(null)`
  ends it, and what is held goes on the next task, in order; `link.lag`
  reads it, and `random` takes a seeded generator. Nothing on the wire
  changes. The loopback double's delay, jitter and loss run on the same
  code, behind its unchanged options.
- **Godot.** The GDScript reference client gains `peer_link`,
  `reject_peer`, the `peer_requested` signal and `socket_id`: WebRTC where
  Godot has it (a web export, or the webrtc GDExtension), the relay
  otherwise. `docs/protocol-v5.md` describes the frames, the link messages
  and the timings for other clients. Its links take
  `set_lag(ms, jitter, loss)` too, drained each frame.
- **An app loads the peer-link code only when it needs it.** Every typed
  client reaches host mode, but not the peer links (WebRTC, the relay,
  the lag simulator): host mode loads them as a chunk of their own once
  the server's hello announces peer links (`createServer({ peers: true })`)
  or at the first link to a room's host, so an open tab holds them before
  a redeploy removes the chunk. With a bundler that splits dynamic imports
  by module, an app whose server serves no peer links never downloads
  them: that keeps about 6 KB gzipped out of a typical app's startup
  bundle (`createQuickdrawClient`, `createQuickdrawConnection`,
  `QuickdrawProvider`) with Vite (rollup or rolldown), and 4.5 KB with
  webpack. esbuild's own code splitting keeps them at startup, since
  `./client` re-exports `createPeerLink`, and costs about 1.4 KB more. An
  app that imports `createPeerLink` or `defineHost` loads them at
  startup.

### Host mode

- **A room's host can serve a contract's channels and streams.** A channel
  or stream declared `serve: "host"` is served by the host of its app
  room, one player's client, over peer links: the server needs
  `peers: true` (`createServer` throws without it) and never handles it.
  A host-served channel declares `requires: { room }`; a host-served
  stream declares a scope and `access: { room: (scope) => room }`, and its
  `seed: n` is how many items the host keeps per scope. `defineService`
  refuses a handler for a host-served channel and options for a
  host-served stream. The server drops a `qd:ch` to one (with a
  development warning), refuses a `qd:stream:sub` to one (`VALIDATION`),
  and `qd.stream(...).push` throws for one.
- **The server says who hosts.** `ctx.rooms.setHost(room)` makes the
  calling socket the room's host (it must be in the room: `FORBIDDEN`);
  `hostOf(room)` and `clearHost(room)` sit on `ctx.rooms`, `qd.rooms` and
  `server.rooms`. A new frame, `qd:host [room, host | null]`, goes to the
  room's sockets on each change and to a socket that joins a room with a
  host. When the host leaves the room, is taken out of it or disconnects,
  the room has none, and `onHostLeave({ room, socketId, principal, reason })`
  (on `defineService` and `createServer`) runs once. The server never
  picks the next host. Behind a cluster adapter each node knows each
  room's host, and every node holds the same one when two nodes set it at
  once, whatever order the changes reach them in. A node that starts
  after a host was set asks the other nodes for theirs, whether its
  adapter came as `socket.adapter` or from `setupRedisAdapter`, once the
  adapter can count it among the nodes it waits for.
- **The host's client.** `defineHost(contract, { channels, streams })` on
  `./client` takes a handler per host-served channel and an optional seed
  per host-served stream; `serve(connection, { room })` answers the links
  of the room's players and returns a `Host` with
  `stream(name).push(scope, item)`, `peers` and `close()`. It checks each
  message as the server checks a channel's (schema, room, a bucket per
  player and channel) and ends the link of a player who floods. It takes
  500 subscribes at once from a player and then 50 a second (those to a
  service it does not serve included), sends a seed
  whole or refuses it, and sends again, in order, what the relay drops on
  `rel`. One connection serves several contracts in a room, one `serve`
  each.
- **A host knows each peer's link.** Each of `host.peers`, and the
  `ctx.peer` of a host-served channel's handler, carries `link`, the
  host's end of that player's link: its `clock.rtt` is the player's round
  trip, and its `setLag` lags that player. The host's own client reaches
  its host over an in-process link now, so it is one of `peers` with a
  link too, and a host can give its own play its players' lag.
- **Players change nothing.** `useChannel` and `useStream` of a
  host-served member reach the room's host over a link, made on first use
  and again for a new host or after a reconnect; the feed's seed replaces
  what it held, and a feed the host refused `RATE_LIMITED` asks again a
  second or so later. After a link to the host closed, the next waits 1 s,
  doubling to 15 s while links keep closing unopened. `hostOf(connection,
room)` and `onHostChange(connection, listener)` on `./client` say who
  hosts.
- **The wire.** Host mode adds link messages beside the app's own: a
  channel message (kind 3, on `fast`), subscribe and unsubscribe (4 and
  5), a seed in chunks (6), an item (7, on `fast` for a volatile stream)
  and a refused subscribe (8). `docs/protocol-v5.md` describes them and
  what a peer and a host must do.
- **Godot.** The GDScript client plays a player: `host_of(room)`, the
  `host_changed` signal, and a `room` argument on `send_channel`,
  `subscribe_stream`, `unsubscribe_stream` and `is_subscribed`.

### Client

- **`./client/core`: the client without React, for scripts, CLIs and
  workers.** `./client` opens with `"use client"` and imports React and
  TanStack Query when it loads, so a Node process that only opens a
  connection and calls `callData` had to install both.
  `@fitzzero/quickdraw-core/client/core` exports the connection
  (`createQuickdrawConnection`), `call`, `callData` and their helpers,
  `newId`, the backoff and the subscription lane, the auth routes' browser
  side and token storage, `reloadOncePerSession`, peer links
  (`createPeerLink`, `onPeerRequest`), host mode (`defineHost`, `hostOf`,
  `onHostChange`) and everything on `./utils`, with no `"use client"`.
  Nothing it reaches imports React or TanStack Query, in its code or in
  its types, so it needs only `socket.io-client`. `./client` re-exports
  it, the same functions, and keeps every name. The invalidation
  coordinator, the overlay store, the cache session and live data take a
  TanStack `QueryClient`, so they stay on `./client`.
- **`createServerCaller`'s `prefetch` takes a `QueryClientLike`**: the part
  of a TanStack `QueryClient` it calls (`prefetchQuery`), which any
  `QueryClient` is, so `./utils` names TanStack Query nowhere, in its types
  either. `QueryClientLike` is on `./utils` and both client entries.
- **A member's `useQuery` and `useSearch` never show the last user's result
  as a placeholder.** TanStack keeps the query a mounted observer's
  placeholder is made from outside the cache, which quickdraw empties on
  another user's hello or when the server ends the session. So the first
  render after the next user's hello could show the last user's result:
  the `placeholderData` of a member's `useQuery` (such as
  `keepPreviousData`, which could also keep it shown) and `useSearch`'s
  last results. This is the follow-up the 5.1 security review recorded for
  CLIENT-1. A member's `useQuery` now asks a `placeholderData` function,
  the caller's or its `QueryClient`'s default, only about a query the cache
  still holds; a placeholder given as a value is shown as before. An app's
  own TanStack hook over a member's `key` and `call` is not covered yet.
- **Behavior change: the admin kit's reads of rows default to
  `staleTime: 0`.** `adminList`, `adminGet` and `adminSubscribers` took the
  provider's five-minute `staleTime`, and their rows are not live, so an
  admin screen showed a row written elsewhere only after five minutes or a
  reload. Their `useQuery` now reads them again whenever a screen mounts,
  on the typed client and on a mock client alike. A `staleTime` the caller
  passes still wins, and `adminMeta`, `call` and `prefetch` are unchanged.
  A screen that passed `staleTime: 0` by hand can drop it.
- **`AdminQueryMember` gains `setData`**, typed as the typed client's: the
  query members `adminOf(qd, key)` returns always had it at run time, but a
  screen typed through `AdminScreen` needed a cast to call it. A row panel
  shows the row `adminUpdate` or `adminCreate` returned with
  `admin.adminGet?.setData({ id: row.id }, row)`, with no new read.
- **Behavior change: a server that cannot check the credentials signs
  nobody out.** A connect or reconnect the server refuses with `INTERNAL`
  (below: its `authenticate` failed with anything but a refusal, its
  session store down, say) keeps the hello, the grants and the cache, and
  is `status: "connecting"` (`reconnecting: true` after a connect on these
  credentials), so the README's `AuthGate` keeps the page, with
  "Reconnecting…" (or "Connecting…" before a first connect), rather than
  the sign-in. Socket.IO never retries a refused handshake, so the
  connection connects again itself, after Socket.IO's own reconnection
  delays (the manager's `reconnectionDelay`, doubling to
  `reconnectionDelayMax`, with `randomizationFactor`'s jitter), as often as
  its `reconnectionAttempts` allow. Calls and reads made meanwhile wait in
  the send buffer, as while Socket.IO reconnects. With Socket.IO's
  reconnection off, or its attempts spent, the connection is `refused`
  with `refusal: { code: "INTERNAL" }`, and still keeps the user.
  `UNAUTHENTICATED`, `FORBIDDEN` and the server's disconnect still sign out
  (CLIENT-1). The GDScript reference client connects again after an
  `INTERNAL` refusal the same way, with its backoff, and does not emit
  `refused` for it.

### Server

- **The legacy shim's `VALIDATION` replies list the input's issues.** A
  4.x client's refused input got only `Invalid input for <service>.<method>`
  in its `error`, since a 4.x reply carries no `data`; 4.1 sent the
  schema's own messages, and 4.x pages show the text. The `error` now
  names each issue by its dotted path, the first 10 then `; and N more`:
  `Invalid input for taskService.rename: title: Required; tags.0: Expected string`.
  The code (422) and the reply's shape are unchanged, and protocol 5, HTTP
  and MCP callers still get the issues as `data.issues`.
- **The development N+1 check no longer counts `createMany`.** A large
  insert split into fixed-size `createMany` chunks has one shape per
  chunk, so its tenth chunk raised `n-plus-one` (named
  `createManyAndReturn`, the form the tracked client runs), though the
  warning's own advice names `createMany` as the fix. A batch insert is one
  batch in chunks, as `no-db-call-in-loop` already treated it.
  `updateMany` and `deleteMany` filtered once per item still count.
- **Opening a live list no longer logs `prisma:error` lines.** Whether an
  order column may hold null, and whether a model has an `id` the tracker
  can key (the access check at startup), came from probes Prisma refuses:
  `count({ where: { column: null } })` on a required column and a select of
  `id` on a model without one, which a client created with
  `log: ["error"]` printed as database errors. `trackPrisma` now reads both
  from the schema text the generated client carries
  (`_engineConfig.inlineSchema`), with no statement, and probes only for
  what that text does not answer, as before.
- **Behavior change: calls through `ctx.services` carry the calling MCP
  call's `ctx.mcp`.** A method an MCP call reached through `ctx.services`
  saw no `ctx.mcp`, so a guard that tells a token's call apart by it read
  the inner call as a session's and let it through, and a frozen tool
  surface delegating through `ctx.services`, as the README advises, lost
  the token's fields. Every call made through an MCP call's
  `ctx.services`, nested ones included, now sees the same `ctx.mcp`, and
  its `ctx.transport` stays `"internal"`: tell a token's call apart by
  `ctx.mcp`, not by `ctx.transport`. A guard that refuses a token on a
  direct call now refuses it through `ctx.services` too. `qd.caller` and
  the other in-process callers are unchanged.
- **The MCP registry takes a caller the app signed in.** `call` and
  `callMethod` take `principal` in their options, so an app's own MCP
  transport over `callMethod`, or an in-process assistant, says who the
  call acts for, and the registry's `principal` hook is not asked (`null`
  calls anonymously). Until now such an app had to pass the user to the
  hook some other way, such as a `WeakMap` keyed by a request object. The
  `context` hook, bound arguments and the concurrency lane see that
  principal. One that carries no `serviceAccess` gets the grants
  `auth.loadServiceAccess` loads, at each call, as `qd.caller`'s; the
  hook's principal is still used as the hook returns it. The HTTP routes
  never read a principal from a request.
- **The admin kit runs `prepare` before each write.**
  `admin.handlers(contract, { prepare })` calls `prepare(call, ctx, db)`
  before `adminCreate`, `adminUpdate` and `adminDelete`, once the caller's
  access and data were checked, in one transaction with the write and
  `onWrite`: `call` is `{ method: "adminCreate", data }`,
  `{ method: "adminUpdate", id, data, before }` or
  `{ method: "adminDelete", id, before }`, `db` is the transaction's
  tracked client, and a throw undoes its writes and the write. Before a
  create or an update it may return column values, written over the
  caller's data, hidden and read-only fields included, so a column the
  server computes (a content hash) need not be an editable field of the
  entity; `id`, a timestamp, a relation or a nested write is `VALIDATION`,
  and an anchor column it sets (an `inherit` parent, an anchored
  collection's scope) needs the method's row level on the row it names, as
  for the read/write kit's `prepare` (`FORBIDDEN`): a lowered form never
  moves a row into a parent its caller cannot reach. What it returns before
  a delete is ignored. The tracked client never sees
  what the database deletes or clears with a row (`onDelete: Cascade`,
  `SetNull`), so those rows stayed in the lists and entities open on them:
  delete or clear them through `db` in `prepare`, and their subscribers are
  told. An `adminDelete` with `prepare` reads the row first, one statement
  more. `AdminPrepare` and `AdminPrepareCall` are on `./server`.
- **`ctx.access` asks the caller's level on any row.**
  `ctx.access.levelsFor(service, ids)`, `can(service, id, level)` and
  `where(service, level)` are `dispatcher.access`'s `levelsFor` and
  `accessWhere` bound to the call's principal, with the grants the call
  runs with; `service` is a contract or a service name. A `custom` form can
  now check a row no declared form names (a parent the input names, or a
  key that is optional), so the check moves out of the handler and into the
  form:
  `custom(async (ctx, input) => input.projectId === undefined || (await ctx.access.can(project, input.projectId, "Read")))`.
  A list such a form lets through without its key follows the row policy
  only when its handler filters it: add `ctx.access.where(service, "Read")`
  to the query with `AND`, as the README's and the access rule's example
  does. `ctx.access` counts levels as `{ entry }` does: a service-wide
  `Admin` reaches every row, and anyone else has no level on a row that is
  not found. An anonymous caller has none anywhere: an empty map, `false`,
  `"none"`. Every method call's `ctx` has it, MCP and `ctx.services` calls
  included, and so does the `ctx` the kits pass to their forms and
  callbacks; a context no dispatcher built throws `INTERNAL` on its use,
  and `qd` has none. Reading it in a `share: "all"` handler warns
  `shared-principal`. An app field named `access` from
  `initQuickdraw({ context })` is now shadowed by the framework's.
  `ContextAccess` is on `./server`.
- **A collection can require a service grant.** `collections: { mine:
{ scopeAccess: "self", requires: { service: "Read" } } }` in
  `defineService` gives a list the grant its methods ask for: besides the
  anchor or self check, every subscriber needs a service-wide grant of at
  least `L` on the collection's service, as a method's `{ service: L }`
  form counts it, and a service-wide `Admin` passes. Without it,
  `qd:col:sub` (cursor pages included), the scope's change topic and a
  search kept to the scope are `FORBIDDEN`, as for an anchor refusal. The
  grant comes from the socket's principal: when the user's grants reload
  below it, on any node, their sockets leave the scope with `qd:revoked`
  (`reason: "access"`) and get nothing more of it. A reload of a user's
  grants now resets their self lists after re-authorizing them, so a list
  being revoked gets no `reset` first. A self list whose methods ask for
  no grant takes no `requires`, and collections without it are unchanged.
  `CollectionRequires` is on `./server`.
- **A self list resumed after a reload of its user's grants reads a
  page.** The reload raised the resume floor of the user's self lists
  only to the current revision, and only after it authorized their other
  scopes again, so a client whose page was at that revision (nothing
  written since), or that resumed while the reload ran, replayed the
  buffer and kept the rows the user lost, until each row's next write. The
  floor now goes one past the current revision, before that
  authorization; a change to the user's membership of a parent row raises
  it one past too.
- **Breaking for types: `trackPrisma` returns `Tracked<C>`, a type the
  untracked client is not.** The tracked client had the client's own type,
  so nothing told it from the untracked one: a helper that writes could be
  handed the untracked client, whose writes reach no subscriber, and lint
  could judge a write only by its receiver's name. `Tracked<C>` is `C` with
  a mark, a type only, with nothing at run time: still a `C` wherever one
  is asked for, while the untracked client is no `Tracked<C>`. A helper
  typed `client: Tracked<PrismaClient>` takes the tracked client and
  refuses the untracked one at compile time.
  `TrackedTransaction<PrismaClient>` is the type of `tx` in
  `db.$transaction(async (tx) => ...)`, a nested one's too, and takes both
  `tx` and `db`, as does a kit callback's `db` (the admin kit's `prepare`,
  say) annotated with it. `$transaction`'s array form and options, the
  model delegates, what `$extends` added, a handler's `db` and
  `initQuickdraw<{ db: typeof db }>` are unchanged. Both types are on
  `./prisma` and on the root export, for a shared package without Prisma.
  On upgrade, a value typed `PrismaClient` no longer goes where
  `typeof db` (a `Db` alias of it), `Tracked<PrismaClient>` or
  `ReturnType<typeof trackPrisma>` is asked for. So these stop compiling
  (TS2345 or TS2322, "Property '[TRACKED]' is missing"): a parameter typed
  `PrismaClient` handed on to such a parameter, an app's own untracked test
  client, and a fake (`{} as unknown as PrismaClient`,
  `mockDeep<PrismaClient>()`). Nothing changes at run time. Type such
  parameters `Db` (or `Tracked<PrismaClient>`) and fakes as `Db`
  (`mockDeep<Db>()`, `{} as unknown as Db`). An app's own untracked test
  client is no `Db`: pass the tracked one, or cast it (`prisma as Db`)
  where its writes need reach no subscriber. A `db` declared
  `PrismaClient` (a lazy `Proxy`, say) carries no mark either: declare it
  `Tracked<PrismaClient>` to pass it to a `Tracked` or
  `TrackedTransaction` helper.
- **A job can count a stream's subscribers.**
  `await qd.stream(contract, name).subscribers(scope)` (`subscribers()` for
  a global stream; also on `server.stream` and `dispatcher.stream`)
  resolves with how many sockets subscribe to that feed on every node,
  anonymous ones included, so a job skips the work nobody watches: a price
  poll pushes only the instruments someone has open. Until now a job read
  Socket.IO's adapter rooms itself, which hold one node's sockets.
  Behind a cluster adapter the other nodes answer one request with a count
  each (presence's event, with a new `{ sockets }` request), so no socket
  is serialized. An answer that does not arrive within `cluster.timeoutMs`
  counts as 0, warned at most once every 10 minutes, and so does a node of
  an earlier version. A scope that does not fit rejects with a
  `TypeError`, and a host-served stream's handle refuses it, as it refuses
  `push`. `StreamSubscribersArgs` is on `./server`.
- **Behavior change: a handshake the server cannot authenticate is
  refused `INTERNAL`, not `UNAUTHENTICATED`.** The socket transport refused every
  failure of `authenticate` and `loadServiceAccess` with
  `{ code: "UNAUTHENTICATED" }`, an outage of the session store or the
  database included, and since 5.1 the client takes that code as the end of
  the session, so a database blip during a mass reconnect signed every
  reconnecting user out. Now only a refusal `authenticate` makes on
  purpose, a `QuickdrawError` with code `UNAUTHENTICATED` or `FORBIDDEN`
  (logged at debug; `FORBIDDEN` was logged at error), and a session that
  expired during the handshake are refused `UNAUTHENTICATED`. Anything
  else is refused `{ code: "INTERNAL" }`, logged at error as before, with
  the same "Authentication failed" message: `AuthenticationUnavailable`,
  with `isAuthenticationUnavailable`, on the root export, and in
  `docs/protocol-v5.md`. `socketAuth` refuses what it refused before
  (its `TypeError` for a `loadPrincipal` that returns another user's
  principal, an app's bug, is now `INTERNAL`). An `authenticate` that
  throws a plain `Error` for bad credentials should throw
  `QuickdrawError("UNAUTHENTICATED")` instead, or quickdraw's client keeps
  retrying it. HTTP calls are answered as before.

### Testing

- **`app.as(principal, { transport, mcp })` calls in process as another
  transport would.** `app.as(principal)` always called with transport
  `"internal"` and no `ctx.mcp`, so a test of a guard that reads either
  had to build dispatcher requests by hand. `transport` takes `"internal"`
  (the default), `"http"` or `"mcp"`, and `mcp` is the call's `ctx.mcp`,
  typed by the app's `QuickdrawTypes["mcp"]` (`TestCallerOptions` on
  `./testing`). A socket's transport is a `TypeError`: `app.connect` calls
  over a real socket. Each call is still dispatched and recorded once, so
  budgets count it as before. Bound arguments and the MCP registry's hooks
  are tested through `registry.callMethod`.

### Lint

- **The write rules read a tracked client's type.** `no-untracked-write`
  reported every write through a client named `prisma`, so a helper whose
  `prisma` parameter every caller filled with the tracked `db` was refused
  (farseer's 5.0 migration), and renaming the parameter `db` silenced the
  rule even for a caller passing the untracked client. A parameter or
  variable declared `Tracked<...>` or `TrackedTransaction<...>` (qualified,
  a union of only those, or an intersection with one) is now the tracked
  client whatever its name: `no-untracked-write` leaves its writes alone,
  and `no-nested-write` and `no-foreign-write` check them as `db`'s. A name
  in `clients` declared without such a type is still reported, and the
  rule's message says how to type a parameter given the tracked client.

### Codemod

- **A method object no longer collides with a binding of its name.** A
  split service's method module wrote each method object under its
  method's name (`export const renameTask = ...`), and the service file
  imported it under that name, whatever those files bound already. On
  Conveyor's 4.x code, 5 files did not parse (19 `Identifier ... has
already been declared`), lint found 15 more `no-redeclare` and
  `no-shadow` reports, and a method module imported 8 hoisted helpers
  beside method objects of their names (TS2440, which oxlint does not
  report): method modules kept a handler's body in a function named after
  its method or imported the implementation under that name, a service file
  imported the implementations too and destructured more from dynamic
  imports, and a service class's public methods of its methods' names,
  which the handlers called, were hoisted under those names. The codemod
  now renames what the file owns, with every reference: in a method module,
  a local function or binding of the method's name becomes `<name>Body`
  and an import of it `<name> as <name>Impl`; in the service file, an
  import of it becomes `<name> as <name>Impl`; a binding inside a function
  that would shadow the method object becomes `<name>Impl`. What other
  files see keeps its name: beside a helper the module exports under the
  method's name, the method object is `<name>Method`, and a service file
  that declares the name itself imports the object as `<name>Method` and
  lists it as `<name>: <name>Method`. A service class member of a module
  method's name is hoisted as `<name>Of<Class>`. No rename is marked: none
  leaves anything to decide.
- **An import the codemod adds is no longer dropped when the file imports
  the same module's export under another name** (`import { x as y }`): the
  name is added beside it.
- **The codemod's own tests fail on a name declared twice in one scope**
  anywhere in its output, whatever marker covers the line (TypeScript, which
  also sees an import beside a local declaration), and lint the output with
  `no-redeclare` and `no-shadow`, which the 5.0 lint baseline enables.
- **A field holding a function that the service replaces is hoisted as a
  `let`.** The codemod wrote every arrow or function-expression field
  (`provider = () => ...`) as a `const`, so code that swapped it
  (`this.provider = next`, now `provider = next`) did not typecheck (TS2588)
  and threw `TypeError: Assignment to constant variable` when it ran:
  farseer's migration hit 9 of them. A function field the class writes
  after its initializer, in its constructor or anywhere else, is now module
  state like any other field: a `let` with its type, under the same `[this]`
  marker. One nothing writes after its initializer stays a `const`.
- **The contracts the codemod writes import only what they use.** A contract
  imported core's `nullable` for a Zod `.nullable()` in a moved schema, and
  `z` when only a schema helper it had moved to `contracts/helpers.ts` used
  Zod, so every migrated app's lint and its `noUnusedLocals` typecheck
  reported unused imports in `packages/shared/src/contracts/*.ts` (farseer's
  migration filed it). A builder is now imported only for a call of it, and
  each contract and the helpers file the codemod creates get the import
  cleanup every file it rewrites gets.
- **A binding outside a service class no longer shadows a member hoisted
  beside it.** A module function's parameter, or a local of a method
  module's handler, named like a member the codemod hoisted where that code
  lives (declared there, or imported) shadowed it (`no-shadow`; Conveyor's
  `reviewCatchUp` in `task/TaskService.ts`), and a handler's local could
  capture what the handler read through the service:
  `const limit = service.limit` became `const limit = limit`. Such a binding
  is now renamed `<name>Impl`, with every reference; the member keeps its
  name.
- **A `readonly` field its constructor writes is hoisted as a `let`.**
  `readonly` kept a field, or a function field, a `const` even when its
  constructor assigned it, so the setup function that carries the
  constructor's code wrote a constant (TS2588, and a `TypeError` when it
  ran). A field is a `const` only when nothing writes it after its
  initializer. The codemod's own tests now fail on any write of a `const`
  in its output, whatever marker covers the line.
- **A function field that stays a `const` keeps its type annotation**
  (`const slug: (name: string) => string = (name) => ...`): without it, an
  initializer whose parameters took their types from the field's was
  implicitly `any` (TS7006).

## [5.1.1] - 2026-10-11

### Behavior changes for 5.1 apps

- **More id-taking methods are refused when they are defined.** On a
  service with an access policy, `defineService` now throws at startup for
  a method whose input has `id` under `custom(...)`, `{ scope, of, id }` or
  `{ entry, id: "<another key>" }`, unless it says `rowless: true` (a kit
  takes `rowless: [names]`). The ways out: `{ entry: L }` (with `claims`
  beside it for a check on the caller's claims); `rowless: true` when every
  caller the form admits may reach any row; and `rowless: true` on a
  hand-written create whose optional `id` is one the client made, under a
  `scope` form. The read/write kit's `create`, `update`, `delete` and
  `reorder` stay exempt. The codemod now writes `rowless: true` (marked)
  where a 4.x `resolveEntryId` named another key of a payload that also has
  `id`.
- A method takes a new option, `claims`, and `ServiceMethod` gains
  `claims`.
- **An `authenticate` that `socketAuth` did not make no longer finds the
  session cookie in `auth.token` on HTTP.** It is in
  `request.sessionCookie`, and `auth.token` holds only a bearer token. An
  app whose own `authenticate` accepted cookies on `/qd` reads that field
  and checks `cookieOriginAllowed` and `liveSession`; bearer-only code now
  ignores the cookie, so a cookie-only call is anonymous to it. An app's
  wrapper around `socketAuth` keeps cookie sign-in.
- `verifyJWT` logs one warning per process in development when it verifies
  a token carrying `sid` (a session token), since it checks no session
  store.
- The README's MCP callers are `kind: "agent"`, and MIGRATION's
  `trust proxy` defaults to 0 (`TRUST_PROXY`).
- **The read/write kit's `create` checks what it writes.** A create whose
  input carries a column the policy reads (`ownerId`, `acl`) is `FORBIDDEN`
  unless the caller is a service-wide Admin: set it in `prepare`. A create
  into a parent (or an anchored scope) where the caller lacks the method's
  row level is `FORBIDDEN` under any form, `{ service: L }` grants below
  Admin included, since anchors are asked without grants, as `update`'s
  moves already were; an anonymous create that names an anchor is
  `FORBIDDEN`. It costs one more engine call per anchor column it writes.
- **An `update` or `upsert` whose data holds a nested write reads first.**
  When its model has interested columns (a policy's, a collection's), it
  runs one more statement and its record's `fields` lists those columns, so
  revocation, cache eviction and collection moves follow relation-form
  foreign keys on the written row. Every such write to a row a policy reads
  is now an access change, whether or not the foreign key moved: it
  re-resolves that row's subscribers (entities, collection scopes, topics,
  streams), and behind a cluster the flush's frames wait for every node to
  answer, as for any access change. The `nested-write` warning's text
  changed.
- **`createServer` names access models it cannot track.** A model a policy,
  a membership table or a `via` junction depends on without an `id` column
  (a composite `@@id`) logs `[quickdraw:untracked-access-model]` at error
  level, in every environment; a strict test app fails to start.
  `StorageAdapter` gains an optional `trackable(model)`.
- **A kit write holding a relation key or a nested write is `VALIDATION`**,
  for service-wide Admins too, and for a Json value whose own key is a
  relation operation holding rows, or `delete`/`disconnect` set to `true`
  (keep such data a level deeper), and for any `{ set: [...] }`, a scalar
  list's included (write the list itself). A
  `prepare` that returns one is `INTERNAL`. The admin kit shows relation
  fields as `editable: false`, refuses writes to them, and refuses an
  `editable` list or `fieldOverrides` entry naming one when the service is
  defined.
- **`share: "all"` is refused on the kit methods whose result depends on
  who asks.** `defineService` throws for `"all"` on the read/write kit's
  `list` and `getMany`, `search`, the sharing kit's `listShares` and
  `listMembers`, and the admin kit's `adminList` and `adminGet`: use
  `share: "caller"`.
- In development, an app handler of a `share: "all"` run that reads
  `ctx.principal`, `ctx.services` or `ctx.mcp` logs
  `[quickdraw:shared-principal]`, and a strict test app fails that call
  with `INTERNAL`. `DevWarningKind` gains `shared-principal`.
- **"Not modified" answers only for a row the form checked.** The default
  "not modified" answer now comes only when the method's form checked the
  row its input's `id` names (an `entry` form on `id`, a `scope` form on the
  service's own rows by `id`, `{ service: "Admin" }`), for a caller the
  service's `Admin` bypass passes, and for a `rowless: true` method under a
  form that checks no row (`"public"`, `"authenticated"`, `{ service: L }`).
  Every other query runs its handler every time, more work for the same
  data: a `scope` form on another service, `custom`, an `entry` form on
  another key or with an `id` function (`rowless` or not), and, on a service
  without an access policy, a `"public"`, `"authenticated"` or
  `{ service: L }` query that does not say `rowless: true`.
- **A self list follows its service's policy.** A `scopeAccess: "self"`
  collection on a service with an access policy shows only the rows its
  user may read at `Read` (a service-wide Admin with `adminBypass` still
  sees all of their scope). A row the user loses goes out `removed`. A
  change to the user's membership of a parent row, or a reload of their
  grants, sends their open self lists `reset`; a membership write without
  values resets every open self list of that service. Clients load them
  again, and a resume after such a change reads a page. Pages and
  `qd:col:items` of such a scope cost the policy filter's reads, and each
  flush costs one batched lookup per self scope it sends to (per distinct
  principal of its user there; on one server, none for a frame of removals
  alone). A service-wide Admin who views another user's self scope reads it
  whole, but its frames follow the owner's level. Gaps: a parent row's own
  access columns (a project's owner or access list) reach a self list only
  at the rows' next write or the list's next load; behind a cluster, a node
  without the owner's socket decides for a principal that holds the owner's
  user id only (no grants, kind, claims or app fields), so a row read only
  through a service-wide grant goes out `removed`, and a `resolver` that
  needs more of the principal must cope with that one; a regained row comes
  back at its next change or the list's next load.
- **`reorder` keeps to the rows its caller may write.** A neighbor the
  caller cannot write at the method's row level is `NOT_FOUND`, as a
  missing one is, and the list a move reads and renumbers is the caller's
  writable rows of the `within` list: under a per-row policy every list is
  per caller, and a list with no `within` or a null one is the caller's own
  rows. The rows a move names are read through the same filter, so a policy
  whose filter matches no row (a `resolver` without `where`) makes `reorder`
  `FORBIDDEN` below a service-wide grant. A move under an `{ entry }` form
  costs one batched lookup more (other forms made one already), plus the
  write filter's reads.
- **An unscoped search comes in id order.** `search` without `scope` no
  longer uses the scope collection's order.
- **A cursor too long names its row.** A `list`, `search` or
  `listMembers` cursor that would pass 4,096 characters (a long sort value)
  names its row instead: the next page costs one more read, and the cursor
  is `VALIDATION` once the row has left the list. Such a cursor follows its
  row's current sort value.
- **A via list over the item service's members table counts only links at
  its access.** In such a list (the junction is the table the service's
  `members` policy reads), a link whose role maps below the collection's
  `access` no longer makes the row a member: it is in no page, count,
  index, `qd:col:items`, scoped search or delta, and a role change across
  that line sends `removed` or `added`. Apps whose members all hold at
  least the list's access see no change; a member below it (a `Public`
  role, or a guest-like one such as `levels: { guest: "Public" }`) drops
  out of the list. A role missing from the map counts as no level, as in
  the policy. A role change that keeps the link counted (`Read` to
  `Moderate`) reads nothing; one across the line reads the junction once.
- **The read/write kit's bulk methods take their single-row level.** A
  bulk method whose form names no level (`"authenticated"`, `"public"`,
  `{ service }`, `custom`) now skips the rows below the row level of
  `delete`'s form (`bulkDelete`) or `update`'s (`bulkUpdate`) when that is
  higher than `Moderate`; it never goes below `Moderate`. A counterpart
  form that names no row level (`{ service: L }`, `custom`) changes
  nothing: give both the same form. The README sample's `bulkDelete` is
  `{ entry: "Admin", id: "ids" }`, which refuses the whole call (an empty
  `ids`, or an id with no row, is `FORBIDDEN`), and its `archive` is
  `Moderate`.
- **An owner column an anchored collection scopes by stays read-only.**
  Without a service-wide Admin grant, a kit write may not set a column the
  policy reads even when a collection is anchored by it: set it in
  `prepare` on create.
- **Membership columns are read-only through the kits.** A membership
  table's entry, user and role columns that any policy reads are refused
  in the read/write kit's `create` input and writes and in the admin kit's
  writes without a service-wide Admin grant: use the sharing kit.
- **Connection state recovery is refused.** `createServer({ socket: {
connectionStateRecovery } })` throws a `TypeError` at startup, and
  `SocketOptions` no longer accepts the key: a recovered socket skipped
  authentication. quickdraw clients resume by revision on every reconnect.
- **A watch or stream subscribe that loses access while it is answered is
  refused.** A `qd:watch` or `qd:stream:sub` whose access an access change
  took while it was authorized answers `FORBIDDEN` instead of joining. A
  subscribe whose window overlapped an unrelated access change costs one
  more access lookup, and joins once that lookup allows it: a stream item
  pushed meanwhile is in its seed, not sent as a frame. A stream subscribe
  an unsubscribe overtook answers `seed: []`, not the kept items.
- **Subscribes re-check with the socket's current grants.** Entity and
  collection subscribes that overlapped an access change resolve again with
  the grants the socket holds at that moment: a grant lowered mid-subscribe
  denies, a raised one answers at the new level.
- **`__Host-session` is read first wherever the request carries it.** On a
  plain HTTP request (development, an SSR hop without `X-Forwarded-Proto`),
  the transports, `requireSession` and the auth routes read
  `__Host-session` before `session`, and the routes, `setSessionCookie`
  and `clearSessionCookie` clear a stale `__Host-session` when they set or
  clear `session`. The startup warning for an empty `cookie.domain` while
  `COOKIE_DOMAIN` is set now says why it matters: the transports take a
  `session` cookie over HTTPS there, which any site under that domain can
  set.
- **The OAuth state cookie is signed.** Its format changed, so a sign-in in
  flight during the deploy lands once on `?error=state`. It is named
  `__Host-qd_oauth` whenever `publicUrl` is https.
- **Development sign-ins need `NODE_ENV` `development` or `test`.**
  `socketAuth({ devCredentials })` throws at startup, and the mock provider
  mounts nothing (logging an error), when `NODE_ENV` is anything else,
  unset included: set `NODE_ENV=development`. The server warns at startup
  while `devCredentials` is on, and mounting the mock logs a warning.
- **Sockets end when their session expires.** A socket `socketAuth`
  authenticated is disconnected (`io server disconnect`, no automatic
  reconnect) when its session expires; `recordSocketSession(socket,
sessionId, expiresAt)` does the same for an app's own `authenticate`.
  `expiresAt` is a `Date` or epoch milliseconds (a JWT's `exp` is in
  seconds: pass `exp * 1000`), and a handshake whose recorded session
  expired before it ended is refused `UNAUTHENTICATED`.
- **The cookie routes check the page's Origin.** `/me`, `/logout` and
  `/logout-all` answer 403 to a session cookie sent from a page
  `allowedOrigins` does not list, and `/guest` to such a page whatever it
  sends.
- **A late collection change goes out as the row is now.** On one server
  too, a collection delta that is not a removal is decided by its row as
  read for the frame: a change whose flush ran after a later write moved
  its row goes out `removed` to the scope the row left. The read takes the
  scope's columns too.
- **A deleted via entry reaches only its lists.** A tracked `delete` or
  `deleteMany` of a model a `via` collection lists reads that entry's
  junction links first (one read per junction, and one more for a `delete`
  whose `where` has no `id`), and records them in `WriteRecord.links`, a
  new optional field app flush sinks see. Its removal goes only to the
  scopes it was linked to, and to none of a filtered list when it was
  outside the list's `where`. A removal nobody can place (a `ctx.touch`
  with `removed`) still reaches every subscribed scope, and a client
  resuming any scope of that collection across one, subscribed on the
  server or not, reloads the scope instead of replaying it.
- **Sharing changes refuse users above the caller.** Under a lowered form
  (`share: { entry: "Moderate" }` and the like), `share` replacing a level,
  `setLevel`, `unshare`, `remove` and `setRole` answer `FORBIDDEN` for a
  user whose current level is above the caller's; equal levels pass. Under
  a form with no row level (`custom`, `"authenticated"`, a scope form,
  usually with `rowless`), the caller's own level is their level on the
  row, often none, so such callers can no longer `unshare` or `remove`
  users who have a level; name `service` in the form for a grant to count.
- **With `cacheMs`, access checks inside a transaction read the database.**
  A sharing change's re-check of its caller (and any `levelsFor` inside
  `db.$transaction`) no longer reads the access cache, so it costs its
  statements there.
- **The sharing kit's method descriptions changed.** They say the caps and
  the one-user lookup; MCP tool descriptions and generated API docs show
  them, so apps that commit docs pages regenerate them.
- **One socket holds at most 10,000 rows, 1,000 collection scopes and
  1,000 topic watches.** One more is `CONFLICT` (the hook's error; the
  client retries only `RATE_LIMITED`), as a 501st stream feed already was;
  a `qd:sub` whose new ids would pass the cap is refused whole, and a row
  that batches running at once left no room for is answered `CONFLICT` on
  its own. `qd:hello` announces the caps in three more
  `limits.subscriptions` fields.
- **The admin kit hides the grants column by its configured name.** On the
  users service of an app whose `auth.serviceAccessSource` column is not
  named `serviceAccess`, that column leaves `adminMeta`, rows and writes
  unless `grants: true`, and then shows to service-wide Admins only. Kits
  that name it in `editable`, `fieldOverrides`, a filter or a sort without
  `grants: true` (or hide it beside `grants: true`) fail at startup, and
  `grants: true` type-checks on any entity but fails when the dispatcher is
  made for one with no grants field. Apps that use `serviceAccess` see no
  change.
- **A dispatcher made without `createServer` names the grants column
  itself.** `createDispatcher` takes `serviceAccessSource: { model, column }`
  (`createServer` passes its `auth.serviceAccessSource` and refuses the
  option at the top level), and `createHttpRouter` throws when its
  `auth.serviceAccessSource` is not its dispatcher's. An app that serves
  HTTP or MCP from `createDispatcher` and stores grants in a column passes
  it there, or the admin kit treats that column as an ordinary field.
- **A channel without `requires` warns.** A channel whose contract
  declares no `requires`, and whose service declares no `access` for it,
  logs `[quickdraw:channel-without-requires]` when the server starts, and a
  test app made with `strictWarnings` fails to start until the channel
  gets a `requires` or `access: "authenticated"` (which delivers as
  before).
- **A scoped stream's room is a function of its scope.** A scoped stream
  with `access: { room: "name" }` or `{ room: { prefix } }` fails at
  `defineContract`, by type and when it runs; it takes `(scope) => room`.
  Global streams keep both forms.
- **Room names with the shape of a socket id are refused.** An app room
  name of exactly 20 letters, digits, `_` or `-` (a Firestore-style id,
  and plain names such as `general-announcement` or `tournament_finals_24`
  too) is `VALIDATION` in `ctx.rooms.join`, `rooms.size`, `rooms.leave`
  and presence, and refused as a literal in a contract: check literal room
  names, and give such a name a prefix.
- **`rooms.emit` refuses the framework's rooms.** `emit("user:…")` and
  `emit("qd:…")` are `VALIDATION`; send to a user with `emitToUser`.
- **Presence counts only rooms joined through `ctx.rooms.join`.** A socket
  a raw `socket.join` put in a room is no longer counted on this process.
- **A service name with `:` or `@` throws** at `defineContract`.
- **The MCP HTTP routes refuse web pages unless listed.** A request
  carrying an `Origin` header gets 403 unless
  `createMcpHttpRouter({ allowedOrigins })` lists its origin; a page that
  calls `/mcp/invoke` must be listed. `allowedHosts` optionally refuses
  other `Host` names.
- **MCP queries over HTTP share one lane per caller.** Per bearer token,
  per user without a token, or per address when anonymous (an IPv6 address
  by its /56): a busy agent can see `RATE_LIMITED`, and the development
  `repeated-call` warning now counts one HTTP caller's calls together, so a
  `strictWarnings` test app throws on more than 10 identical calls a
  second from one caller.
- **An MCP input with `.meta({ id })` takes its object's properties as
  arguments**, no longer `{ input }`, and its bound keys bind (a schema
  made from it, as `.optional()` or `.refine()` make, still takes
  `{ input }`); a bound key in an id'd union or intersection branch, or in
  an input without arguments, now fails `createMcpRegistry`, and a call
  that sends a bound argument its tool does not fill is `FORBIDDEN`
  (before, it was stripped or passed on). A wrapped input's `definitions`
  move to the tool schema's root, and a recursive one refers to itself as
  `#/properties/input`, so listed references resolve.
- **MCP custom tools obey `initQuickdraw({ kinds })`**, and take `kinds` of
  their own; custom tools served beside the services of apps that admit no
  kind in common fail `createMcpRegistry`.
- **A `principal` hook's `QuickdrawError` refusal logs at debug**, not as an
  error.
- **`setupRedisAdapter` without `keyPrefix` keys the adapter by
  `cluster.keyPrefix`** (`"quickdraw"` by default) instead of `"socket.io"`.
  The deploy that upgrades a cluster splits old and new nodes unless it
  passes `keyPrefix: "socket.io"` for that deploy (docs/deploying.md,
  "Deployments sharing a Valkey").
- **Nodes log events from other deployments and older nodes.** An event of
  another `cluster.keyPrefix` is answered and ignored, with one error; an
  event without a deployment (a node of an earlier version, during a rolling
  deploy or of a deployment that shares the Valkey and was not upgraded) is
  applied, with one warning. `createServer` checks `cluster.keyPrefix`
  before it starts anything, and refuses `null` as well.
- **`cluster.keyPrefix` must be a non-empty string**, or `createServer`
  throws.
- **The default console logger drops `debug` in production.** A call's
  record logs at debug with its caller's user id; pass
  `createConsoleLogger({ level: "debug" })` as `logger` to keep it.
- **A Prisma error is logged summarized.** `describeError`, and so every
  log of a failed call, gives a Prisma client error as
  `{ name, code, meta, reason?, clientVersion, stack }` (the stack's frames
  only; `meta` keeps only the keys that name the schema or a code, and of
  Prisma 7's `driverAdapterError` its kind, codes, constraint, column and
  table), and the auth routes', the admin kit's and the write tracker's
  string `error` fields as `"<class> <code>: <reason>"`: a log processor
  keyed on `error.cause.message` of a Prisma failure finds none.
- **The HTTP call limiter's 429 says `no-store` and `nosniff`** too.
- **`/qd` replies say `Cache-Control: no-store`** and
  `X-Content-Type-Options: nosniff`.
- **`quickdraw-skills link` links into the project that installs it.** It
  anchors on the nearest `package.json` above the working directory whose
  `node_modules` holds the package, not on the nearest `.git`; it fails
  (exit 1) when there is none, and refuses the home directory.
- **A session the server ends signs the client out.** After the server's
  disconnect (`disconnectUser`, `onRevoke`, a session that expires, a
  flooded channel) or a connect or reconnect refused with `UNAUTHENTICATED`
  or `FORBIDDEN`, `isKnown` is false, `userId`, `hello` and `serviceAccess`
  are null, and quickdraw's cache is empty, data a server render
  prefetched included; calls queued during that reconnect fail with
  `CANCELLED`. A handshake is `UNAUTHENTICATED` whenever `authenticate`
  fails, a session store that does not answer included, so a reconnect
  during such an outage signs the client out too. A gate on `isKnown` alone
  now shows its loading state there: while it is false, treat `status`
  `"disconnected"` or `"refused"` as signed out, as the README's `AuthGate`
  does. A client
  disconnected for flooding a channel now looks signed out, where before
  it was silently disconnected (Socket.IO never reconnected it; a reload
  signs back in while the session lives). A dropped transport or a
  `qd:rotate` keeps everything, as before.
- **Presence across nodes is a request answered with user ids.** A node
  asks the others with `quickdraw:presence` instead of reading their
  sockets. During a rolling deploy from an earlier version, whose nodes
  never answer it, a read waits `cluster.timeoutMs` once and then reads
  every node's sockets for 30 s at a time, with a warning at most once
  every 10 minutes.

### Security

- **A check on a token's claims adds to the row check (ACCESS-1,
  ACCESS-4).** The README's, MIGRATION's and the sample app's `triage`
  example checked a token's `scope` in a `custom` form on a method that
  updates `input.id`. A `custom` form replaces the row check, so any token
  holding that claim could write tasks in every tenant, and a missing id was
  a `NOT_FOUND` existence oracle; a service-wide `Admin` grant skipped the
  check, so an Admin user's narrowed token was not narrowed. A method now
  takes `claims: (claims, input) => boolean` beside `access`: it adds to
  the form, runs right after `kinds` outside the access engine, so no app
  engine or grant skips it, and answers `UNAUTHENTICATED` without a
  principal and `FORBIDDEN` unless it returns `true`. The example is now
  `{ entry: "Moderate" }` plus `claims`.
- **An id-taking method can no longer pass a check on another row
  (ACCESS-1, ACCESS-5).** The pack H refusal of id-taking methods under a
  form that checks no row exempted `custom` forms, and missed
  `{ scope, of, id }` forms and `{ entry, id }` forms naming another key on
  inputs that carry `id`: each lets everyone it admits reach any row by its
  id. `defineService` now refuses them too, each with a message naming the
  row it checks and the ways out.
- **Session tokens are checked against the session store on MCP and in
  custom auth (AUTH-1, MCP-2, CLIENT-2).** The README's `verifySession`,
  the MCP bridge's `principal` hook and MIGRATION's server `authenticate`,
  was `verifyJWT` alone: a signed-out, logged-out-everywhere or revoked
  session kept working until its JWT expired (7 days), and a JWT without a
  session forever. `bearerAuth({ sessions, jwtSecret, loadPrincipal? })`
  (`./server/auth`) checks a bearer token against the store on every call,
  and the examples use it (or `socketAuth`). The HTTP transport handed
  every `authenticate` the ambient session cookie as `auth.token`, so code
  written for bearer tokens took a cross-site page's cookie for one, past
  the Origin rule only `socketAuth` applies; the cookie is now `auth.token`
  only for `socketAuth`'s `authenticate`.
- **The read/write kit's `create` checks the parents it writes into
  (CRUD-1, ACCESS-3).** It checked no anchor, yet it was exempt from the
  id-reach refusal as checking its row: under `"authenticated"`,
  `"public"`, a service grant or `custom`, any caller wrote rows into
  another tenant's project, and a scope form left a second anchored column
  (`assigneeId`) unchecked. `create` now needs the method's row level on
  each anchor row its new row names, after `prepare`, and takes a column the
  policy reads only from `prepare`.
- **Kit writes take column values only (CRUD-5, DATA-2, ADMIN-1).** A
  relation key or a Prisma nested write reached Prisma through the kits'
  writes: the admin kit validated `data` but wrote the raw object, and the
  read/write kit wrote whatever a schema kept (`z.looseObject`, and ArkType
  by default). Nested writes are not tracked and passed the column guard by
  name, so `{ project: { update: { ownerId } } }` made a member the
  project's owner and `{ assignee: { update: { serviceAccess } } }` rewrote
  the caller's own grants. Every kit write now refuses them.
- **A foreign key set through a relation revokes access (DATA-1).** A
  write like `db.task.update({ data: { project: { connect: { id } } } })`,
  `owner: { connect }` or `{ disconnect: true }` changed an access column,
  but the tracker reported only the relation's name: no revocation, no cache
  eviction, no collection move, and the old tenant or owner kept receiving
  frames. Such a write now reads the row's access and scope columns first
  and reports them.
- **A membership table without an `id` is no longer silently untracked
  (DATA-3).** A table keyed by a composite `@@id` (the `members()` doc
  example had no `id`) was never tracked, so removing a member never
  revoked them. `createServer` now names every such model access depends
  on, at start; give it an `id` and keep the pair unique with `@@unique`.
- **Revocation settles before a flush's frames (DATA-I1).** One socket's
  failed re-resolution let the flush send its frames while other sockets
  were still being re-resolved, so a demoted socket could receive them.
- **`share: "all"` no longer hands one caller's rows to another
  (ACCESS-2, CLIENT-3).** A `"all"` run's handler runs with the first
  caller's `ctx`, and every caller gets its result, yet nothing stopped
  `{ ...crud.handlers(...).list, share: "all" }`: a caller who owned one
  project received another tenant's rows. The kits mark such methods and
  `defineService` refuses `"all"` on them; the README and skills state that
  a shared result must depend on the input only, and development warns
  when an app's `"all"` handler reads who the caller is.
- **"Not modified" answers only for a row the form checked (ACCESS-6).**
  The default version source answered for `input.id`'s row whatever the
  form checked, before the handler ran: a query under a scope form told a
  caller outside it that a row existed and had not changed.
- **A self list no longer shows rows its user may not read (COLL-1).** A
  `scopeAccess: "self"` scope (the README's `assigned` example) passed on
  the user id alone, and its pages, items and frames held every row whose
  scope column named the user. A task still assigned to a user removed from
  its project kept reaching them, title and all, and no access change ever
  reached a self subscription. Its reads and frames now follow the item
  service's policy.
- **`reorder` no longer reaches other tenants' rows (CRUD-6).** It
  checked only the moved row, so with a null or absent `within` a caller
  named another tenant's rows as neighbors, read their ordinals, and made
  renumbering rewrite every tenant's rows.
- **An unscoped search no longer leaks a tiered order column (CRUD-4).** It
  ordered by the scope collection's order, which may hold a column tiered
  at the collection's access, and `nextCursor` carried that column's values.
- **A demoted member drops out of a via list (COLL-1, via variant).** A
  `via` collection over a membership table counted every link, so a member
  demoted below the list's access kept the project in their list, with its
  updates.
- **A bulk delete no longer deletes rows `delete` refuses (CRUD-2).** The
  README's map paired `delete: { entry: "Admin" }` with
  `bulkDelete: "authenticated"`, which wrote at `Moderate`: a member
  deleted Admin-only rows in bulk. Bulk methods now take their
  counterpart's row level.
- **A member can no longer make themself a row's owner (CRUD-3).** An
  owner column that an anchored collection also scoped by (`assigneeId`,
  a `jsonAcl` owner) was only checked as an anchor move, so a member set
  it to themself and became the row's Admin, or took over a project.
- **A member can no longer raise their own role through a kit (CRUD-7).**
  The kits locked only the written service's policy columns, so crud on a
  membership table set the caller's own role to `Admin`.
- **MIGRATION no longer trusts a proxy unconditionally (CLIENT-6).** Its
  `app.set("trust proxy", 1)` let a client without a proxy in front pick its
  own `X-Forwarded-For`, and pass every per-IP limiter; it reads
  `TRUST_PROXY` (0 by default), as the README's routes do.
- **A grant lowered mid-subscribe no longer keeps its room (LIVE-1).** A
  subscribe's race re-check resolved with the principal captured when it
  began, so a service-wide `Admin` demoted while a `qd:sub` or `qd:col:sub`
  ran joined the `Admin` room or the scope, and kept it.
- **Topic watches and stream subscribes settle their races (LIVE-2,
  RT-1).** They authorized and joined with no re-check, so a member removed
  while subscribing kept the topic's `qd:changed` or the stream's items,
  seed included.
- **Connection state recovery can no longer skip authentication
  (TRANSPORT-1).** Socket.IO's recovery skipped the auth middleware and
  restored a socket's principal and rooms, so a revoked session or a
  lowered grant came back for up to 2 minutes.
- **A planted `session` cookie no longer chooses the account (AUTH-2a,
  CLIENT-4).** A plain HTTP request read `session` before
  `__Host-session`, so a sibling site that planted `session` signed the
  user in as the attacker on the SSR hop, same-origin GETs,
  `requireSession`, `/auth/me` and a polling handshake behind a TLS proxy
  that sent no `X-Forwarded-Proto`.
- **The OAuth state cookie cannot be planted over HTTPS (AUTH-2b).** It was
  `qd_oauth` unless the request looked secure, so a sibling site could
  plant one, with a state the attacker had the provider sign them in to,
  and sign the victim's browser in as the attacker (login CSRF). It is now
  `__Host-qd_oauth` whenever `publicUrl` is https, which no other site can
  set; a deployment on an http `publicUrl` keeps the risk. It is also
  signed, so its payload (state, return origin, provider, age) cannot be
  forged.
- **Development sign-ins no longer run outside development (AUTH-3).**
  `devCredentials` and the mock ran whenever `NODE_ENV` was not exactly
  `production`, so with `NODE_ENV` unset, `prod` or `staging` a raw socket
  naming an admin's user id signed in as them from any page.
- **A socket no longer outlives its session (AUTH-4).** Authentication ran
  once per handshake, so a socket kept its principal after its session
  expired.
- **The cookie routes apply the Origin rule (AUTH-5).** `/me`, `/logout`,
  `/logout-all` and `/guest` skipped the session cookie's Origin rule, so a
  cross-site page with CORS help could read the user id, sign the user out
  everywhere, or sign the browser in as a new guest.
- **A late flush no longer sends a moved row to the scope it left
  (COLL-2).** One server took a delta's scope from the write's own values,
  so a unit whose flush ran behind a slow handler tail or a busy queue sent
  a row's new values (a title, an item) to the list it had already left,
  whose readers may not see where it went.
- **A deleted via entry no longer tells every subscriber its id (COLL-3).**
  Every subscribed scope of a `via` collection, and every watched topic of
  it, got the removal of every deleted entry, and every resume buffer kept
  it.
- **A sharing change can no longer demote or remove someone above the
  caller (SHARE-1).** Under a lowered form, a Moderate member could replace
  an `Admin` entry with `share`, or demote or remove an Admin with
  `setLevel`, `unshare`, `setRole` or `remove`.
- **The README's `resolveUser` names exactly one user (SHARE-2).** It took
  the first user with a display name, so whoever registered a name first
  received every by-name share meant for another. It now finds an email by
  `findUnique`, and a name only when exactly one user has it. Apps that
  copied the old resolver must change theirs: the kit takes what the
  resolver returns. Roles that map to one level are peers (SHARE-3): an
  `admin` role may demote an `owner` role, so protect an owner with an
  owner column.
- **One client can no longer exhaust the server's memory with
  subscriptions (COLL-4).** Nothing counted the collection scopes, topic
  watches and rows one socket held, so a client subscribing to an endless
  run of made-up scopes grew the server's memory without end.
- **The admin kit protects a grants column of any name (ADMIN-2).** It hid
  and Admin-gated only `serviceAccess` and `service_access`, so with
  grants stored under another name every admin caller saw them, and a user
  under a lowered form could write their own. That holds on a dispatcher
  made without `createServer` too (`createDispatcher({ serviceAccessSource
})`), which `createHttpRouter` checks.
- **A sharing change's re-check no longer reads a stale cache (SHARE-4).**
  With `cacheMs`, the re-check of the caller inside the change's
  transaction read the access cache, so a caller demoted by a write the
  tracked client did not see kept their old level for up to `cacheMs`.
- **An open channel is named at startup (RT-3).** A channel without
  `requires` takes every signed-in socket's message, and MIGRATION.md's
  example relayed a cursor to the project room its payload named, so any
  user reached any project's room. The server now warns on such channels,
  and the example's channel requires the room a checked `joinProject`
  joins.
- **A scoped stream's room follows its scope (RT-4).** A name or prefix
  room let a socket in `world:1` read scope `2`; `defineContract` refuses
  both on a scoped stream.
- **No app room joins a socket's own room, and `rooms.emit` sends to no
  framework room (RT-I1).** `ctx.rooms.join(<socket id>)` joined another
  socket's own room, presence answered with its user, `rooms.size` counted
  it, and `rooms.emit("user:<id>")` reached any user. Those names are
  refused (`emit` still sends to a name of a socket id's shape, which grants
  nothing), and presence reads only the rooms `ctx.rooms.join` joined.
- **Service names split rooms one way (LIVE-3, COLL-6).** A `:` or `@` in
  a service name let two services share an entity, collection or stream
  room name, which authorizes `qd:col:items` and keys the resume buffers.
- **The README's sharing example takes a removed user out of the board
  room (RT-6).** Its `onChange` only logged, so a user who lost access kept
  receiving the board's events.
- **An MCP agent bound to one task stays on it (MCP-1).** An input written
  as a `$ref` (a Zod schema with `.meta({ id })`) was not seen as an object,
  so its bound key was never filled and the agent named any task; a bound
  key behind a `$ref` in a branch went unchecked; and a loose input passed a
  stray bound key on.
- **A web page cannot call the MCP HTTP routes from a user's browser
  (MCP-3).** They answered any `Origin` and `Host`.
- **One MCP HTTP caller cannot run unlimited queries (MCP-4).** Each request
  was a lane of its own; 120 concurrent anonymous calls all ran. An IPv6
  caller's lane is its /56, which one host commonly holds.
- **MCP custom tools check the caller's kind (MCP-6).** An agent ran a
  custom tool of a users-only app.
- **A refused MCP token is no error log (MCP-7).** A hook's refusal was
  logged as an error, with whatever its message held.
- **Deployments sharing a Valkey stay apart, each with its own
  `cluster.keyPrefix` (RT-2).** Pub/sub is shared across a Valkey's
  databases, and nodes applied every server-to-server event they heard:
  staging's reloaded grants made a production user Admin until they
  reconnected, and its disconnects, stream items, room removals and access
  changes acted on production too. Every event now carries its deployment,
  and a node applies only its own's. Two deployments that keep the default
  prefix are still one, and a node of an earlier version sends untagged
  events, which every node applies: give each deployment its own prefix and
  adapter key, and upgrade every deployment that shares the Valkey.
- **No cache keeps a `/qd` or MCP reply (TRANSPORT-3).** A call's reply
  carried no `Cache-Control`, so a shared proxy or the browser's cache could
  keep one user's data. `/qd` and the MCP bridge's HTTP routes now say
  `no-store` and `nosniff`.
- **Logs hold no values a Prisma error rendered (CLIENT-5).** A Prisma
  error's message renders the failed call: the audit's create logged an
  email and a plaintext password. Under Prisma 7 its `meta` also carries
  the database's own text (`driverAdapterError`), which quotes the row
  ("Failing row contains (...)") or the value out of range. The console
  default also logged every call's user id at debug in production.
- **`quickdraw-skills link` stays inside the project (CLIENT-7).** Run by
  an app's `prepare` inside a dotfiles repo in the home directory, it
  linked its rules and skills into `~/.claude`, which every project reads.
- **The publish workflow pins its actions by SHA (SUPPLY-1).**
  `oven-sh/setup-bun@v2` ran by tag in the job that holds the npm
  publishing token; renovate now keeps every action pinned by digest.
- **`docs/deploying.md` has a production checklist (CLIENT-8,
  TRANSPORT-2)**, including per-address connection caps at the proxy, since
  every quickdraw limit is per socket, and Valkey as a trust boundary;
  `bearerOrIp`'s documentation says it keys by a token nothing has checked
  (TRANSPORT-4).
- **A browser the server signed out shows nothing of the last user
  (CLIENT-1).** After the server ended a session (signed out everywhere,
  revoked, expired), the client kept its hello and its cache, so the
  README's gate still showed the user signed in, with their data, on a
  shared machine. The client now forgets the hello, the grants and every
  quickdraw query, and fails the calls it buffered for a refused reconnect.
- **Presence no longer ships every socket's handshake between nodes
  (RT-5).** Behind a cluster adapter each join and each user's last leave
  read every node's sockets (`fetchSockets`): their handshake headers and
  cookies, auth and data, about 15.6 KB a socket, parsed by every node. The
  other nodes now answer with user ids (or whether they hold a socket of the
  user), and concurrent reads of one room or user share one request.

### Codemod

- **An inline `import("./x.js")` type in a 4.x method map now resolves from
  the contract.** A method map can write a payload or response type as
  `import("./ops-types.js").OpsConfigDTO` instead of importing it. The
  codemod copied that text into the contract unchanged, so the path named a
  file next to the contract that does not exist (TS2307; Conveyor's run had
  58 such lines). A relative specifier in such a type is now written from
  the contract file (`import("../types/ops-types.js").OpsConfigDTO`); a
  package name stays as it is. The type keeps its inline form.
- **Moved schemas are written under the names the contract binds.** A
  contract holds the schemas of every method module of its service, and the
  codemod printed each under its 4.x name: eleven of Conveyor's project
  modules each declare `const projectIdSchema = ...`, so its contract
  declared `projectIdSchema` 12 times (TS2451). Same-named schemas that are
  the same code (whatever their layout or comments, naming the same things)
  are now written once; any other is renamed `<name>Of<Module>`
  (`byTaskIdSchemaOfUpdateTask` for `update-task.ts`), wherever the contract
  uses it, with a note in its method's marker. A schema passed by an import
  or re-export alias (`export { deleteByIdSchema as deleteAchievementSchema }`)
  was moved but referenced by the alias, which the contract never declares
  (TS2304, on 7 of Conveyor's contracts); it is now written by its declared
  name. The summary line counts the merged and renamed schemas. An api
  schema that only a moved schema used is now removed with it, with the
  comment right above it.
- **The codemod's own tests check that every name and module of the
  contracts it writes binds**, review markers or not: a `todoSchema` line no
  longer hides an unresolved module or an undeclared name.

## [5.1.0] - 2026-10-10

Additions for migrating a large 4.x app, filed while planning Conveyor's
migration: declared principal kinds, access snapshots, argument binding for
MCP tools, a `describe` on every contract member with the docs and lint that
use it, 4.x clients that keep working across a service rename, and codemod
fixes for big apps (port-typed method modules, aggregator functions, test
subclasses, placeholder keys, reserved-word members, the formatter step and
the heap). A 4.x call through the legacy shim now sees the socket it arrived on.

### Principal kinds

- **`kinds` beside `access`** says which kinds of principal
  (`principal.kind`: a user, an agent's token, a runner) may call:
  `initQuickdraw({ kinds })` for every service the app defines,
  `defineService(contract, { kinds })` for one service, and a method's own
  `kinds`. Each level only narrows the one above it; a wider list, an empty
  one, or a method's own `kinds` on a `"public"` method is refused when the
  service is defined, and the types take only kinds of the app's principal
  (`PrincipalKindOf`). Nothing changes for an app that declares none.
- **Fail closed.** A principal of another kind, or without a `kind`, gets
  `FORBIDDEN` before the access form is asked, on every transport, outside
  the access engine: no grant passes it, a service-wide `Admin` grant
  included. An anonymous caller is left to the form, as before. A service's
  list also holds for `qd:sub`, `qd:col:sub`, `qd:watch` and
  `qd:stream:sub`, and its channels drop other kinds' messages.
- **Where kinds show.** `describeAccessMatrix` cells carry the principal's
  `kind`. `quickdraw-docs --services` prints "Callable by" in a method's
  facts and a "Principal kinds" row for the service, where a list is
  declared.
- **Lint's `no-inline-auth-guard`** also reports a check of
  `ctx.principal.kind` that throws in a handler (not one beside another
  condition with `&&`, nor one in a `"public"` method): declare `kinds`
  instead. A `custom` form that checks a claim, such as a token's `scope`,
  stays as it is.

### Testing

- **Access snapshots.** `snapshotAccessMatrix(app, { principals, reset, rows })`
  on `./testing` records who may call what: every method of the app's
  services (or of `services`), each entity subscribe (`qd:sub`) and each
  collection scope (`qd:col:sub`), as every principal and anonymously.
  The first run writes the outcomes to `__access__/<test file>.json` beside
  the test, and every later run compares its matrix with that file: a cell
  whose outcome changed fails, naming the method, its row variant, the
  principal and both outcomes, and whether the change opens or closes
  access, until `QD_UPDATE_ACCESS_SNAPSHOT=1` rewrites the file. Under CI a
  missing file and added or removed cells fail too, because a snapshot that
  writes itself pins nothing. `reset` (the app's `resetDatabase` and seed)
  runs again after every mutation access let through, so no cell sees the
  writes of another. Inputs are made from each method's input schema with
  the row where its access form reads it (`inputs(ref, fixture)` gives the
  others), and a cell without a valid input is recorded as `VALIDATION`,
  never called, and listed in the report's `inconclusive`. Each principal's
  `kind` is recorded beside the cells. `describeAccessMatrix` is unchanged.

### MCP bridge

- **`bind` fills tool arguments from the caller's principal.**
  `createMcpRegistry({ bind: { taskId: ({ principal }) => principal.claims?.taskId } })`
  leaves each bound argument out of the `inputSchema` of every method's tool
  whose object input has it, and fills it on every call (`tools/call` and
  both shapes of `POST /mcp/invoke`) before the input is validated, so an
  agent bound to one task cannot name another. A call fails closed before
  the method runs: `UNAUTHENTICATED` for an anonymous caller, `FORBIDDEN`
  when the binder returns `undefined` or `null` or when the agent sent
  another value, and `INTERNAL` (or the code of a `QuickdrawError` it threw)
  when the binder throws. `createMcpRegistry` throws at startup when a
  binder is not a function, when a bound argument is in no selected method's
  object input (a misspelled name), and when it is a property of an input
  that is not an object. Custom tools are never bound. Binding is not access
  control: the method's access must still confine the principal, who reaches
  it over a socket or HTTP with nothing bound. The README's MCP section also
  shows a tool set per kind of caller and frozen public tool names, built
  from the existing options.

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

### API docs: dependencies

- **`quickdraw-docs --services` says which services depend on which.**
  Each service page gets a "Depends on" section: the other services its
  declarations name, and how. The declarations are its row policy's
  `inherit` (inside `anyOf` too), `writes` (each model resolved to the
  service whose `model` it is), `affects`, `{ scope, of }` access forms on
  its methods, channels and streams, and its collections' anchors. The
  index adds a Mermaid `graph LR` of those edges. Nothing reads source: a
  handler's undeclared reads of another service's rows do not show.
  Regenerate your docs: `--check` with `--services` reports every page as
  out of date until you do.

### Legacy shim

- **Service-name aliases for 4.x clients.** `legacyWire` also takes
  `{ aliases: { taskService: "cardService" } }`: a 4.x client that still calls
  a renamed service by its old name (`taskService:get`) runs the new service's
  method, with its validation, access and `onCall`, instead of getting no
  reply. The legacy log names the alias once per old name, method and
  principal kind. Protocol-5, HTTP and MCP calls are never aliased, and
  `createServer` throws on an alias that names no service or shadows one.

### Fixed

- **A call through the 4.x legacy shim (`legacyWire`) sees the socket it
  arrived on.** Its handler gets `ctx.socketId`, and `ctx.rooms.join(room)`
  joins the 4.x client's socket instead of answering `false`, so an app can
  put an old client in a room and reach it with its own raw emits. The socket
  leaves its app rooms when it disconnects, and `onRoomLeave` and presence
  hear it. The shim still serves request/response calls only, and a
  contract's events still reach only protocol-5 sockets.

### Lint

- **`no-todo-schema` says when a placeholder input hides its keys from the
  id-reach check.** `defineService` refuses an input with `id` under an access
  form that checks no row (`"public"`, `"authenticated"`, `{ service: L }`
  below `Admin`), and reads the input's keys from its JSON Schema. A
  `todoSchema()` without `keys` names none, so the check cannot see an `id` in
  it. As the `input` of `query()` or `mutation()`, such a placeholder now gets
  a second message that says so and asks for `keys`; a
  `todoSchema<T>({ keys: ["id"] })` is checked like a Zod 4 schema. MIGRATION.md,
  the README and the access rule no longer say that every placeholder is
  unchecked.

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
- **The codemod needs less memory on a large app, and sizes its own heap.**
  It ran out of memory at Node's default heap on a 4,270-file app, and
  finished only with a 16 GB heap. It now asks the type checker about a
  4.x instance's members only in the files that import a service class's
  file, directly or through others (every file when a `declare global` or
  `declare module` among them could carry the class's type), so a web app
  that imports nothing from the api is no longer typechecked. It reads
  carve-out regions once, from the files that have a region marker, instead
  of walking every file once per service. It walks a web file's identifiers
  only when the file names a 4.x hook. On an app of more than 1,500 source
  files, the command starts itself again with a larger heap: three quarters
  of the memory it may use (the container's limit, else the machine's), at
  most 16384 MiB. It prints the size, and `--heap <MiB>` chooses another. A
  `--max-old-space-size` you pass to Node is kept, and Bun is left alone. A
  run the system kills (SIGKILL) is explained as running out of memory.
  `scripts/scale.mjs` (in `packages/codemod`, not run by CI) measures it on
  a generated app of 35 services and 3,100 files, where the smallest heap
  that completes falls from 3,584 MiB to 2,048 MiB, the peak memory (at an
  8,192 MiB heap) from 4,237 MiB to 2,360 MiB, and the run from 234 s to
  69 s, with byte-identical output.

- **Method modules that take a port of the service.** A method module whose
  parameter is typed as a port rather than the service class
  (`Pick<BaseService<..., ChatServiceMethods, ...>, "defineMethod" | ...> & { ... }`,
  an interface extending `Pick<ChatService, ...>`, a type parameter
  constrained to either) now gets its contract entries and typed method
  objects. The codemod reads the port from the source, since 5.0 has no
  `BaseService` for the type checker to resolve: the utility types `Pick`,
  `Omit`, `Partial`, `Readonly` and `Required`, `BaseService` and
  `BaseRpcService` by their method map, type aliases, interfaces, type
  parameters and intersections. Before, those methods were left out and
  listed as methods "no defineMethod call implements". The port type gets
  a `[this]` marker. A `defineMethod` call still tied to no service is named
  at its file and line in the contract's marker for the unimplemented
  methods, and the api files are scanned once for every service.
- **Aggregators go with the method modules they called.** A split service
  registers each method in a function of its own and calls those from an
  aggregator (`defineQueryMethods(service) { defineGetTarget(service); ... }`).
  The codemod turned the register functions into method objects but left
  each aggregator calling functions that no longer exist, unmarked: on one
  app, 320 calls in 68 files, each a typecheck error the report did not
  explain. An aggregator that only calls register functions, or other
  aggregators, is now removed with its calls (the service class's call
  already went with its constructor), and a file it leaves empty that
  nothing imports is deleted. One that does more (a condition, logging, a
  call of a function the run did not convert) stays under the
  register-leftover `[this]` marker, which names the calls the codemod
  removed from it, and a register function loses its calls of the others
  the same way. The summary counts the removed aggregators
  (`25 methods (2 aggregator functions removed)`).
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
- **Placeholder inputs list their keys.** For an input whose 4.x schema it
  cannot move, the codemod wrote `todoSchema<Payload>()` without keys, whose
  JSON Schema names none, so `defineService`'s rowless check could not see an
  `id` in it. It now writes `todoSchema<Payload>({ keys: [...] })` with the
  payload type's top-level keys (`{ keys: ["id"] }` for a payload with only
  `id`), and the check covers those methods as it covers a real schema. A
  payload type without keys (`Record<string, never>`, a primitive) keeps a
  placeholder without them. Output placeholders are unchanged. A `"Public"`
  method whose payload has `id` still gets `rowless: true`, marked, so the
  output boots.
- **One class per service name, chosen the same way every run:** the class
  `registerService("<name>", ...)` instantiates, else the one named after the
  service, else the first by file. Each other class is marked `[service]`.
- **A contract whose class implements none of its method map is not silent:**
  it is marked `[service]`, and the command names the service and the class
  it read on stderr. The report lists `[service]` items first, under
  "Services".
- **A member named after a reserved word gets a name that parses.** The
  codemod hoisted a 4.x `override delete` into `async function delete ()`,
  which TypeScript and oxfmt refuse. A member whose name is a JavaScript
  reserved word, or no identifier at all, is now hoisted as
  `<name>Of<Class>` (`deleteOfTaskService`), its `this.delete(...)` calls
  follow, and its marker says it was renamed.

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
