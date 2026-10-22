// The frames the GDScript client writes in the checked session
// (`smoke.gd`), byte for byte, pongs and peer link clock pings aside. The
// Godot check (`godot.ts`) compares what the client wrote with this list; the
// Node wire test (`wire.test.ts`) writes these same strings to the real
// server. Godot's `JSON.stringify` sorts keys and writes integers without a
// decimal point; `godotJson` does the same.

import { WORLD, WORLD_ID } from "./game";

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

/** `qd:stream:sub` of a stream the service lacks, sent with ack id `id`: refused, `NOT_FOUND`. */
export function nowhereFrame(id: number): string {
  return `42${String(id)}${godotJson(["qd:stream:sub", { s: "gameService", stream: "nowhere" }])}`;
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
 * a move, a subscribe to a stream the service lacks (refused, so not held);
 * DISCONNECT on `close()`; and a client with a token the server refuses.
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
  nowhereFrame(12),
  "41",
  connectFrame("nobody"),
];

/** The ack id of the client's peer signal in the session: the next after `nowhereFrame(12)`. */
export const PEER_SIGNAL_ID = 13;

/** The client's `qd:peer` to `peer`: it runs the link over the relay. */
export function relayHelloFrame(peer: string, id = PEER_SIGNAL_ID): string {
  return `42${String(id)}${godotJson(["qd:peer", { room: WORLD, to: peer, sig: { relay: true } }])}`;
}

/** A link message `[0, data]` the client relays to `peer` on `label`. */
export function relayFrame(peer: string, label: "rel" | "fast", data: unknown): string {
  return `42${godotJson(["qd:relay", [WORLD, peer, label, godotJson([0, data])]])}`;
}

/** True for a peer link's clock ping or pong: timed, so never compared. */
export function isClockFrame(frame: string): boolean {
  return /^42\["qd:relay",\["[^"]*","[^"]*","fast","\[[12],/.test(frame);
}

/** The ack id of the client's signal to the world's host: the next after the peer link's. */
export const HOST_SIGNAL_ID = PEER_SIGNAL_ID + 1;

/** A host mode message (`[3, ...]` to `[5, ...]`) the client relays to the world's host at `host` on `label`. */
export function hostFrame(
  host: string,
  label: "rel" | "fast",
  message: readonly unknown[],
): string {
  return `42${godotJson(["qd:relay", [WORLD, host, label, godotJson(message)]])}`;
}

/**
 * The client's steer to the world's host at `host`, on `fast`: unreliable,
 * so `smoke.gd` sends it again until the host's item arrives.
 */
export function steerFrame(host: string): string {
  return hostFrame(host, "fast", [3, "gameService", "steer", { worldId: WORLD_ID, dx: 2 }]);
}

/**
 * The client's frames to the world's host at socket `host` (`host.ts`): it
 * links over the relay, subscribes to the `world` stream once the link is
 * open, steers, and unsubscribes. It sends no bye: the host disconnects.
 */
export function hostFrames(host: string): readonly string[] {
  return [
    relayHelloFrame(host, HOST_SIGNAL_ID),
    hostFrame(host, "rel", [4, "gameService", "world", WORLD_ID]),
    steerFrame(host),
    hostFrame(host, "rel", [5, "gameService", "world", WORLD_ID]),
  ];
}

/** Where the peer link's and host mode's frames fall in the session: before the DISCONNECT of `close()`. */
const PEER_AT = 20;

/**
 * The session with the link to the harness's player at socket `peer`
 * (`godot.ts`), where the client answers its offer over the relay, then
 * says hello back on `rel` and the player closes the link; then host mode,
 * with the world's host at socket `host`.
 */
export function sessionWith(peer: string, host: string): readonly string[] {
  return [
    ...SESSION.slice(0, PEER_AT),
    relayHelloFrame(peer),
    relayFrame(peer, "rel", { hi: "bo" }),
    ...hostFrames(host),
    ...SESSION.slice(PEER_AT),
  ];
}
