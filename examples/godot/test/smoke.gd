extends SceneTree
## Drives the client (the "Quickdraw" autoload) through one session against
## the game server at QD_URL (test/game.ts), writing the frames of
## test/frames.ts in order. Prints every frame with QD_TRACE=1, "STEP rotate"
## when the harness should send qd:rotate, and a last line "RESULT {json}";
## exits 0 when every check held. Run it with `bun run check:godot`.

var failures: Array[String] = []
var checks := 0
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
	await _calls(client)
	await _world(client)
	await _limits(client)
	print("STEP rotate")
	await _reconnected(client)
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
	var sub: Dictionary = await client.subscribe_stream("gameService", "ticks")
	check(sub.ok and (sub.seed as Array).is_empty(), "the stream's seed is empty: that move was dropped")
	var joined: Dictionary = await client.call_method("gameService", "join", {"name": "ada"})
	check(joined.ok and joined.d.players == ["ada"], "joining the world answers its players")
	check(client.presence("world:main") == ["ada"], "qd:presence lists the player")
	client.send_channel("gameService", "move", {"dx": 1, "dy": 0})
	check(await until(func() -> bool: return moved(1) and items.size() == 1), "a move in the world is heard")
	check(events[0][0] == "gameService" and events[0][1] == "moved" and events[0][2].userId == "ada", "as a typed event")
	check(int(items[0].n) == 1, "and a stream item")


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


func _reconnected(client) -> void:
	var hello: Dictionary = await client.connected
	check(hello.userId == "ada", "after qd:rotate the client reconnects with a new handshake")
	check(client.presence("world:main").is_empty(), "the new socket is in no room")
	client.send_channel("gameService", "move", {"dx": 8, "dy": 0})
	var joined: Dictionary = await client.call_method("gameService", "join", {"name": "ada"})
	check(joined.ok, "a call over the new socket joins the world again")
	client.send_channel("gameService", "move", {"dx": 3, "dy": 0})
	check(await until(func() -> bool: return moved(3) and seeds.size() == 2), "a move after joining again is heard")
	check(not moved(9) and not moved(8), "the moves from outside the world were dropped")
	check(seeds[1].size() == 1 and int(seeds[1][0].n) == 1, "the stream was subscribed again, its seed the tick before")
	client.close()


func _refused(url: String, trace: bool) -> void:
	var other = load("res://addons/quickdraw/quickdraw_client.gd").new()
	other.trace = trace
	root.add_child(other)
	other.connect_to(url, {"token": "nobody"})
	var refusal: Array = await other.refused
	check(refusal[0] == "UNAUTHENTICATED", "a token the server refuses: UNAUTHENTICATED")
	await wait_ms(1500)
	check(not other.is_ready(), "and the client does not reconnect")
