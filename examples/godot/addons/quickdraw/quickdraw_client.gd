class_name QuickdrawClient
extends Node
## A quickdraw protocol v5 client for Godot 4, written from
## docs/protocol-v5.md: Socket.IO over a WebSocket, JSON only, no Socket.IO
## library. It calls methods, sends on channels, hears typed events, stream
## items and presence, links to other players (`peer_link`: WebRTC data
## channels where Godot has them, else the server's relay), and reconnects
## with a fresh handshake.
##
## Add it as an autoload (Project Settings > Globals > Autoload:
## res://addons/quickdraw/quickdraw_client.gd as "Quickdraw"), or as a child
## node, then:
##
##     Quickdraw.connected.connect(_on_connected)
##     Quickdraw.connect_to("https://api.example.com", {"token": token})
##
##     func _on_connected(hello: Dictionary) -> void:
##         var reply := await Quickdraw.call_method("gameService", "join", {"name": "ada"})
##         if reply.ok:
##             Quickdraw.send_channel("gameService", "move", {"dx": 1, "dy": 0})
##
## App rooms are per socket: `connected` fires again after every reconnect,
## and the new socket is in no room until a call joins it, so join there
## (streams are subscribed again by the client itself, rooms are not).
## Numbers in replies and frames arrive as floats (Godot's JSON).

## `qd:hello` arrived: the socket is ready, again after each reconnect. Each
## time it is a new socket in no app room: make the joining calls here.
signal connected(hello: Dictionary)
## The socket closed. The client reconnects unless `close()` or the server ended it.
signal disconnected(reason: String)
## The handshake was refused (`PROTOCOL_MISMATCH`, `UNAUTHENTICATED`): no reconnect.
signal refused(code: String, message: String)
## A typed room event (`qd:event`).
signal event_received(service: String, event: String, payload: Variant)
## An item pushed to a subscribed stream (`qd:stream`); `scope` is "" for a global stream.
signal stream_item(service: String, stream: String, scope: String, item: Variant)
## A stream's seed, on subscribing and on each resubscribe after a reconnect: it replaces what you held.
signal stream_seeded(service: String, stream: String, scope: String, seed: Array)
## Who is in an app room the socket is in, after a `qd:presence` frame.
signal presence_changed(room: String, users: Array)
## The server ended a subscription (`qd:revoked`), or refused to subscribe a
## held feed again after a reconnect (`reason` "refused", with its `error`).
signal revoked(frame: Dictionary)
## The server asked the client to reconnect (`qd:rotate`): the socket stays
## open, calls still answered, until a random moment within `within_ms`; then
## the client reconnects and `connected` fires again.
signal rotating(within_ms: int)
## The user's service grants changed (`qd:access`).
signal access_changed(service_access: Dictionary)
## Every other server event (`qd:e`, `qd:c`, `qd:changed`), for frames this client does not route.
signal frame_received(event: String, data: Variant)
## A socket of an app room this one is in signalled it with no link to it:
## answer with `peer_link(room, from, false)` within PEER_PENDING_MS, or
## `reject_peer(room, from)`. `user_id` is the peer's user, as the server named it.
signal peer_requested(room: String, from: String, user_id: String)

const PROTOCOL := 5
const CLIENT := "quickdraw-gdscript/5.0.0"
## A RATE_LIMITED reply without `retryAfterMs` waits this long (docs/protocol-v5.md, Limits).
const DEFAULT_BACKOFF_MS := 5000
## After a lost connection the client waits a random time up to this (full
## jitter), doubling after each failed attempt up to RECONNECT_MAX_S.
const RECONNECT_MIN_S := 1.0
const RECONNECT_MAX_S := 15.0
## Frames waiting to be read hold at most this many bytes: a reply as large as
## the server's default `maxResponseBytes` (1 MiB) with its envelope, and the
## frames that arrive with it. Godot drops a frame that does not fit.
const INBOUND_BUFFER_BYTES := 1 << 21
## And at most this many frames.
const MAX_QUEUED_PACKETS := 4096
## An acknowledgement nobody takes with `reply` is dropped after this long
## (a call started with `start_call` and never awaited, a refusal, a failure
## when the connection was lost)...
const UNCLAIMED_REPLY_MS := 60000
## ...or sooner, the oldest first, when more than this many wait.
const MAX_UNCLAIMED_REPLIES := 256
## A channel message is dropped, not queued, while more than this waits to be sent (volatile).
const BACKED_UP_BYTES := 65536
const SUBSCRIPTION_EVENTS := ["qd:sub", "qd:col:sub", "qd:col:items", "qd:watch", "qd:stream:sub"]
## Peer links (docs/protocol-v5.md, "Peer links"): the timings the server's
## own client keeps, which a link with one keeps to as well.
const PEER_DIRECT_TIMEOUT_MS := 5000
const PEER_OPEN_TIMEOUT_MS := 15000
const PEER_QUICK_PINGS := 6
const PEER_QUICK_PING_MS := 80
const PEER_PING_MS := 500
const PEER_WATCHDOG_MS := 8000
const PEER_PENDING_MS := 15000
## ICE may stay disconnected this long before the direct path counts as failed.
const PEER_GRACE_MS := 5000
## A `fast` message is dropped while its data channel holds more than this unsent.
const PEER_FAST_BACKLOG := 32768
## Peers whose signals may wait for an answer, and signals each may have.
const PEER_MAX_PENDING := 64
## A server whose hello names no peer limits holds these (`limits.peers`).
const PEER_LIMITS := {
	"maxMessageBytes": 65536,
	"relayRate": 120,
	"relayBurst": 240,
	"relayBytesPerSecond": 1048576,
	"relayBytesBurst": 2097152,
}
const DEFAULT_ICE_SERVERS := [
	{"urls": ["stun:stun.l.google.com:19302"]},
	{"urls": ["stun:stun.cloudflare.com:3478"]},
]
## WebRTCPeerConnection.ConnectionState and WebRTCDataChannel.ChannelState
## values, written out: a build without the WebRTC module has neither class.
const RTC_DISCONNECTED := 3
const RTC_FAILED := 4
const CHANNEL_OPEN := 1
const CHANNEL_WRITE_TEXT := 0

enum State { IDLE, CONNECTING, HANDSHAKE, READY, CLOSED }

var state := State.IDLE
## The server's `qd:hello`: `protocol`, `server`, `serverId`, `limits`, `features`, `userId`, `serviceAccess`.
var hello: Dictionary = {}
## The server's id from its hello: new each time a server starts. A reconnect
## that brings another one reached a restarted server (or another node), whose
## state (a game's world, its tick counter) starts over: compare it in `connected`.
var server_id := ""
## The user the socket acts for, or null when anonymous.
var user_id: Variant = null
## This socket's id, from the server's CONNECT: what a peer links to. "" while not connected.
var socket_id := ""
var service_access: Dictionary = {}
## Print every frame sent (`>> `) and received (`<< `), pings and pongs aside.
var trace := false
## Draws the client's random waits: the reconnect backoff, the moment a
## `qd:rotate` chooses, and the spread of a RATE_LIMITED backoff. Seed it to
## repeat a run.
var rng := RandomNumberGenerator.new()

var _ws := WebSocketPeer.new()
var _url := ""
var _auth: Dictionary = {}
var _headers := PackedStringArray()
var _reconnect := true
var _reconnect_delay := RECONNECT_MIN_S
var _reconnect_at_ms := 0
var _rotate_at_ms := 0  # when to leave for a `qd:rotate`, while one is due
var _lost_at_ms := 0
var _heartbeat_ms := 45000
var _next_id := 0
var _replies: Dictionary = {}  # ack id -> [the acknowledgement, when it arrived], until `reply` takes it
var _awaited: Dictionary = {}  # ack ids a `reply` waits for
var _deadlines: Dictionary = {}  # ack id -> when to stop waiting, while in flight
var _lane: Dictionary = {}  # ack ids of subscription events awaiting their acknowledgement
var _backoff_until := {"call": 0, "subscription": 0}
var _streams: Dictionary = {}  # "service/stream/scope" -> the qd:stream:sub frame
var _rooms: Dictionary = {}  # room -> {user id: true}
var _handlers: Dictionary = {}  # "service/event" -> [Callable]
var _links: Dictionary = {}  # "peer/room" -> PeerLink
var _pending: Dictionary = {}  # "peer/room" -> {room, from, user_id, signals, at}: signals waiting for a link
var _relay_tokens := 0.0  # the relay's bytes, for all links
var _relay_at := 0


func _init() -> void:
	rng.randomize()


## Connects to `base_url` ("https://api.example.com"). Options: `token`, sent
## as `auth.token`; `auth`, more keys for the server's `authenticate`; `path`,
## the Socket.IO path (default "/socket.io"); `headers`, a PackedStringArray
## for the WebSocket handshake ("Cookie: session=..."; not on the web, where
## the browser sends cookies); `reconnect` (default true). A client already
## connected closes that socket first.
func connect_to(base_url: String, options: Dictionary = {}) -> void:
	if state != State.IDLE and state != State.CLOSED:
		close()
	var secure := base_url.begins_with("https://")
	var host := base_url.trim_prefix("https://").trim_prefix("http://").trim_suffix("/")
	var path: String = options.get("path", "/socket.io")
	_url = "%s://%s%s/?EIO=4&transport=websocket" % ["wss" if secure else "ws", host, path]
	_auth = (options.get("auth", {}) as Dictionary).duplicate()
	if options.has("token"):
		_auth["token"] = options["token"]
	_auth["qd"] = {"protocol": PROTOCOL, "client": CLIENT}
	_headers = options.get("headers", PackedStringArray())
	_reconnect = options.get("reconnect", true)
	_reconnect_delay = RECONNECT_MIN_S
	_open()


## Ends the socket for good: no reconnect. Calls waiting fail with INTERNAL.
func close() -> void:
	_reconnect = false
	if state == State.READY or state == State.HANDSHAKE:
		_send("41")
	_ws.close()
	_lost("io client disconnect", false)


func is_ready() -> bool:
	return state == State.READY


## Calls `service.method(input)` and returns the acknowledgement:
## {ok: true, d: <output>}, {ok: true, nm: true, v} (not modified), or
## {ok: false, e: {code, message, data?}}. A call refused here, without a
## frame (not connected, or backing off after RATE_LIMITED), fails the same way.
func call_method(service: String, method: String, input: Variant = null, version: Variant = null) -> Dictionary:
	return await reply(start_call(service, method, input, version))


## Sends a call and returns its id at once, for `cancel_call`; `await reply(id)` answers it.
func start_call(service: String, method: String, input: Variant = null, version: Variant = null) -> int:
	var id := _take_id()
	var refusal := _refusal("call")
	if not refusal.is_empty():
		_keep_reply(id, refusal)
		return id
	var envelope := {"id": id, "s": service, "m": method}
	if input != null:
		envelope["i"] = input
	if version != null:
		envelope["v"] = version
	_deadlines[id] = Time.get_ticks_msec() + _call_timeout_ms()
	_emit("qd:call", envelope, id)
	return id


## Waits for the acknowledgement of call or request `id`. One that arrived
## before is kept for `UNCLAIMED_REPLY_MS`, so `reply` may come later.
func reply(id: int) -> Dictionary:
	_awaited[id] = true
	while not _replies.has(id):
		if not _deadlines.has(id) or Time.get_ticks_msec() > int(_deadlines[id]):
			_deadlines.erase(id)
			_lane.erase(id)
			_awaited.erase(id)
			return _failure("TIMEOUT", "No acknowledgement in time")
		await get_tree().process_frame
	_awaited.erase(id)
	var answer: Dictionary = _replies[id][0]
	_replies.erase(id)
	_note_rate_limit(answer, "subscription" if _lane.has(id) else "call")
	_lane.erase(id)
	return answer


## Asks the server to abort call `id`; its acknowledgement still arrives (CANCELLED).
func cancel_call(id: int) -> void:
	if state == State.READY and _deadlines.has(id):
		_emit("qd:cancel", {"id": id})


## Sends on a channel: fire and forget. Never acknowledged, never answered:
## the server drops a message over the channel's rate, failing its schema or
## its `requires` without a word. Returns false when the message was dropped
## here (not connected, or the connection is backed up).
func send_channel(service: String, channel: String, payload: Variant) -> bool:
	if state != State.READY or _ws.get_current_outbound_buffered_amount() > BACKED_UP_BYTES:
		return false
	_emit("qd:ch", [service, channel, payload])
	return true


## Subscribes to a stream (one scope of it, for a scoped stream) and returns
## the acknowledgement, {ok: true, seed: [...]}. Items then arrive as
## `stream_item`; after a reconnect the client subscribes again by itself. A
## refusal on a live connection ({ok: false}: FORBIDDEN, NOT_FOUND, ...)
## leaves the feed not held (`is_subscribed` is false); one lost with the
## connection is held, and subscribed again after the reconnect.
func subscribe_stream(service: String, stream: String, scope := "") -> Dictionary:
	var frame := {"s": service, "stream": stream}
	if scope != "":
		frame["scope"] = scope
	var key := _stream_key(service, stream, scope)
	_streams[key] = frame
	var answer := await request("qd:stream:sub", frame)
	if answer.get("ok", false):
		stream_seeded.emit(service, stream, scope, answer.get("seed", []))
	else:
		_drop_refused(key, frame)
	return answer


func unsubscribe_stream(service: String, stream: String, scope := "") -> void:
	var frame: Variant = _streams.get(_stream_key(service, stream, scope))
	_streams.erase(_stream_key(service, stream, scope))
	if frame != null and state == State.READY:
		_emit("qd:stream:unsub", frame)


## True while the client holds the feed: from `subscribe_stream` until
## `unsubscribe_stream`, a `qd:revoked` for it, or a refusal of its
## subscribe on a live connection (then false at once). The client
## subscribes to a held feed again after each reconnect, so a caller that
## asks first never sends a second `qd:stream:sub`.
func is_subscribed(service: String, stream: String, scope := "") -> bool:
	return _streams.has(_stream_key(service, stream, scope))


## Calls `callback(payload)` for each `qd:event` of `service` named `event`.
func on_event(service: String, event: String, callback: Callable) -> void:
	var key := "%s/%s" % [service, event]
	if not _handlers.has(key):
		_handlers[key] = []
	(_handlers[key] as Array).append(callback)


## Stops calling `callback` for `qd:event` of `service` named `event`, once
## per `on_event` that added it. Returns false when it was not registered.
func off_event(service: String, event: String, callback: Callable) -> bool:
	var key := "%s/%s" % [service, event]
	var callbacks: Array = _handlers.get(key, [])
	var index := callbacks.find(callback)
	if index < 0:
		return false
	callbacks.remove_at(index)
	if callbacks.is_empty():
		_handlers.erase(key)
	return true


## The users in an app room the socket is in, as its `qd:presence` frames said.
func presence(room: String) -> Array:
	return (_rooms.get(room, {}) as Dictionary).keys()


## Sends any acknowledged event of the protocol and waits for its acknowledgement.
## Subscription events wait for a place in the lane `hello.limits.subscriptions` allows.
func request(event: String, payload: Variant) -> Dictionary:
	var kind := "subscription" if SUBSCRIPTION_EVENTS.has(event) else "call"
	while kind == "subscription" and state == State.READY and _lane.size() >= _lane_limit():
		await get_tree().process_frame
	var id := _take_id()
	var refusal := _refusal(kind)
	if not refusal.is_empty():
		return refusal
	if kind == "subscription":
		_lane[id] = true
	_deadlines[id] = Time.get_ticks_msec() + _call_timeout_ms()
	_emit(event, payload, id)
	return await reply(id)


## Opens a link to socket `to` in app room `room`: both sockets in the room,
## on a server created with `peers: true`. One side offers (`offerer`);
## when both do, the side whose socket id sorts after the other's answers
## instead. Options: `relay` ("auto": when WebRTC cannot connect;
## "always"; "never"), `ice_servers` (default DEFAULT_ICE_SERVERS). The link
## uses WebRTC data channels where Godot has them (a web export, or the
## webrtc GDExtension) and the server's relay otherwise. Connect its signals
## right away: it opens, or closes, from the next frame on. A second link to
## the same peer in the same room returns the first.
func peer_link(room: String, to: String, offerer: bool, options: Dictionary = {}) -> PeerLink:
	var key := _peer_key(room, to)
	if _links.has(key):
		push_error("peer_link: a link to %s in room %s is open already; close it first" % [to, room])
		return _links[key]
	var link := PeerLink.new(self, room, to, offerer, options)
	_links[key] = link
	if state != State.READY:
		link._finish.call_deferred("disconnected", false)
	elif not (hello.get("features", []) as Array).has("peer"):
		link._finish.call_deferred("unsupported", false)
	else:
		link._start.call_deferred()
	return link


## Refuses a link `peer_requested` asked for: the peer's link closes, with "bye".
func reject_peer(room: String, from: String) -> void:
	_pending.erase(_peer_key(room, from))
	if state == State.READY:
		_emit("qd:peer", {"room": room, "to": from, "sig": {"bye": true}})


# --- Connection --------------------------------------------------------------


func _open() -> void:
	_ws = WebSocketPeer.new()
	_ws.inbound_buffer_size = INBOUND_BUFFER_BYTES
	_ws.max_queued_packets = MAX_QUEUED_PACKETS
	_ws.outbound_buffer_size = 1 << 18
	if not _headers.is_empty():
		_ws.handshake_headers = _headers
	state = State.CONNECTING
	if _ws.connect_to_url(_url) != OK:
		_lost("transport error", true)


func _process(_delta: float) -> void:
	var now := Time.get_ticks_msec()
	if state == State.CLOSED or state == State.IDLE:
		if _reconnect and _reconnect_at_ms > 0 and now >= _reconnect_at_ms:
			_reconnect_at_ms = 0
			_open()
		return
	if _rotate_at_ms > 0 and now >= _rotate_at_ms:
		_rotate()
		return
	_ws.poll()
	match _ws.get_ready_state():
		WebSocketPeer.STATE_OPEN:
			while _ws.get_available_packet_count() > 0:
				var packet := _ws.get_packet()
				if _ws.was_string_packet():
					_receive(packet.get_string_from_utf8())
			if state != State.CONNECTING and now > _lost_at_ms:
				_ws.close()
				_lost("ping timeout", true)
		WebSocketPeer.STATE_CLOSED:
			_lost("transport close", true)
	for key in _links.keys():
		var link: PeerLink = _links.get(key)
		if link != null:
			link._poll(now)


## The moment a `qd:rotate` chose: leave, and connect again at once with a fresh handshake.
func _rotate() -> void:
	_send("41")
	_ws.close()
	_lost("rotate", false)
	if _reconnect:
		_reconnect_at_ms = maxi(1, Time.get_ticks_msec())


## The socket is gone: answer what waits, forget its rooms, and reconnect when wanted.
func _lost(reason: String, retry: bool) -> void:
	var was := state
	state = State.CLOSED
	_rotate_at_ms = 0
	for id in _deadlines.keys():
		_keep_reply(id, _failure("INTERNAL", "The connection was lost"))
	_deadlines.clear()
	_rooms.clear()
	# A link lives as long as the socket it started on.
	_pending.clear()
	_end_links("", "disconnected")
	socket_id = ""
	if was == State.READY:
		disconnected.emit(reason)
	if retry and _reconnect:
		_reconnect_at_ms = Time.get_ticks_msec() + int(rng.randf_range(0.0, _reconnect_delay) * 1000.0)
		_reconnect_delay = minf(_reconnect_delay * 2.0, RECONNECT_MAX_S)


func _send(text: String) -> void:
	if trace and text != "3":
		print(">> ", text)
	_ws.send_text(text)


## `42["event",payload]`, or `42<id>["event",payload]` when it asks for an acknowledgement.
func _emit(event: String, payload: Variant, ack := -1) -> void:
	var head := "42" if ack < 0 else "42%d" % ack
	_send(head + JSON.stringify([event, payload]))


# --- Receiving ---------------------------------------------------------------


func _receive(text: String) -> void:
	if trace and text != "2":
		print("<< ", text)
	match text.substr(0, 1):
		"0":
			_on_open(JSON.parse_string(text.substr(1)))
		"2":
			_send("3")
			_lost_at_ms = Time.get_ticks_msec() + _heartbeat_ms
		"4":
			_on_packet(text.substr(1))


## Engine.IO OPEN: note the heartbeat, then connect with the handshake.
func _on_open(settings: Variant) -> void:
	if settings is Dictionary:
		_heartbeat_ms = int(settings.get("pingInterval", 25000)) + int(settings.get("pingTimeout", 20000))
	_lost_at_ms = Time.get_ticks_msec() + _heartbeat_ms
	state = State.HANDSHAKE
	_send("40" + JSON.stringify(_auth))


## A Socket.IO packet: its type, then (EVENT, ACK) an ack id's digits and a JSON array.
func _on_packet(text: String) -> void:
	var kind := text.substr(0, 1)
	match kind:
		"0":
			var connected_as: Variant = JSON.parse_string(text.substr(1))
			if connected_as is Dictionary:
				socket_id = str((connected_as as Dictionary).get("sid", ""))
		"1":
			_ws.close()
			_lost("io server disconnect", false)
		"2", "3":
			var bracket := text.find("[")
			var body: Variant = JSON.parse_string(text.substr(bracket)) if bracket > 0 else null
			if not (body is Array) or (body as Array).is_empty():
				return
			if kind == "2":
				_on_event(str(body[0]), body[1] if (body as Array).size() > 1 else null)
			else:
				_on_ack(text.substr(1, bracket - 1).to_int(), body[0])
		"4":
			_on_refused(JSON.parse_string(text.substr(1)))


func _on_ack(id: int, answer: Variant) -> void:
	if _deadlines.has(id) and answer is Dictionary:
		_deadlines.erase(id)
		_keep_reply(id, answer)


func _on_refused(body: Variant) -> void:
	var data: Dictionary = body.get("data", {}) if body is Dictionary else {}
	var message: String = body.get("message", "") if body is Dictionary else ""
	_reconnect = false
	_ws.close()
	_lost("refused", false)
	refused.emit(str(data.get("code", "")), message)


func _on_event(event: String, data: Variant) -> void:
	match event:
		"qd:hello":
			_on_hello(data)
		"qd:event":
			_on_room_event(data)
		"qd:stream":
			_on_stream(data)
		"qd:presence":
			_on_presence(data)
		"qd:peer":
			_on_peer_signal(data)
		"qd:relay":
			_on_peer_relay(data)
		"qd:revoked":
			if data.get("kind") == "stream":
				_streams.erase(_stream_key(data.s, data.stream, data.get("scope", "")))
			revoked.emit(data)
		"qd:access":
			service_access = data.get("serviceAccess", {})
			access_changed.emit(service_access)
		"qd:rotate":
			# Stay on this socket until a random moment within the window, then
			# reconnect (`_rotate`), so the server's clients come back spread out.
			if _rotate_at_ms == 0:
				var within := maxi(0, int(data.get("withinMs", 0)))
				_rotate_at_ms = maxi(1, Time.get_ticks_msec() + rng.randi_range(0, within))
				rotating.emit(within)
		_:
			frame_received.emit(event, data)


func _on_hello(data: Variant) -> void:
	hello = data
	server_id = str(hello.get("serverId", ""))
	user_id = hello.get("userId")
	service_access = hello.get("serviceAccess", {})
	state = State.READY
	_reconnect_delay = RECONNECT_MIN_S
	for key in _streams.keys():
		_resubscribe(_streams[key])
	connected.emit(hello)


func _resubscribe(frame: Dictionary) -> void:
	var answer := await request("qd:stream:sub", frame)
	var scope: String = frame.get("scope", "")
	if answer.get("ok", false):
		stream_seeded.emit(frame.s, frame.stream, scope, answer.get("seed", []))
	elif _drop_refused(_stream_key(frame.s, frame.stream, scope), frame):
		# The feed held before the reconnect is gone (access lost meanwhile): say so.
		var ended := {"kind": "stream", "reason": "refused", "s": frame.s, "stream": frame.stream, "error": answer.get("e", {})}
		if scope != "":
			ended["scope"] = scope
		revoked.emit(ended)


## Forgets a feed whose `qd:stream:sub` the server refused on a live
## connection, unless another subscribe replaced its frame meanwhile; a
## failure that came with a lost connection keeps it, for the reconnect.
## Returns true when it forgot it.
func _drop_refused(key: String, frame: Dictionary) -> bool:
	if state != State.READY or not is_same(_streams.get(key), frame):
		return false
	_streams.erase(key)
	return true


## `[service, stream, scope, item]`, `scope` null for a global stream;
## elements after `item` belong to a later protocol and are ignored.
func _on_stream(data: Variant) -> void:
	if not (data is Array) or (data as Array).size() < 4:
		return
	var scope: Variant = data[2]
	stream_item.emit(str(data[0]), str(data[1]), "" if scope == null else str(scope), data[3])


## `[service, event, payload]`; elements after `payload` belong to a later
## protocol and are ignored.
func _on_room_event(data: Variant) -> void:
	if not (data is Array) or (data as Array).size() < 3:
		return
	event_received.emit(data[0], data[1], data[2])
	for callback in _handlers.get("%s/%s" % [data[0], data[1]], []):
		(callback as Callable).call(data[2])


## `users` replaces the room's list, `joined` adds a user, `left` removes one.
func _on_presence(frame: Dictionary) -> void:
	var room: String = frame.room
	var users: Dictionary = _rooms.get(room, {})
	if frame.has("users"):
		users = {}
		for user in frame.users:
			users[user] = true
	if frame.has("joined"):
		users[frame.joined] = true
	if frame.has("left"):
		users.erase(frame.left)
	if users.is_empty():
		_rooms.erase(room)
	else:
		_rooms[room] = users
	presence_changed.emit(room, users.keys())
	# `users: []` comes to a socket that left the room, or was taken out: its links there end.
	if frame.has("users") and (frame.users as Array).is_empty():
		_end_links(room, "left")


# --- Limits ------------------------------------------------------------------


func _take_id() -> int:
	var id := _next_id
	_next_id += 1
	return id


## Keeps the acknowledgement of `id` until `reply` takes it. One nobody awaits
## is dropped once it is UNCLAIMED_REPLY_MS old, or when more than
## MAX_UNCLAIMED_REPLIES wait, the oldest first.
func _keep_reply(id: int, answer: Dictionary) -> void:
	var now := Time.get_ticks_msec()
	_replies[id] = [answer, now]
	for old in _replies.keys():
		if _replies.size() <= MAX_UNCLAIMED_REPLIES and now - int(_replies[old][1]) < UNCLAIMED_REPLY_MS:
			break
		if not _awaited.has(old):
			_replies.erase(old)


func _call_timeout_ms() -> int:
	return int(hello.get("limits", {}).get("callTimeoutMs", 30000)) + 2000


func _lane_limit() -> int:
	return int(hello.get("limits", {}).get("subscriptions", {}).get("maxInFlight", 8))


## Why a call or subscription is refused here, without a frame, or {} when it may go.
func _refusal(kind: String) -> Dictionary:
	if state != State.READY:
		return _failure("INTERNAL", "Not connected")
	if Time.get_ticks_msec() < int(_backoff_until[kind]):
		return _failure("RATE_LIMITED", "Backing off after RATE_LIMITED")
	return {}


## A RATE_LIMITED reply pauses that kind of work for `retryAfterMs` and up to half again.
func _note_rate_limit(answer: Dictionary, kind: String) -> void:
	var error: Dictionary = answer.get("e", {}) if not answer.get("ok", true) else {}
	if error.get("code") != "RATE_LIMITED" or error.get("message") == "Backing off after RATE_LIMITED":
		return
	var data: Variant = error.get("data")
	var wait := float(data.get("retryAfterMs", DEFAULT_BACKOFF_MS)) if data is Dictionary else float(DEFAULT_BACKOFF_MS)
	wait = clampf(wait, 250.0, 300000.0)
	_backoff_until[kind] = Time.get_ticks_msec() + int(wait * rng.randf_range(1.0, 1.5))


func _failure(code: String, message: String) -> Dictionary:
	return {"ok": false, "e": {"code": code, "message": message}}


func _stream_key(service: String, stream: String, scope: String) -> String:
	return "%s/%s/%s" % [service, stream, scope]


# --- Peer links --------------------------------------------------------------


func _peer_key(room: String, peer: String) -> String:
	# A socket id holds no "/", so the first one ends it.
	return "%s/%s" % [peer, room]


## A limit of `hello.limits.peers`, or PEER_LIMITS' when the hello names none.
func _peer_limit(limit: String) -> float:
	var peers: Variant = (hello.get("limits", {}) as Dictionary).get("peers")
	var limits: Dictionary = peers if peers is Dictionary else PEER_LIMITS
	return float(limits.get(limit, PEER_LIMITS[limit]))


func _end_links(room: String, reason: String) -> void:
	for key in _links.keys():
		var link: PeerLink = _links.get(key)
		if link != null and (room == "" or link.room == room):
			link._finish(reason, false)


func _forget_link(link: PeerLink) -> void:
	var key := _peer_key(link.room, link.peer)
	if _links.get(key) == link:
		_links.erase(key)


## What waited for a link from `peer` in `room`: {user_id, signals}, or {} when nothing fresh did.
func _take_pending(room: String, peer: String) -> Dictionary:
	var key := _peer_key(room, peer)
	var entry: Dictionary = _pending.get(key, {})
	_pending.erase(key)
	if entry.is_empty() or Time.get_ticks_msec() - int(entry.at) > PEER_PENDING_MS:
		return {}
	return entry


## Sends a link's signal and, but for a candidate or a bye, closes the link
## as "refused" when the server refuses it.
func _send_peer_signal(link: PeerLink, sig: Dictionary) -> void:
	if state != State.READY:
		return
	var id := _take_id()
	_deadlines[id] = Time.get_ticks_msec() + _call_timeout_ms()
	_awaited[id] = true
	_emit("qd:peer", {"room": link.room, "to": link.peer, "sig": sig}, id)
	while not _replies.has(id):
		if not _deadlines.has(id) or Time.get_ticks_msec() > int(_deadlines[id]):
			_deadlines.erase(id)
			_awaited.erase(id)
			return
		await get_tree().process_frame
	_awaited.erase(id)
	var answer: Dictionary = _replies[id][0]
	_replies.erase(id)
	if answer.get("ok", false) or sig.has("ice") or sig.has("bye") or link.state == "closed":
		return
	var code := str((answer.get("e", {}) as Dictionary).get("code", ""))
	if code != "TIMEOUT" and code != "RATE_LIMITED":
		link._finish("refused", false)


## Sends a link message through the relay, within nine tenths of each rate
## of `limits.peers` and half of each burst. False when it was dropped.
func _send_relay(link: PeerLink, label: String, text: String) -> bool:
	if state != State.READY:
		return false
	if label == "fast" and _ws.get_current_outbound_buffered_amount() > BACKED_UP_BYTES:
		return false
	var now := Time.get_ticks_msec()
	if not link._take_token(now, _peer_limit("relayRate") * 0.9, _peer_limit("relayBurst") * 0.5):
		return false
	var bytes := float(text.to_utf8_buffer().size())
	var burst := _peer_limit("relayBytesBurst") * 0.5
	var refill := float(now - _relay_at) / 1000.0 * _peer_limit("relayBytesPerSecond") * 0.9
	_relay_tokens = minf(burst, (burst if _relay_at == 0 else _relay_tokens) + refill)
	_relay_at = now
	if _relay_tokens < bytes:
		return false
	_relay_tokens -= bytes
	_emit("qd:relay", [link.room, link.peer, label, text])
	return true


## `{room, from, userId, sig}`: to its link, or, from a peer with no link, kept as a request.
func _on_peer_signal(frame: Variant) -> void:
	if not (frame is Dictionary):
		return
	var room: Variant = frame.get("room")
	var from: Variant = frame.get("from")
	var sig: Variant = frame.get("sig")
	if not (room is String and from is String and sig is Dictionary):
		return
	var user := str(frame.get("userId", ""))
	var key := _peer_key(room, from)
	var link: PeerLink = _links.get(key)
	if link != null and link._on_signal(sig, user):
		return
	if (sig as Dictionary).get("bye") == true:
		_pending.erase(key)
		return
	var now := Time.get_ticks_msec()
	for old in _pending.keys():
		if now - int(_pending[old].at) > PEER_PENDING_MS:
			_pending.erase(old)
	if _pending.has(key):
		var waiting: Array = _pending[key].signals
		if waiting.size() < PEER_MAX_PENDING:
			waiting.append(sig)
		return
	if _pending.size() >= PEER_MAX_PENDING:
		return
	_pending[key] = {"room": room, "from": from, "user_id": user, "signals": [sig], "at": now}
	peer_requested.emit(room, from, user)


## `[room, from, label, text]`: to its link.
func _on_peer_relay(data: Variant) -> void:
	if not (data is Array) or (data as Array).size() < 4:
		return
	var link: PeerLink = _links.get(_peer_key(str(data[0]), str(data[1])))
	if link != null:
		link._receive(str(data[3]), str(data[2]))


## A link to another socket of an app room (`peer_link`): two channels,
## "rel" (ordered, reliable) and "fast" (unordered, never retransmitted),
## over WebRTC data channels or the server's relay, alike either way.
## Messages are JSON values; numbers arrive as floats (Godot's JSON).
class PeerLink:
	extends RefCounted

	## The link opened, on `path`: "direct" or "relay". Once.
	signal opened(path: String)
	## An app message from the peer, on `label`.
	signal message(label: String, data: Variant)
	## The link's state ("connecting", "open", "closed") or path changed.
	signal state_changed(state: String, path: String)
	## The link closed, once: "closed" (`close()`), "bye" (the peer closed it,
	## left the room or disconnected), "left" (this socket left the room),
	## "disconnected", "timeout", "lost" (nothing heard for a while),
	## "failed", "refused" (by the server) or "unsupported".
	signal closed(reason: String)

	var room := ""
	## The peer's socket id.
	var peer := ""
	## The peer's user, as the server named it in its first signal.
	var user_id := ""
	var offerer := false
	var state := "connecting"
	## "direct" or "relay" while open, else "".
	var path := ""
	var close_reason := ""
	## App messages sent, received, and dropped by `send`.
	var sent := 0
	var received := 0
	var dropped := 0
	## The peer's clock minus this one's, the smoothed round trip and its
	## variation, in milliseconds; `synced` once enough pongs arrived.
	var clock_offset := 0.0
	var rtt := 0.0
	var jitter := 0.0
	var synced := false

	var _client = null
	var _relay_mode := "auto"
	var _ice_servers: Array = []
	var _started := false
	var _queued: Array = []
	var _relay_sent := false
	var _relay_heard := false
	var _heard_offer := false
	var _pc = null
	var _rel = null
	var _fast = null
	var _direct_open := false
	var _remote_set := false
	var _early: Array = []
	var _open_by := 0
	var _direct_by := 0
	var _grace_by := 0
	var _next_ping := 0
	var _pings_left := 0
	var _last_heard := 0
	var _samples: Array = []
	var _pongs := 0
	var _tokens := 0.0
	var _tokens_at := 0

	func _init(client, link_room: String, to: String, is_offerer: bool, options: Dictionary) -> void:
		_client = client
		room = link_room
		peer = to
		offerer = is_offerer
		_relay_mode = str(options.get("relay", "auto"))
		_ice_servers = options.get("ice_servers", QuickdrawClient.DEFAULT_ICE_SERVERS)

	## Sends `data` (any JSON value) on `label`, "rel" or "fast". Returns false
	## when it was dropped: the link is not open, "fast" is backed up, the
	## relay's rate is spent, or the message is longer than the server allows.
	func send(label: String, data: Variant) -> bool:
		if label != "rel" and label != "fast":
			push_error("PeerLink.send: label must be rel or fast")
			return false
		var text := JSON.stringify([0, data])
		if float(text.to_utf8_buffer().size()) > _client._peer_limit("maxMessageBytes"):
			push_error("PeerLink.send: the message is longer than the server allows; split it")
			dropped += 1
			return false
		var ok := state == "open" and _send_text(label, text)
		if ok:
			sent += 1
		else:
			dropped += 1
		return ok

	## The peer's clock now, in its milliseconds: `Time.get_ticks_msec()` plus `clock_offset`.
	func clock_now() -> float:
		return float(Time.get_ticks_msec()) + clock_offset

	## Closes the link and tells the peer. Does nothing once it is closed.
	func close() -> void:
		_finish("closed", true)

	func _finish(reason: String, from_here: bool) -> void:
		if state == "closed":
			return
		state = "closed"
		path = ""
		close_reason = reason
		_close_direct()
		_client._forget_link(self)
		# A refused or unsupported link has no session the server would carry a bye for.
		if from_here and _started and reason != "refused" and reason != "unsupported":
			_client._send_peer_signal(self, {"bye": true})
		state_changed.emit("closed", "")
		closed.emit(reason)

	func _can_direct() -> bool:
		return _relay_mode != "always" and ClassDB.class_exists("WebRTCPeerConnection")

	func _start() -> void:
		if state == "closed":
			return
		if _relay_mode == "never" and not _can_direct():
			_finish("unsupported", false)
			return
		_started = true
		var now := Time.get_ticks_msec()
		_open_by = now + QuickdrawClient.PEER_OPEN_TIMEOUT_MS
		var waiting: Dictionary = _client._take_pending(room, peer)
		if offerer:
			if _can_direct() and _open_direct(now):
				_pc.create_offer()
			else:
				_move_to_relay()
		var signals: Array = waiting.get("signals", [])
		var from_user := str(waiting.get("user_id", ""))
		for sig in signals:
			if not _on_signal(sig, from_user):
				return
		var queued := _queued
		_queued = []
		for entry in queued:
			if not _on_signal(entry[0], entry[1]):
				return

	## Starts the direct path; false when Godot has no working WebRTC here.
	func _open_direct(now: int) -> bool:
		var pc = ClassDB.instantiate("WebRTCPeerConnection")
		if pc == null or pc.initialize({"iceServers": _ice_servers}) != OK:
			return false
		var rel = pc.create_data_channel("rel", {"negotiated": true, "id": 0, "ordered": true})
		var fast_init := {"negotiated": true, "id": 1, "ordered": false, "maxRetransmits": 0}
		var fast = pc.create_data_channel("fast", fast_init)
		if rel == null or fast == null:
			pc.close()
			return false
		rel.write_mode = QuickdrawClient.CHANNEL_WRITE_TEXT
		fast.write_mode = QuickdrawClient.CHANNEL_WRITE_TEXT
		pc.session_description_created.connect(_on_description)
		pc.ice_candidate_created.connect(_on_candidate)
		_pc = pc
		_rel = rel
		_fast = fast
		_remote_set = false
		_direct_open = false
		if _relay_mode != "never":
			_direct_by = now + QuickdrawClient.PEER_DIRECT_TIMEOUT_MS
		return true

	func _close_direct() -> void:
		if _pc != null:
			_pc.close()
		_pc = null
		_rel = null
		_fast = null
		_direct_open = false
		_direct_by = 0
		_grace_by = 0

	func _on_description(type: String, sdp: String) -> void:
		if _pc == null:
			return
		_pc.set_local_description(type, sdp)
		_client._send_peer_signal(self, {"sdp": {"type": type, "sdp": sdp}})

	func _on_candidate(media: String, index: int, candidate: String) -> void:
		if _pc != null:
			var ice := {"candidate": candidate, "sdpMid": media, "sdpMLineIndex": index}
			_client._send_peer_signal(self, {"ice": ice})

	## Applies the peer's description; Godot answers an offer by itself.
	func _apply_remote(type: String, sdp: String) -> void:
		if _pc.set_remote_description(type, sdp) != OK:
			_direct_failed()
			return
		_remote_set = true
		var early := _early
		_early = []
		for ice in early:
			_add_candidate(ice)

	## A candidate of the peer's, kept until its description is applied.
	func _add_candidate(ice: Variant) -> void:
		if not (ice is Dictionary):
			return
		if _pc == null or not _remote_set:
			if _early.size() < QuickdrawClient.PEER_MAX_PENDING:
				_early.append(ice)
			return
		var mid: Variant = ice.get("sdpMid")
		var index: Variant = ice.get("sdpMLineIndex")
		var line := 0 if index == null else int(index)
		_pc.add_ice_candidate("0" if mid == null else str(mid), line, str(ice.get("candidate", "")))

	## Whether `sig` opens a new link rather than continuing this one: the
	## peer offers once and says relay once, so a second time means this side
	## missed the bye of its last link.
	func _restarts(sig: Dictionary) -> bool:
		if offerer:
			return false
		if sig.get("relay") == true:
			return _relay_heard
		var sdp: Variant = sig.get("sdp")
		if not (sdp is Dictionary) or (sdp as Dictionary).get("type") != "offer":
			return false
		var again := _heard_offer or _relay_heard
		_heard_offer = true
		return again

	## A signal from the peer; false when it opens a new link, so this one ended.
	func _on_signal(sig: Dictionary, from_user: String) -> bool:
		if not _started:
			_queued.append([sig, from_user])
			return true
		if _restarts(sig):
			_finish("bye", false)
			return false
		if user_id == "" and from_user != "":
			user_id = from_user
		if sig.get("bye") == true:
			_finish("bye", false)
		elif sig.get("relay") == true:
			_relay_heard = true
			_move_to_relay()
		elif sig.get("sdp") is Dictionary:
			_described(sig.sdp)
		elif sig.has("ice"):
			_add_candidate(sig.ice)
		return true

	## Whether this side, an offerer the peer sent an offer, answers it
	## instead: both sides offered, and the side whose socket id sorts after
	## the other's yields; the other ignores the offer. A side that said
	## relay yields to nothing: the peer moves to the relay on hearing it.
	func _yields() -> bool:
		return not _relay_sent and _client.socket_id > peer

	func _described(sdp: Dictionary) -> void:
		var text := str(sdp.get("sdp", ""))
		if sdp.get("type") == "answer":
			if offerer and _pc != null:
				_apply_remote("answer", text)
			return
		if offerer:
			if not _yields():
				return
			_close_direct()
			offerer = false
			_heard_offer = true
		if _relay_sent or _pc != null:
			return
		if _can_direct() and _open_direct(Time.get_ticks_msec()):
			_apply_remote("offer", text)
		else:
			_move_to_relay()

	## Moves to the relay, saying so once; it carries the link once both said it.
	func _move_to_relay() -> void:
		if _relay_mode == "never":
			_finish("failed", true)
			return
		_close_direct()
		if not _relay_sent:
			_relay_sent = true
			_client._send_peer_signal(self, {"relay": true})
		if _relay_heard or state == "open":
			_carry("relay")

	func _direct_failed() -> void:
		var was_open := state == "open"
		_close_direct()
		if _relay_mode == "never":
			_finish("lost" if was_open else "failed", true)
		else:
			_move_to_relay()

	func _carry(new_path: String) -> void:
		if state == "closed" or (state == "open" and path == new_path):
			return
		var opening := state == "connecting"
		state = "open"
		path = new_path
		if opening:
			_last_heard = Time.get_ticks_msec()
			_pings_left = QuickdrawClient.PEER_QUICK_PINGS
			_next_ping = 0
			opened.emit(new_path)
		state_changed.emit("open", new_path)

	func _send_text(label: String, text: String) -> bool:
		if _direct_open and _pc != null:
			var channel = _rel if label == "rel" else _fast
			if label == "fast" and channel.get_buffered_amount() > QuickdrawClient.PEER_FAST_BACKLOG:
				return false
			return channel.put_packet(text.to_utf8_buffer()) == OK
		return _relay_sent and _client._send_relay(self, label, text)

	## Takes one of the relay's tokens for this link, refilled at `rate` a second up to `burst`.
	func _take_token(now: int, rate: float, burst: float) -> bool:
		var refill := float(now - _tokens_at) / 1000.0 * rate
		_tokens = minf(burst, (burst if _tokens_at == 0 else _tokens) + refill)
		_tokens_at = now
		if _tokens < 1.0:
			return false
		_tokens -= 1.0
		return true

	## One link message's text: `[0, data]`, `[1, t]` (a ping) or `[2, t, u]` (its pong).
	func _receive(text: String, label: String) -> void:
		if state == "closed":
			return
		var value: Variant = JSON.parse_string(text)
		if not (value is Array) or (value as Array).size() < 2:
			return
		var parts: Array = value
		var kind: Variant = parts[0]
		if not (kind is float or kind is int):
			return
		_last_heard = Time.get_ticks_msec()
		if kind == 0:
			received += 1
			message.emit(label, parts[1])
		elif kind == 1:
			if state == "open":
				_send_text("fast", JSON.stringify([2, parts[1], Time.get_ticks_msec()], "", true, true))
		elif kind == 2 and parts.size() >= 3:
			_pong(float(parts[1]), float(parts[2]))

	## A pong: the round trip and the peer's clock, taken from the fastest of the
	## last 24 round trips, then moved toward a new one by at most 5 ms a pong.
	func _pong(t: float, u: float) -> void:
		var at := float(Time.get_ticks_msec())
		var trip := at - t
		if trip < 0.0 or trip > 10000.0:
			return
		_samples.append([trip, u + trip / 2.0 - at])
		if _samples.size() > 24:
			_samples.pop_front()
		_pongs += 1
		if _pongs == 1:
			rtt = trip
			jitter = trip / 2.0
		else:
			jitter += (absf(trip - rtt) - jitter) / 4.0
			rtt += (trip - rtt) / 8.0
		var best: float = _samples[0][0]
		var target: float = _samples[0][1]
		for sample in _samples:
			if float(sample[0]) <= best:
				best = float(sample[0])
				target = float(sample[1])
		if _pongs <= 5 or absf(target - clock_offset) > 250.0:
			clock_offset = target
		else:
			clock_offset += clampf(target - clock_offset, -5.0, 5.0)
		synced = _pongs >= 5

	func _poll(now: int) -> void:
		if state == "closed":
			return
		if _pc != null:
			_poll_direct(now)
		if state == "connecting" and now >= _open_by and _started:
			_finish("timeout", true)
			return
		if _direct_by > 0 and now >= _direct_by and not _direct_open:
			_direct_by = 0
			_direct_failed()
		if state != "open":
			return
		if now - _last_heard > QuickdrawClient.PEER_WATCHDOG_MS:
			_finish("lost", true)
			return
		if now >= _next_ping:
			_send_text("fast", JSON.stringify([1, now]))
			_pings_left = maxi(0, _pings_left - 1)
			var quick := _pings_left > 0
			var wait := QuickdrawClient.PEER_QUICK_PING_MS if quick else QuickdrawClient.PEER_PING_MS
			_next_ping = now + wait

	func _poll_direct(now: int) -> void:
		_pc.poll()
		var connection: int = _pc.get_connection_state()
		if connection == QuickdrawClient.RTC_FAILED:
			_direct_failed()
			return
		if connection == QuickdrawClient.RTC_DISCONNECTED:
			if _grace_by == 0:
				_grace_by = now + QuickdrawClient.PEER_GRACE_MS
			elif now >= _grace_by:
				_direct_failed()
				return
		else:
			_grace_by = 0
		var rel_open: bool = _rel.get_ready_state() == QuickdrawClient.CHANNEL_OPEN
		var both_open: bool = rel_open and _fast.get_ready_state() == QuickdrawClient.CHANNEL_OPEN
		if not _direct_open and both_open:
			_direct_open = true
			_direct_by = 0
			_carry("direct")
		elif _direct_open and not both_open:
			_direct_failed()
			return
		for label in ["rel", "fast"]:
			while _pc != null:
				var channel = _rel if label == "rel" else _fast
				if channel.get_available_packet_count() == 0:
					break
				var packet: PackedByteArray = channel.get_packet()
				_receive(packet.get_string_from_utf8(), label)
