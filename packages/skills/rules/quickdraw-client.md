---
paths:
  - "apps/web/**"
  - "packages/shared/**"
---

# quickdraw 5.0: the typed client

> From `@fitzzero/quickdraw-skills` (`quickdraw-skills link`). `paths` follow
> the quickdraw template: the web app in `apps/web`, contracts in
> `packages/shared`. Another layout replaces this link with a copy and edits
> them.

## One client, one provider

```tsx
// apps/web/src/lib/quickdraw.ts: the keys of this map become qd.<key>
export const qd = createQuickdrawClient({ task, project });

// apps/web/src/providers/index.tsx, a "use client" module
export function Providers({ children }: { readonly children: React.ReactNode }) {
  return (
    <QuickdrawProvider client={qd} url={API_URL}>
      {children}
    </QuickdrawProvider>
  );
}
```

- `createQuickdrawClient` and `QuickdrawProvider` come from
  `@fitzzero/quickdraw-core/client`; the contracts from the shared package.
  Every member is typed from them: no wrapper hooks, no codegen. The
  template passes the shared `contracts` map, keyed by service name
  (`qd.taskService.board`); the examples here key theirs short (`qd.task`).
- `auth` is a token (sent as `auth.token`) or handshake fields; leave it out
  for cookie sessions. Changing it reconnects, and a hello naming another
  user empties everything quickdraw cached.
- `useQuickdraw()` gives
  `{ connection, status, isConnected, isKnown, reconnecting, userId, serviceAccess, hello, refusal, isRateLimited }`.
  Gate on `isKnown` (the server's hello named the user; `userId` is then
  final, `null` meaning signed out), never on `isConnected` or `userId`
  alone: `userId` is `null` before the hello too, `isConnected` turns true
  before it and false while reconnecting, and `reconnecting` keeps the user.
  `hello.serverId` changes when the server restarts (or the socket lands
  on another node): compare it to tell a new server from a network blip.
- Sign-in and out in the browser go through the auth routes kit's routes:
  `authProviders()` lists the sign-ins the API serves (render a button for
  those only, never from build-time flags), `signInUrl(provider, {
returnTo })` is the provider button's link, `signOut()` and
  `signOutEverywhere()` end the session (they reject when refused). Never
  call `/auth/...` by hand; 4.x's `getOAuthUrl`, `logout` and
  `logoutAllDevices` are gone.

## Reading

| Need                         | Use                                                                       |
| ---------------------------- | ------------------------------------------------------------------------- |
| one row, live                | `qd.task.useEntity(id)` → `{ data, isLoading, isRemoved, error }`         |
| several rows, live           | `qd.task.useEntities(ids)` → `{ data, byId, isLoading, error, errors }`   |
| a live list of one scope     | `qd.task.board.useCollection(projectId, { view, load: "all", limit })`    |
| anything else a method reads | `qd.task.stats.useQuery(input, options)` (TanStack's result)              |
| search as the user types     | `qd.task.search.useSearch(q, { scope, debounceMs })` (search kit methods) |
| a feed of appended items     | `qd.task.logs.useStream(taskId, { max })` → `{ items, isLoading, error }` |

- Prefer live data: `useEntity` and `useCollection` stay current from the
  server's frames, resume by revision after a reconnect, and cost no refetch.
- `useCollection` returns `items`, `index`, `byId`, `pending`,
  `totalCount`, `hasMore`, `isLoading`, `isLoadingMore`, `error`,
  `loadMore`, `loadItems`, `refresh`, `clamped` and `indexTruncated`.
  `view` names a view the contract declares (filtered on the client over
  the index); `load: "all"` keeps every page loaded. A `null` scope or id
  holds nothing; `enabled: false` subscribes to nothing.
- A query whose result follows writes declares `watch` in its contract; the
  client then joins that change topic and refetches when it changes.
- Errors are `QuickdrawError` instances: switch on `error.code`
  (`FORBIDDEN`, `NOT_FOUND`, `VALIDATION`, `RATE_LIMITED`, ...). A row that
  does not exist is `FORBIDDEN`, as one the user may not see (fail closed):
  a deleted row shows as `useEntity`'s `isRemoved` (the `r` frame) or leaves
  a collection while the page holds it; after a reload only `FORBIDDEN`
  is left, so word it "not found or not shared with you".

## Writing

```tsx
const rename = qd.task.rename.useMutation();
rename.mutate({ id, title }); // returns nothing: never await it
await rename.mutateAsync({ id, title }); // resolves with the output, rejects with QuickdrawError
```

- A mutation whose input has `id` and whose output is `"entity"` is
  optimistic by default: its input's fields show over the cached row and its
  collection items at once, are dropped if the call fails, and give way to
  the server's frame. `useMutation({ optimistic: false })` turns that off;
  `optimistic: (input, cache) => cache.patchEntity(input.id, { ... })`
  (`removeEntity(id)`, `patchItem(collection, id, fields)`) writes your own.
- A create (sending a message, adding a card) shows at once with
  `optimistic: (input, cache) => cache.addItem(collection, scope, item)`
  (give the item the collection's `order` fields; `addEntity(row)` for
  collections of entity rows): it shows in its place, `useCollection`'s
  `pending.has(item.id)` is true while the call is in flight, a refusal
  removes it, and the server's own item replaces it without a gap or a
  copy. Never render a mutation's `variables` as a fake row instead. To
  offer "retry" on a failed send, add it with `{ onRefused: "keep" }`: a
  refused item moves to `useCollection().refused` (`item`, `error`,
  `dismiss()`, `retry()`), never kept by hand. Give such an item an id the
  client makes and the server keeps (`newId()` from
  `@fitzzero/quickdraw-core/client` in the input, written by the create;
  not `crypto.randomUUID()`, which browsers give only to https and
  localhost pages, so a dev server opened at its LAN address would throw):
  after a dropped connection or a timeout the server may have written it
  (`useCollection().checking` names it until the scope's next load says),
  and only that id lets the load find it and makes `retry()` safe, since
  the second call fails `CONFLICT` instead of writing twice.
- Never refetch or invalidate after a mutation by hand: the frames update
  live rows and collections, and watched queries refetch themselves. For
  anything else use `qd.invalidate(qd.task.stats, input?)`, never
  `queryClient.invalidateQueries` on a quickdraw key.
- Fire a mutation from an event handler, never from render or from an
  effect that its own result runs again: that loops, and every round
  writes. In development the client warns
  `[quickdraw:repeated-mutation]` (one `useMutation` issuing more than 5
  within a second, naming its component) and
  `[quickdraw:repeated-invalidation]` (`qd.invalidate` asking for one query
  key more than 20 times within a second; a busy watched topic is not
  counted, the coordinator coalesces it), and the server
  `[quickdraw:repeated-call]`.
  An effect that must mutate runs once per change: give it the inputs as
  dependencies and compare them with what it last sent.
- Outside React, through the mounted provider's connection:
  `qd.task.get.call(input)`, `qd.task.rename.call(input)`,
  `qd.task.get.prefetch(queryClient, input)`; `qd.task.get.key(input)` is
  the cache key, `["qd", "taskService", "m", "get", input]`.

## Realtime

- Channels: `const { send, isReady } = qd.task.cursor.useChannel();` sends
  fire-and-forget messages (dropped over the channel's rate). A channel that
  `requires` a room takes messages only from a socket a method joined to it:
  the client that sends must make the joining call itself.
- Events: `qd.task.cursorMoved.useEvent((payload) => ...)` hears the
  contract's events sent to a room the socket is in. An event that carries
  a query's new result writes it into the cache with
  `qd.task.members.setData(input, updater)` instead of a refetch or a copy
  in React state.
- Presence: `usePresence(room)` returns the user ids in an app room, after a
  method joined the socket to it (`ctx.rooms.join`).
- Joining a room: `useJoin(qd.task.enterBoard, { projectId })` runs the
  joining call on every connection (a reconnect is a new socket in no room)
  and when the input changes, never on a re-render, with `status`,
  `isJoined`, `data`, `error` and `retry()` (a refused join, tried again on
  the user's say). Never join from a plain `useQuery` or a
  mount effect: a reconnect leaves the socket out of the room while the
  cached answer still looks fine. Without React, `connection.onHello`.
- Admin screens: `qd.task.admin.adminList.useQuery(input)` and the other
  admin kit members; `useAdminServices(qd)` lists the services whose
  `adminMeta` answers the user, asking only those the hello's grants allow
  (`Admin`; `{ requires: "Moderate" }` or `null` when the service opened
  `adminMeta` wider). A screen served from metadata for every service takes
  `adminOf(qd, key)`, one shape typed by field name: never cast
  `qd[key].admin`. The kit's rows are not live: after the screen's own
  write, `onSuccess: () => qd.invalidate(qd.task.admin.adminList)`. A
  generic form shows the fields whose `showInForm` is not `false`; a user's
  grants field says `kind: "grants"`: find it by that, never by its name.

## Server components and other runtimes

- A React server component or route handler cannot call `./client` (it
  starts with `"use client"`): use
  `createServerCaller(contracts, { url, headers })` from
  `@fitzzero/quickdraw-core/utils`, whose
  `caller.task.get.prefetch(queryClient, input)` fills the keys the hooks
  read, for `dehydrate` and `HydrationBoundary`.
- React Native uses the same client and provider (no DOM is needed).
  React-free code (a Node script, a worker) makes a connection with
  `createQuickdrawConnection({ url, auth })`, calls `open()`, and calls
  `callData(connection, { service: "taskService", method: "get", input })`
  from `./client`; `liveDataOf(connection, queryClient)` holds live rows.
- A client in another language (a Godot game, a native app) speaks the wire
  itself: `docs/protocol-v5.md` in the quickdraw repository is the
  specification, `examples/godot` a GDScript client written from it, and
  `docs/clients.md` compares the ways in.

## Do not

- Do not use the socket (`socket.emit`, `socket.on`) or hand-written
  TanStack hooks around quickdraw calls; go through `qd.<service>`. For a
  hook the typed client has none of (infinite scroll over `list` with
  `useInfiniteQuery`, `useSuspenseQuery`, `useQueries`, `queryOptions`), key
  it with the member's `key(input)` (a suffix may follow it) and fetch with
  its `call(input)`.
- Do not copy server data into React state to keep it current: read it from
  the hooks, which share one cache.
- The lint rules `no-raw-socket`, `no-untyped-client`, `no-manual-refetch`
  and `no-await-void-mutate` report these.
