# GDScript client for quickdraw protocol v5

A quickdraw 5.0 client for Godot 4 in one file,
[`addons/quickdraw/quickdraw_client.gd`](addons/quickdraw/quickdraw_client.gd),
written from the wire's specification,
[`docs/protocol-v5.md`](../../docs/protocol-v5.md): Socket.IO over Godot's
`WebSocketPeer`, JSON only, no Socket.IO library. This directory is an
example in the quickdraw repository and is never published; copy the file
into your game.

## Use it

Register the script as an autoload (Project Settings > Globals > Autoload,
`res://addons/quickdraw/quickdraw_client.gd` named `Quickdraw`, as this
project's `project.godot` does), or add it as a child node, then:

```gdscript
func _ready() -> void:
	Quickdraw.connected.connect(_on_connected)
	Quickdraw.event_received.connect(_on_event)
	Quickdraw.connect_to("https://api.example.com", {"token": token})


func _on_connected(hello: Dictionary) -> void:
	# Again after every reconnect: the new socket is in no room until it joins.
	var reply := await Quickdraw.call_method("gameService", "join", {"name": "ada"})
	if reply.ok:
		Quickdraw.send_channel("gameService", "move", {"dx": 1, "dy": 0})


func _on_event(service: String, event: String, payload: Variant) -> void:
	if event == "moved":
		print(payload.userId, " moved")
```

| Member                                            | What it does                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect_to(url, options)`                        | Connects. `token` is sent as `auth.token`; `auth` adds keys; `path` (default `/socket.io`); `headers` for the handshake (a `Cookie` on desktop); `reconnect` (default on).            |
| `call_method(service, method, input, version)`    | Awaits the acknowledgement: `{ok: true, d}`, `{ok: true, nm: true, v}` or `{ok: false, e: {code, message, data?}}`.                                                                   |
| `start_call(...)`, `reply(id)`, `cancel_call(id)` | A call in two steps, so it can be cancelled (`qd:cancel`; the answer is `CANCELLED`). An answer `reply` has not taken yet is kept for 60 s (at most 256 of them).                     |
| `send_channel(service, channel, payload)`         | Fire and forget: never acknowledged, never awaited. Returns false when dropped here (not connected, or the connection backed up).                                                     |
| `subscribe_stream(service, stream, scope)`        | Awaits the seed; items then arrive as `stream_item`. Subscribed again after each reconnect. A refusal on a live connection holds no feed.                                             |
| `unsubscribe_stream(service, stream, scope)`      | Leaves the feed.                                                                                                                                                                      |
| `is_subscribed(service, stream, scope)`           | True while the client holds the feed (it subscribes again after each reconnect), false after a refused subscribe: ask it before `subscribe_stream` to send no second `qd:stream:sub`. |
| `on_event(service, event, callback)`              | Calls `callback(payload)` for each `qd:event` of that service and name.                                                                                                               |
| `off_event(service, event, callback)`             | Stops calling `callback` for that event; false when it was not registered.                                                                                                            |
| `presence(room)`                                  | The users in an app room the socket is in.                                                                                                                                            |
| `request(event, payload)`                         | Any other acknowledged event of the protocol (`qd:sub`, `qd:watch`, ...), paced by the hello's subscription lane.                                                                     |
| `peer_link(room, to, offerer, options)`           | Opens a link to socket `to` in app room `room` (below). Exactly one side offers. `relay`: `"auto"` (default), `"always"` or `"never"`; `ice_servers`.                                 |
| `reject_peer(room, from)`                         | Refuses a link `peer_requested` asked for: the peer's link closes with `"bye"`.                                                                                                       |
| `socket_id`                                       | This socket's id, from the server's CONNECT: what a peer links to.                                                                                                                    |
| `close()`                                         | Disconnects for good.                                                                                                                                                                 |
| `rng`                                             | The `RandomNumberGenerator` behind the client's random waits (reconnect backoff, the `qd:rotate` moment); seed it to repeat a run.                                                    |
| `server_id`                                       | The hello's `serverId`: new each time a server starts. Another one after a reconnect means a restarted server (or another node): a game's world and ticks start over.                 |

Signals: `connected(hello)`, `disconnected(reason)`, `refused(code, message)`
(`PROTOCOL_MISMATCH` or `UNAUTHENTICATED`; it does not reconnect),
`rotating(within_ms)` (`qd:rotate`: the socket stays open until the client's
moment within the window),
`event_received(service, event, payload)`,
`stream_item(service, stream, scope, item)`,
`stream_seeded(service, stream, scope, seed)`, `presence_changed(room, users)`,
`revoked(frame)` (also for a held feed the server refuses after a
reconnect: `reason` `"refused"`, with its `error`),
`access_changed(service_access)`,
`peer_requested(room, from, user_id)` (a socket of a room this one is in
signalled it with no link: answer with `peer_link(room, from, false)` within
15 s, or `reject_peer`), and
`frame_received(event, data)` for the frames it does not route (`qd:e`,
`qd:c`, `qd:changed`). `trace = true` prints every frame.

### Peer links

On a server created with `peers: true` (its hello lists `"peer"`), two
players of one app room can link: WebRTC data channels where Godot has them
(a web export, or a native build with the
[webrtc GDExtension](https://github.com/godotengine/webrtc-native)), and the
server's relay otherwise, with the same messages either way
([`docs/protocol-v5.md`](../../docs/protocol-v5.md), "Peer links"). A headless
or native build without the extension runs every link on the relay; so does
a link whose direct path fails. A link lives as long as the socket it started
on: open it again in `connected`.

```gdscript
func _on_peer_requested(room: String, from: String, user_id: String) -> void:
	var link: QuickdrawClient.PeerLink = Quickdraw.peer_link(room, from, false)
	link.message.connect(func(label: String, data: Variant) -> void: print(user_id, ": ", data))
	link.opened.connect(func(_path: String) -> void: link.send("rel", {"hello": user_id}))
```

A `PeerLink` has `send(label, data)` (`"rel"`, ordered and reliable, or
`"fast"`, unordered and never retransmitted; `data` any JSON value; false
when dropped), `close()`, `state` (`"connecting"`, `"open"`, `"closed"`),
`path` (`"direct"` or `"relay"`), `close_reason`, `room`, `peer` (the peer's
socket id), `user_id` (the peer's user, as the server named it), `sent`,
`received` and `dropped`, and a clock read from pings on `fast`:
`clock_now()` (the peer's clock in its milliseconds), `clock_offset`, `rtt`,
`jitter` and `synced`. Its signals are `opened(path)`,
`message(label, data)`, `state_changed(state, path)` and `closed(reason)`.
The server forwards a link's signals and relays its messages only between
two players of the room, but what the peer sends is the peer's word: a game
checks it as it would check any input.

What it does for you, as `docs/protocol-v5.md` asks of a client:

- answers the server's pings, and treats a silent server as gone;
- reconnects after a dropped connection, after a random wait of up to 1 s
  that doubles up to 15 s (full jitter); on `qd:rotate` it keeps the socket,
  calls still answered, until a random moment within the window, then
  reconnects with a fresh handshake; it does not reconnect after the server
  ended the socket or refused the handshake;
- waits for a call's acknowledgement at most the hello's `callTimeoutMs`
  and 2 s more, and fails calls in flight with `INTERNAL` when the
  connection drops;
- after a `RATE_LIMITED` answer, refuses the same kind of work itself, with
  no frame, for `retryAfterMs` and up to half again (5 s without one);
- keeps subscription events within the hello's `subscriptions.maxInFlight`;
- reads a reply as large as the server's default `maxResponseBytes` (1 MiB)
  with its envelope: frames waiting to be read may hold 2 MiB.

Numbers in replies and frames arrive as floats (Godot's JSON); compare
with `int(...)`.

## The server side

[`test/game.ts`](test/game.ts) is the service the client is checked
against, written as a game would: `join` puts the calling socket in the
world's app room, the `move` channel declares `requires: { room: WORLD }`
so only a socket in the world may send on it, and its handler sends the
`moved` event to the world and pushes to the seeded `ticks` stream. The
server serves peer links (`peers: true`), so two players of the world can
link. Rooms
are per socket: a page and a game client of one player are two sockets,
and the one that sends must make the joining call
([`docs/clients.md`](../../docs/clients.md), "Rooms for games and lobbies").

## Checks

- `bun run test` (from the repository root, or here once the core package
  is built): [`test/wire.test.ts`](test/wire.test.ts) writes the frames the
  client writes, byte for byte ([`test/frames.ts`](test/frames.ts)), to a
  real server over a raw WebSocket and checks every answer, then what the
  session does not reach: a refused protocol, the heartbeat, presence and
  events between two players, channels never acknowledged, and a peer link
  over the relay between two players, with its refusal from outside the
  room.
- `bun run check:godot` (after `bun run build` at the root; Godot 4 as
  `godot` on the PATH, or `GODOT=/path/to/Godot_v4.7.2-stable_linux.x86_64`):
  [`test/godot.ts`](test/godot.ts) starts the game server and runs the
  client headless in Godot through [`test/smoke.gd`](test/smoke.gd), whose
  peer link it answers as the player "bo" offering one over the relay. It
  passes when the script's checks hold and the client wrote exactly the
  frames of `test/frames.ts`, its link's clock pings aside. CI's `godot` job runs it with the official
  Godot 4.7.2 build, on every push and on a pull request that touches the
  client, the wire's code or `docs/protocol-v5.md`.

To watch a session, run the script against a server of your own that
serves `test/game.ts`'s service:
`QD_URL=http://localhost:4000 QD_TRACE=1 godot --headless --path examples/godot --script res://test/smoke.gd`.
