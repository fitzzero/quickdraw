// The frames the GDScript client writes in the checked session
// (`smoke.gd`), byte for byte, pongs aside. The Godot check (`godot.ts`)
// compares what the client wrote with this list; the Node wire test
// (`wire.test.ts`) writes these same strings to the real server. Godot's
// `JSON.stringify` sorts keys and writes integers without a decimal point;
// `godotJson` does the same.

/** JSON as Godot's `JSON.stringify` writes it: compact, keys sorted at every level. */
export function godotJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === "object" && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );
}

/** What the client sends as its handshake's `auth.qd`. */
export const CLIENT = "quickdraw-gdscript/5.0.0";

/** Socket.IO CONNECT with the v5 handshake: `40{auth}`. */
export function connectFrame(token: string): string {
  return `40${godotJson({ token, qd: { protocol: 5, client: CLIENT } })}`;
}

/** A `qd:call` sent with ack id `id`, which is also its call id: `42<id>["qd:call",{...}]`. */
export function callFrame(id: number, method: string, input: unknown): string {
  return `42${String(id)}${godotJson(["qd:call", { id, s: "gameService", m: method, i: input }])}`;
}

/** A `qd:ch` message on `move`. */
export function moveFrame(dx: number, dy: number): string {
  return `42${godotJson(["qd:ch", ["gameService", "move", { dx, dy }]])}`;
}

/** `qd:stream:sub` of `ticks`, sent with ack id `id`. */
export function ticksFrame(id: number): string {
  return `42${String(id)}${godotJson(["qd:stream:sub", { s: "gameService", stream: "ticks" }])}`;
}

/**
 * The session, in order: handshake; a call; a call to a method the service
 * lacks; a move before joining the world (dropped by the server); the ticks
 * stream; joining the world; a move; two concurrent slow queries (the second
 * is RATE_LIMITED, call 6 is then refused by the client itself, unsent) and
 * a call after the backoff; a slow query cancelled; a call during the
 * `qd:rotate` window, on the socket the client keeps until its moment;
 * Socket.IO DISCONNECT at that moment, then the new socket's handshake, its
 * stream resubscription, a move before joining again (dropped), the join and
 * a move; DISCONNECT on `close()`; and a client with a token the server
 * refuses.
 */
export const SESSION: readonly string[] = [
  connectFrame("ada"),
  callFrame(0, "echo", { text: "hi" }),
  callFrame(1, "nope", {}),
  moveFrame(9, 0),
  ticksFrame(2),
  callFrame(3, "join", { name: "ada" }),
  moveFrame(1, 0),
  callFrame(4, "wait", { ms: 200 }),
  callFrame(5, "wait", { ms: 200 }),
  callFrame(7, "echo", { text: "again" }),
  callFrame(8, "wait", { ms: 5000 }),
  `42${godotJson(["qd:cancel", { id: 8 }])}`,
  callFrame(9, "echo", { text: "rotating" }),
  "41",
  connectFrame("ada"),
  ticksFrame(10),
  moveFrame(8, 0),
  callFrame(11, "join", { name: "ada" }),
  moveFrame(3, 0),
  "41",
  connectFrame("nobody"),
];
