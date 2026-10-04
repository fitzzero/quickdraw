# Clients

Three ways to talk to a quickdraw 5.0 server, from the most the framework
does for you to the least. All three reach the same services through the
same access checks; they differ in what the client side takes care of.

| Way in                          | For                                            | Typed from the contracts |
| ------------------------------- | ---------------------------------------------- | ------------------------ |
| The typed client and its hooks  | React and React Native apps                    | yes                      |
| The React-free connection       | Node scripts, workers, tests, non-React code   | by service and method    |
| The wire, from `protocol-v5.md` | any other language: a Godot game, a native app | no                       |

## 1. The typed client

`createQuickdrawClient(contracts)` and `<QuickdrawProvider client url auth>`
from `@fitzzero/quickdraw-core/client`: one member per method, collection,
stream, channel and event of each service (`qd.task.get.useQuery(input)`,
`qd.task.useEntity(id)`, `qd.task.byProject.useCollection(scope)`,
`qd.task.logs.useStream(scope)`, `qd.task.cursor.useChannel()`,
`qd.task.cursorMoved.useEvent(handler)`, `usePresence(room)`), with
TanStack Query's cache, an invalidation coordinator, optimistic mutations,
resume by revision after a reconnect and rate-limit backoff. The README's
"The client" section shows it, and the `quickdraw-client` agent rule lists
what to do and what not to.

## 2. The React-free connection

`createQuickdrawConnection({ url, auth })` from the same entry, with
`call` and `callData` for calls and `liveDataOf(connection, queryClient)` for
live rows and collections: the same handshake, backoff and reconnect as the
hooks, without React. A React server component calls over HTTP instead,
with `createServerCaller(contracts, { url, headers })` from
`@fitzzero/quickdraw-core/utils`. The README's "Server components and other
runtimes" section shows both.

## 3. The wire

[`protocol-v5.md`](protocol-v5.md) is the wire's specification: Socket.IO
4 over a WebSocket, JSON only, written so that a client needs no Socket.IO
library. It is generated from `packages/core/src/protocol/envelope.ts` and
the sources beside it, so it always describes the server you run.

A client implements, roughly in the order a game needs it:

1. the framing and the handshake (`auth.qd`, `qd:hello`), and answering
   pings;
2. `qd:call` with an ack id, reading `{ ok: true, d }` or
   `{ ok: false, e: { code, message, data? } }`, and backing off on
   `RATE_LIMITED` for `retryAfterMs`;
3. `qd:ch` sends (fire and forget, never awaited), and the `qd:event` and
   `qd:presence` frames;
4. streams (`qd:stream:sub`, `qd:stream`), subscribing again after a
   reconnect;
5. only for live rows: entity and collection subscriptions (`qd:sub`,
   `qd:col:sub`, `qd:e`, `qd:c`), applied by revision.

[`examples/godot`](../examples/godot) is such a client for Godot 4: one
GDScript file of a few hundred lines, an autoload with signals for events,
stream items and presence. CI runs it in Godot against a real server, and a
Node test writes the same frames byte for byte.

For calls alone a socket is not needed: the HTTP transport answers
`POST /qd/{service}/{method}` with the input as a JSON body (sent with
`Content-Type: application/json`, a bearer token or the session cookie) in
the same `{ ok, d }` or `{ ok: false, e }` shape, with the error code's HTTP
status.

## Rooms for games and lobbies

A lobby, a match or a game's world is an app room: a method puts the
socket that called it in the room with `ctx.rooms.join(room)`, the room's
sockets receive its typed events (`ctx.rooms.emit`) and `qd:presence`
frames, and a channel declares that only a socket in the room may send on
it:

```ts
channels: {
  // one world: the room's own name
  move: { payload: moveSchema, requires: { room: "world" } },
  // many lobbies: the room computed from the payload
  chat: { payload: chatSchema, requires: { room: (message) => `lobby:${message.lobbyId}` } },
},
```

The requirement is the sending socket's own, checked in memory on the node
the socket is connected to, so it holds behind a cluster with no round trip:

- A room another socket of the same user joined does not count. A player
  whose page and game client are two sockets makes the joining call from
  the client that sends.
- A reconnected socket is in no room: the client calls the joining method
  again when it reconnects (the GDScript client's `connected` signal fires
  then).
- Leaving the room (`ctx.rooms.leave`), being taken out of it
  (`rooms.leave(room, { userId })`) or disconnecting ends it for the next
  message.
- A string is the room's name, never a payload key (unlike `{ entity }`); a
  name starting with `qd:` or `user:` is refused when the contract is
  defined, and a computed one drops the message.

The server side of a game needs no handler to reach the room:

- The loop sends with `qd.rooms.emit(room, contract, event, payload)` (and
  `emitToUser`), from a timer or a tick, to every node's sockets in the
  room; a stream (`qd.stream(...).push`, `volatile`) carries what may be
  dropped under load, such as snapshots.
- `qd.rooms.leave(room, { userId })` (or `ctx.rooms.leave` in a handler)
  takes every socket of a player out, on every node. Each of them receives
  `qd:presence { room, users: [] }` unasked, which a client reads as "out
  of the room": it stops sending on the room's channels until a joining
  call lets it back.
- `createServer({ onRoomLeave })` hears every socket that leaves (its own
  leave, a removal, a disconnect) once, with each room and `last`: true when
  the player has no socket left in the room on any node, the moment to
  send `playerLeft`. A socket that reconnects after `qd:rotate` is a new
  socket; the old one's disconnect is the player's last only when they had
  no other.
