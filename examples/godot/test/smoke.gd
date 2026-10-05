extends SceneTree
## Drives the client (the "Quickdraw" autoload) through one session against
## the game server at QD_URL (test/game.ts), writing the frames of
## test/frames.ts in order. Prints every frame with QD_TRACE=1, "STEP rotate"
## when the harness should send qd:rotate, and a last line "RESULT {json}";
## exits 0 when every check held. Run it with `bun run check:godot`.

## The window of the harness's qd:rotate (test/godot.ts sends the same), and
## the part of it the seeded client's moment falls in.
const ROTATE_WITHIN_MS := 1000
const ROTATE_EARLIEST_MS := 400
const ROTATE_LATEST_MS := 700

var failures: Array[String] = []
var checks := 0
var first_server_id := ""
var events: Array = []
var items: Array = []
var seeds: Array = []


func _initialize() -> void:
	Engine.max_fps = 200
	_run()


func check(ok: bool, what: String) -> void:
	checks += 1
	if not ok:
		failures.append(what)
		printerr("FAILED: ", what)


func until(condition: Callable, timeout_ms := 5000) -> bool:
	var deadline := Time.get_ticks_msec() + timeout_ms
	while not condition.call():
		if Time.get_ticks_msec() > deadline:
			return false
		await process_frame
	return true


func wait_ms(ms: int) -> void:
	await create_timer(ms / 1000.0).timeout


func moved(dx: int) -> bool:
	return events.any(func(event: Array) -> bool: return int(event[2].dx) == dx)


func _run() -> void:
	var url := OS.get_environment("QD_URL")
	var client = root.get_node("Quickdraw")
	client.trace = OS.get_environment("QD_TRACE") == "1"
	client.event_received.connect(func(service, event, payload): events.append([service, event, payload]))
	client.stream_item.connect(func(_service, _stream, _scope, item): items.append(item))
	client.stream_seeded.connect(func(_service, _stream, _scope, seed): seeds.append(seed))
	client.connect_to(url, {"token": "ada"})
	var hello: Dictionary = await client.connected
	check(int(hello.protocol) == 5 and client.user_id == "ada", "qd:hello names protocol 5 and the user")
	check((hello.limits as Dictionary).has("callTimeoutMs"), "qd:hello carries the limits")
	check(client.server_id != "" and client.server_id == hello.serverId, "qd:hello names the server")
	first_server_id = client.server_id
	await _calls(client)
	await _world(client)
	await _later_revision(client)
	await _limits(client)
	_seed_mid_window(client)
	print("STEP rotate")
	await _rotating(client)
	await _reconnected(client)
	await _unclaimed(client)
	await _refused(url, client.trace)
	print("RESULT ", JSON.stringify({"checks": checks, "failures": failures}))
	quit(0 if failures.is_empty() else 1)


func _calls(client) -> void:
	var echo: Dictionary = await client.call_method("gameService", "echo", {"text": "hi"})
	check(echo.ok and echo.d.text == "hi" and echo.d.userId == "ada", "a call is answered with its data")
	var missing: Dictionary = await client.call_method("gameService", "nope", {})
	check(not missing.ok and missing.e.code == "NOT_FOUND", "a method the service lacks is NOT_FOUND")


func _world(client) -> void:
	check(client.send_channel("gameService", "move", {"dx": 9, "dy": 0}), "a move is written before joining")
	check(not client.is_subscribed("gameService", "ticks"), "no feed held before subscribing")
	var sub: Dictionary = await client.subscribe_stream("gameService", "ticks")
	check(sub.ok and (sub.seed as Array).is_empty(), "the stream's seed is empty: that move was dropped")
	check(client.is_subscribed("gameService", "ticks") and not client.is_subscribed("gameService", "ticks", "elsewhere"), "is_subscribed knows the feed held")
	var unheard := func(payload: Variant) -> void: events.append(["unheard", payload])
	client.on_event("gameService", "moved", unheard)
	check(client.off_event("gameService", "moved", unheard) and not client.off_event("gameService", "moved", unheard), "off_event removes a handler, once")
	var joined: Dictionary = await client.call_method("gameService", "join", {"name": "ada"})
	check(joined.ok and joined.d.players == ["ada"], "joining the world answers its players")
	check(client.presence("world:main") == ["ada"], "qd:presence lists the player")
	client.send_channel("gameService", "move", {"dx": 1, "dy": 0})
	check(await until(func() -> bool: return moved(1) and items.size() == 1), "a move in the world is heard")
	check(events[0][0] == "gameService" and events[0][1] == "moved" and events[0][2].userId == "ada", "as a typed event")
	check(int(items[0].n) == 1, "and a stream item")


## Frames a later revision of protocol 5 may send: fields added to objects
## and elements appended to arrays. The harness adds a field to every
## qd:hello, and sends these frames on "STEP later"; the client reads what it
## knows of each and ignores the rest.
func _later_revision(client) -> void:
	check(client.hello.has("future"), "a qd:hello with a field the client does not know is read")
	var others: Array = []
	var ended: Array = []
	var present: Array = []
	var on_frame := func(event: String, data: Variant) -> void: others.append([event, data])
	var on_revoked := func(frame: Dictionary) -> void: ended.append(frame)
	var on_presence := func(room: String, users: Array) -> void: present.append([room, users])
	client.frame_received.connect(on_frame)
	client.revoked.connect(on_revoked)
	client.presence_changed.connect(on_presence)
	print("STEP later")
	var heard := func() -> bool:
		return moved(7) and items.size() == 2 and others.size() == 1 and ended.size() == 1 and present.size() == 1
	check(await until(heard), "frames with appended elements and added fields are all heard")
	check(int(items[-1].n) == 101, "a qd:stream frame's item, elements appended after it ignored")
	check(present[0][0] == "world:main" and present[0][1] == ["ada", "bo"], "a qd:presence frame with a field more")
	check(others[0][0] == "qd:changed" and ended[0].id == "x", "qd:changed and qd:revoked frames with a field more")
	client.frame_received.disconnect(on_frame)
	client.revoked.disconnect(on_revoked)
	client.presence_changed.disconnect(on_presence)


func _limits(client) -> void:
	var first: int = client.start_call("gameService", "wait", {"ms": 200})
	var second: int = client.start_call("gameService", "wait", {"ms": 200})
	var slow: Dictionary = await client.reply(first)
	var limited: Dictionary = await client.reply(second)
	check(slow.ok and int(slow.d) == 200, "one query runs at a time")
	check(not limited.ok and limited.e.code == "RATE_LIMITED" and int(limited.e.data.retryAfterMs) == 300, "a second one is RATE_LIMITED")
	var early: Dictionary = await client.call_method("gameService", "echo", {"text": "too soon"})
	check(early.e.message == "Backing off after RATE_LIMITED", "the client backs off: the next call is refused unsent")
	await wait_ms(500)
	var later: Dictionary = await client.call_method("gameService", "echo", {"text": "again"})
	check(later.ok, "after the backoff a call goes through")
	var long_call: int = client.start_call("gameService", "wait", {"ms": 5000})
	client.cancel_call(long_call)
	var cancelled: Dictionary = await client.reply(long_call)
	check(not cancelled.ok and cancelled.e.code == "CANCELLED", "a cancelled query answers CANCELLED")


## Seeds the client's random waits so the moment its next draw picks within
## the qd:rotate window falls in its middle: the call made during the window
## then always has the time to be answered. Nothing else draws before it.
func _seed_mid_window(client) -> void:
	var probe := RandomNumberGenerator.new()
	for candidate in 1000:
		probe.seed = candidate
		var moment := probe.randi_range(0, ROTATE_WITHIN_MS)
		if moment >= ROTATE_EARLIEST_MS and moment <= ROTATE_LATEST_MS:
			client.rng.seed = candidate
			return


func _rotating(client) -> void:
	var within: int = await client.rotating
	var started := Time.get_ticks_msec()
	check(within == ROTATE_WITHIN_MS and client.is_ready(), "qd:rotate leaves the socket open")
	var during: Dictionary = await client.call_method("gameService", "echo", {"text": "rotating"})
	check(during.ok and during.d.text == "rotating", "a call during the rotate window is answered")
	await client.connected
	var waited := Time.get_ticks_msec() - started
	check(waited >= ROTATE_EARLIEST_MS and waited < ROTATE_WITHIN_MS + 1000, "the client reconnects at its moment within the window")


func _reconnected(client) -> void:
	var hello: Dictionary = client.hello
	check(hello.userId == "ada", "after qd:rotate the client reconnects with a new handshake")
	check(client.server_id == first_server_id, "the same server, so the same server id")
	check(client.presence("world:main").is_empty(), "the new socket is in no room")
	client.send_channel("gameService", "move", {"dx": 8, "dy": 0})
	var joined: Dictionary = await client.call_method("gameService", "join", {"name": "ada"})
	check(joined.ok, "a call over the new socket joins the world again")
	client.send_channel("gameService", "move", {"dx": 3, "dy": 0})
	check(await until(func() -> bool: return moved(3) and seeds.size() == 2), "a move after joining again is heard")
	check(not moved(9) and not moved(8), "the moves from outside the world were dropped")
	check(seeds[1].size() == 1 and int(seeds[1][0].n) == 1, "the stream was subscribed again, its seed the tick before")
	var refused: Dictionary = await client.subscribe_stream("gameService", "nowhere")
	check(not refused.ok and refused.e.code == "NOT_FOUND", "a stream the service lacks is refused")
	check(not client.is_subscribed("gameService", "nowhere") and client.is_subscribed("gameService", "ticks"), "a refused subscribe holds no feed")
	client.close()


## Answers nobody takes with `reply` are capped, the oldest dropped first;
## here the closed client's refusals, which write no frame.
func _unclaimed(client) -> void:
	var cap: int = load("res://addons/quickdraw/quickdraw_client.gd").MAX_UNCLAIMED_REPLIES
	var ids: Array[int] = []
	for n in cap + 50:
		ids.append(client.start_call("gameService", "echo", {"text": "never sent"}))
	check(client._replies.size() == cap, "answers nobody takes are capped")
	var newest: Dictionary = await client.reply(ids[-1])
	check(not newest.ok and newest.e.message == "Not connected", "the newest is kept for reply")
	var oldest: Dictionary = await client.reply(ids[0])
	check(not oldest.ok and oldest.e.code == "TIMEOUT", "the oldest was dropped")


func _refused(url: String, trace: bool) -> void:
	var other = load("res://addons/quickdraw/quickdraw_client.gd").new()
	other.trace = trace
	root.add_child(other)
	other.connect_to(url, {"token": "nobody"})
	var refusal: Array = await other.refused
	check(refusal[0] == "UNAUTHENTICATED", "a token the server refuses: UNAUTHENTICATED")
	await wait_ms(1500)
	check(not other.is_ready(), "and the client does not reconnect")
