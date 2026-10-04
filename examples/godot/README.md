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

| Member                                            | What it does                                                                                                                                                               |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connect_to(url, options)`                        | Connects. `token` is sent as `auth.token`; `auth` adds keys; `path` (default `/socket.io`); `headers` for the handshake (a `Cookie` on desktop); `reconnect` (default on). |
| `call_method(service, method, input, version)`    | Awaits the acknowledgement: `{ok: true, d}`, `{ok: true, nm: true, v}` or `{ok: false, e: {code, message, data?}}`.                                                        |
| `start_call(...)`, `reply(id)`, `cancel_call(id)` | A call in two steps, so it can be cancelled (`qd:cancel`; the answer is `CANCELLED`).                                                                                      |
| `send_channel(service, channel, payload)`         | Fire and forget: never acknowledged, never awaited. Returns false when dropped here (not connected, or the connection backed up).                                          |
| `subscribe_stream(service, stream, scope)`        | Awaits the seed; items then arrive as `stream_item`. Subscribed again after each reconnect.                                                                                |
| `unsubscribe_stream(service, stream, scope)`      | Leaves the feed.                                                                                                                                                           |
| `on_event(service, event, callback)`              | Calls `callback(payload)` for each `qd:event` of that service and name.                                                                                                    |
| `presence(room)`                                  | The users in an app room the socket is in.                                                                                                                                 |
| `request(event, payload)`                         | Any other acknowledged event of the protocol (`qd:sub`, `qd:watch`, ...), paced by the hello's subscription lane.                                                          |
| `close()`                                         | Disconnects for good.                                                                                                                                                      |

Signals: `connected(hello)`, `disconnected(reason)`, `refused(code, message)`
(`PROTOCOL_MISMATCH` or `UNAUTHENTICATED`; it does not reconnect),
`event_received(service, event, payload)`,
`stream_item(service, stream, scope, item)`,
`stream_seeded(service, stream, scope, seed)`, `presence_changed(room, users)`,
`revoked(frame)`, `access_changed(service_access)`, and
`frame_received(event, data)` for the frames it does not route (`qd:e`,
`qd:c`, `qd:changed`). `trace = true` prints every frame.

What it does for you, as `docs/protocol-v5.md` asks of a client:

- answers the server's pings, and treats a silent server as gone;
- reconnects after a dropped connection (1 s, doubling to 15 s, with
  jitter) and at a random moment within a `qd:rotate` window, with a fresh
  handshake; it does not reconnect after the server ended the socket or
  refused the handshake;
- waits for a call's acknowledgement at most the hello's `callTimeoutMs`
  and 2 s more, and fails calls in flight with `INTERNAL` when the
  connection drops;
- after a `RATE_LIMITED` answer, refuses the same kind of work itself, with
  no frame, for `retryAfterMs` and up to half again (5 s without one);
- keeps subscription events within the hello's `subscriptions.maxInFlight`.

Numbers in replies and frames arrive as floats (Godot's JSON); compare
with `int(...)`.

## The server side

[`test/game.ts`](test/game.ts) is the service the client is checked
against, written as a game would: `join` puts the calling socket in the
world's app room, the `move` channel declares `requires: { room: WORLD }`
so only a socket in the world may send on it, and its handler sends the
`moved` event to the world and pushes to the seeded `ticks` stream. Rooms
are per socket: a page and a game client of one player are two sockets,
and the one that sends must make the joining call
([`docs/clients.md`](../../docs/clients.md), "Rooms for games and lobbies").

## Checks

- `bun run test` (from the repository root, or here once the core package
  is built): [`test/wire.test.ts`](test/wire.test.ts) writes the frames the
  client writes, byte for byte ([`test/frames.ts`](test/frames.ts)), to a
  real server over a raw WebSocket and checks every answer, then what the
  session does not reach: a refused protocol, the heartbeat, presence and
  events between two players, channels never acknowledged.
- `bun run check:godot` (after `bun run build` at the root; Godot 4 as
  `godot` on the PATH, or `GODOT=/path/to/Godot_v4.7.2-stable_linux.x86_64`):
  [`test/godot.ts`](test/godot.ts) starts the game server and runs the
  client headless in Godot through [`test/smoke.gd`](test/smoke.gd). It
  passes when the script's checks hold and the client wrote exactly the
  frames of `test/frames.ts`. CI's `godot` job runs it with the official
  Godot 4.7.2 build.

To watch a session, run the script against a server of your own that
serves `test/game.ts`'s service:
`QD_URL=http://localhost:4000 QD_TRACE=1 godot --headless --path examples/godot --script res://test/smoke.gd`.
