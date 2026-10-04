# Deploying quickdraw

How to run a quickdraw 5.0 server as several processes (Cloud Run instances,
Kubernetes pods) behind one Valkey, what stays correct across them, what it
costs, and what happens when Valkey stops answering. The behavior described
here is proved by the cluster test projects (`bun run test:cluster` in
`packages/core`, CI's `cluster` job): the end-to-end suite and the realtime,
collection and revocation tests run with every test app booted as two servers
behind a real Valkey, readers on one node and writers on the other, plus the
cluster's own tests in `packages/core/test/cluster/`.

## Several nodes behind Valkey

A node is one `createServer` process. The nodes share the database and a
Valkey (or Redis) that the Socket.IO Redis adapter runs on. Wire it with the
helper on `./server`, after creating the server:

```ts
import { setupRedisAdapter } from "@fitzzero/quickdraw-core/server";

const server = qd.createServer({ app, services, db, auth });
const redis = await setupRedisAdapter(server.io, {
  host: env.VALKEY_HOST,
  port: env.VALKEY_PORT,
  keyPrefix: "myapp",
});

process.on("SIGTERM", async () => {
  await server.close();
  await redis.cleanup();
});
```

or pass `createAdapter(pub, sub)` from `@socket.io/redis-adapter` as
`socket.adapter` to `createServer`. Either way the server finds the adapter's
publishing client and keeps two kinds of keys there:

| Key                         | What                                                                      |
| --------------------------- | ------------------------------------------------------------------------- |
| `{keyPrefix}:rev`           | The shared revision counter every node's flushes take their revision from |
| `{keyPrefix}:seen:{userId}` | When a user's last socket on any node disconnected, kept for 30 days      |

`createServer`'s `cluster` option configures them (the adapter's own
`keyPrefix` names its pub/sub channels, not these keys):

| Option      | Default                               | Meaning                                                                                      |
| ----------- | ------------------------------------- | -------------------------------------------------------------------------------------------- |
| `client`    | the Redis adapter's publishing client | A node-redis (4 to 6) or ioredis client for the counter and last-seen times                  |
| `keyPrefix` | `"quickdraw"`                         | The prefix of the keys above                                                                 |
| `timeoutMs` | 1,000                                 | How long a node waits on Valkey or on the other nodes before it goes on without them (below) |

Behind another adapter (one whose client the server cannot reach, and no
`cluster.client`), revisions stay per process and the guarantees below about
the counter do not hold.

The Valkey must allow `EVAL`/`EVALSHA` with `TIME`, `GET`, `SET`, `INCRBY`
and pub/sub. Use a single-shard instance (cluster mode disabled) or give
`cluster.client` a client that routes the counter's key, and an eviction
policy that never evicts keys without a TTL (`noeviction` or a `volatile-*`
policy; Memorystore's default `volatile-lru` is fine): the counter has none.

The counter's key must also outlive a Valkey restart or failover: turn on
persistence (RDB or AOF) or replication with automatic failover (Memorystore
for Valkey with a replica). Without it the key is lost with the instance,
and the next flush starts it again at Valkey's clock, above that node's last
revision. Since the counter keeps to the clock, that is above every revision
issued before unless Valkey's clock stepped back (a failover to a replica
whose clock runs behind); a node that had seen the key logs "The revision
counter key was lost; configure persistence or replication for it", and a
read made before the next flush claims its own clock. A subscribe running
while the key is lost may miss the frames of a flush made in between until
the row's next change.

## What holds across nodes

- **One order of revisions.** Each flush takes its revision from the shared
  counter, in one round trip, before it reads any row (RFC 0003 section 5.3).
  Revisions from all nodes are one total order: a flush that starts after
  another one took its revision gets a greater one, whichever node runs it.
  A revision is a whole number of microseconds since the epoch (on one
  server too: `max(Date.now() * 1000, last + 1)`), and the counter moves to
  `max(last + 1, Valkey's time in microseconds, the node's last revision +
1)`: it runs ahead of Valkey's clock only above a million flushes a second
  across the cluster, so revisions stay comparable with `versionColumn`
  times (a time's milliseconds times 1,000) and with the clock a node falls
  back to.
- **Frames applied by revision, never losing a field.** Each process sends
  its flushes' frames in revision order, but frames from two nodes can reach a
  client out of order. Clients apply frames by revision, and behind a cluster
  adapter a node sends changes whole (`u` and `updated` where one server sends
  `p` and `patched`), so a frame dropped as older never takes a field with it.
  A subscriber tier that would have got an empty patch still gets nothing.
- **Frames decided at the read.** A flush takes its revision when it flushes,
  after its handler settled, so a write that committed first can flush last
  with the higher revision. Behind a cluster adapter every frame is decided by
  its row as read at flush time, after the revision was taken: a move out of a
  scope that flushes after a later move back in sends the row `updated` to the
  scope it is in again, and a delete that flushes after a later create of the
  same id sends the row (`u`), not its removal. One server keeps its cheaper
  rule, so there the newer write's frame can still lose to the older one's
  until the row's next write.
- **Reads no older than what a client holds.** A read that claims a revision
  (a subscription's rows, a collection page, `qd:col:items`, a search page, a
  row sent again after a level change) claims the counter's last revision, so
  a client holding a newer frame from another node takes the answer. A
  subscribe whose rows another node changed before it joined their rooms reads
  them again.
- **Access everywhere first.** Access changes and reloaded grants are
  broadcast to every node and answered once the node has resolved its
  subscriptions again; the flushing node sends the flush's frames only after
  every node answered. A broadcast carries the changed row's state, so a
  deleted row's subscribers on any node get its removal, and a row created
  again with a deleted row's id is authorized again before its first frame.
  The wait is bounded and fails open: see "When a node stops answering".
- **Users and rooms.** `server.access.disconnectUser` (logout everywhere),
  `access.refresh`, presence (`isOnline`, `users`, `count`, `lastSeen`), app
  rooms and typed events work across nodes. A channel's
  `requires: { room }` is checked on the node the sending socket is
  connected to, against the app rooms that socket joined: a socket's rooms
  live on its node and only a call over the socket joins it, so the check
  holds with no round trip (a room the user joined from a socket on another
  node does not count, by design).
- **Stream seeds.** A push to a stream that keeps a `seed` goes to every node
  (one publish, as a room broadcast costs), and each node keeps the seed and
  sends the items to its own subscribers: a subscriber on any node starts with
  the latest items, and never gets an item twice.
- **Collections.** A removal a write cannot address to a scope (a
  `ctx.touch(..., { removed: true })`, junction rows a cascade removed) is
  broadcast, so every node's subscribed scopes get it.

## What it costs

Behind a cluster adapter, measured by the cluster budgets
(`packages/core/test/e2e/__budgets__/budgets.cluster.ts.json`: both nodes'
statements and bytes) and the split end-to-end suite:

- every flush: one Valkey round trip (the counter script) before its first
  read;
- every subscription read: one `GET`, two for `qd:sub` and `qd:col:sub`
  (before the read, and after the join), and a second read of its rows when
  any node took a revision meanwhile;
- a node reads every touched row and scope for its frames, since other nodes'
  rooms are invisible to it: "one update with one subscriber" costs 9
  statements on two nodes against 8 on one; deleted rows and rows that left
  a collection are read too (one statement per service and collection of a
  flush that only removes);
- changes go out whole: that step sends 400 bytes against 268;
- a flush that changes access waits for every node's answer: a few Valkey
  round trips and the slowest node's re-resolution, at most
  `cluster.timeoutMs`. The wait is in line with the node's flushes, which run
  one after another: every flush behind it waits too;
- a collection resume (`qd:col:sub` with `since`) always reads a page, and
  "not modified" comes from `versionColumn` only: a process's change log and
  delta buffer see its own flushes.

## When a node stops answering

A node that stays subscribed in Valkey but does not answer (a frozen or
CPU-starved instance, one killed before Valkey dropped its connection, a
version that does not know the event) would put `cluster.timeoutMs` on every
flush of the other nodes that changes access, and on every flush behind it.
So the first broadcast a node does not answer in time puts the flushing node in a
degraded mode, logged once at error ("A node did not answer a broadcast in
time; this node sends access changes without waiting for the other nodes
until every node answers a probe"): its access changes and reloaded grants
go out without waiting, and it broadcasts a probe every second until every
node answers one, which ends the mode (logged once at info, "Every node
answers broadcasts again; access changes wait for them again").

Not waiting is the same trade-off a timed-out wait makes: the flush's frames
go out, and a node that has not applied the change yet still has the sockets
it revoked in their rooms, so they can receive frames the change should have
kept from them (a field above their new level, a row they lost) until that
node applies it. Live frames are fail-open across nodes for that long; calls
and subscription reads are always authorized on the node that serves them.

## When Valkey stops answering

- **Frames.** A node's frames to its own sockets go out at once: while its
  connection to Valkey is down, no step of a flush waits on Valkey (the
  counter and the access broadcasts skip it). The adapter cannot reach the
  other nodes meanwhile: what a node publishes waits in its client's queue.
- **Revisions.** A node takes revisions from its own clock in microseconds,
  never below one it issued, and logs one error per outage ("The shared
  revision counter did not answer; this node takes revisions from its own
  clock until it does"). Its reads claim the clock too, never a revision
  older than it (`max(now, its last revision)`). While degraded no flush or
  read sends a counter command or waits for one: once a second, while the
  client is connected, one `GET` goes out in the background, and the first
  that answers ends the outage ("The shared revision counter answers
  again"). A Valkey that stops answering without the connection closing
  costs one `cluster.timeoutMs` wait, on the flush that finds out. Until the
  counter answers, the node's revisions compare with other nodes' within the
  skew between its clock and Valkey's.
- **Access and presence.** While the node's connection is down, its access
  changes are broadcast without waiting (they wait in the client's queue);
  presence across nodes waits on `fetchSockets` up to the adapter's
  `requestsTimeout`; `lastSeen` answers from the node's own records.

## Cloud Run

- **WebSocket only, or session affinity.** Connect clients with
  `transports: ["websocket"]`; long polling sends a client's requests to
  whichever instance, so it needs the service's session affinity.
- **Connection lifetime.** Cloud Run ends a request, a WebSocket included, at
  the service's request timeout (at most 60 minutes). Call
  `server.rotate({ withinMs })` before it, for example every 50 minutes with a
  window of a few minutes: clients reconnect spread over the window instead of
  all at once, and resume by revision.
- **CPU between requests.** Sockets and flushes run outside requests: use
  instance-based billing (CPU always allocated) and keep a minimum instance.
- **Memorystore for Valkey.** Reach it over Direct VPC egress or a connector,
  on a single-shard instance (or `cluster.client`, above).
- **Observability.** Turn on `stallWatchdog: true` and
  `onCall: otelOnCall(...)` (README, "Observability"): a node whose event loop
  stalls delays every node's access changes.
- **Shutdown.** On `SIGTERM`, `await server.close()` (it waits for calls,
  flushes and the presence work its sockets' last events started), then close
  the Valkey clients (`redis.cleanup()`).

## Gaps that remain

- Frames of one row from two nodes still arrive out of revision order;
  sending changes whole makes that safe at a cost in bytes. Per-field
  revisions on the client would allow patches again.
- A degraded node (Valkey not answering) orders revisions by its own clock,
  which agrees with the counter only within the clocks' skew.
- A room's presence list read from the other nodes can race a `joined` or
  `left` another node sends meanwhile (this node's own joins are counted).
- A subscribe that sees the counter move reads every row it joined again, not
  only the ones that changed: the cluster has no shared change log.
- The two nodes of the test projects run in one process: state kept per
  module (the process clock of `rev.ts`) is shared by them there, unlike in a
  real deployment; the counter's own tests run each node's counter apart.
