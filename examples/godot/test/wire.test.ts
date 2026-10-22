// The wire the GDScript client speaks, checked frame by frame against a real
// server (`game.ts`) over a raw WebSocket, with no Socket.IO client: the
// session `smoke.gd` runs in Godot, written as the same bytes (`frames.ts`),
// with every answer the server sends asserted in turn; then what that
// session does not reach: a refused protocol, the heartbeat, presence and
// events between two players, channel messages that are never
// acknowledged, a peer link over the relay, and host mode: the world's host
// (`host.ts`) serving a player over a link. `bun run check:godot` runs the
// GDScript client itself.

import { afterEach, describe, expect, it } from "vitest";
import {
  connectFrame,
  godotJson,
  hostFrame,
  hostFrames,
  isClockFrame,
  PEER_SIGNAL_ID,
  relayFrame,
  relayHelloFrame,
  SESSION,
} from "./frames";
import { startServer, WORLD, WORLD_ID, type GameServer } from "./game";
import { hostWorld, type WorldHost } from "./host";

const servers: GameServer[] = [];
const sockets: Wire[] = [];
const hosts: WorldHost[] = [];

afterEach(async () => {
  for (const wire of sockets.splice(0)) {
    wire.close();
  }
  for (const host of hosts.splice(0)) {
    host.close();
  }
  await Promise.all(servers.splice(0).map(async (server) => await server.close()));
});

async function start(): Promise<GameServer> {
  const server = await startServer();
  servers.push(server);
  return server;
}

type Match = (frame: string) => boolean;

/** A WebSocket speaking Engine.IO and Socket.IO by hand, as the GDScript client does. */
class Wire {
  readonly frames: string[] = [];
  pings = 0;
  closed = false;
  private readonly waiting = new Set<() => void>();

  private constructor(
    private readonly socket: WebSocket,
    private readonly pong: boolean,
  ) {
    socket.addEventListener("message", (event) => {
      this.receive(String(event.data));
    });
    socket.addEventListener("close", () => {
      this.closed = true;
      this.wake();
    });
  }

  /** Opens `ws://<host>/socket.io/?EIO=4&transport=websocket`; `pong: false` leaves pings unanswered. */
  static async open(server: GameServer, pong = true): Promise<Wire> {
    const url = `${server.url.replace(/^http/, "ws")}/socket.io/?EIO=4&transport=websocket`;
    const socket = new WebSocket(url);
    const wire = new Wire(socket, pong);
    sockets.push(wire);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    return wire;
  }

  private receive(text: string): void {
    if (text === "2") {
      this.pings += 1;
      if (this.pong) {
        this.socket.send("3");
      }
      return;
    }
    this.frames.push(text);
    this.wake();
  }

  private wake(): void {
    for (const wake of this.waiting) {
      wake();
    }
  }

  send(text: string): void {
    this.socket.send(text);
  }

  /** Takes the first frame received, now or within `timeoutMs`, that `match` accepts. */
  async next(match: Match, timeoutMs = 3000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.frames.findIndex(match);
      if (index >= 0) {
        return this.frames.splice(index, 1)[0] ?? "";
      }
      if (this.closed || Date.now() > deadline) {
        throw new Error(`No frame matched; received ${JSON.stringify(this.frames)}`);
      }
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          this.waiting.delete(wake);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(wake, Math.max(1, deadline - Date.now()));
        this.waiting.add(wake);
      });
    }
  }

  /** Resolves once the server closed the WebSocket. */
  async closedWithin(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.closed && Date.now() < deadline) {
      await new Promise((resolve) => {
        setTimeout(resolve, 20);
      });
    }
    return this.closed;
  }

  close(): void {
    this.socket.close();
  }
}

/** A Socket.IO EVENT named `name`: `42["name",payload]`. */
const isEvent =
  (name: string): Match =>
  (frame) =>
    frame.startsWith(`42${JSON.stringify(name)}`) ||
    frame.startsWith(`42[${JSON.stringify(name)},`);

/** The ACK of the event sent with ack id `id`: `43<id>[reply]`. */
const isAck =
  (id: number): Match =>
  (frame) =>
    frame.startsWith(`43${String(id)}[`);

/** The payload of an EVENT, or the reply of an ACK: the array's second or first element. */
function payloadOf(frame: string): unknown {
  const array = JSON.parse(frame.slice(frame.indexOf("["))) as unknown[];
  return frame.startsWith("43") ? array[0] : array[1];
}

/** Opens a socket and connects with `token` (`frames.ts`), up to `qd:hello`; `sid` is the socket's id. */
async function connect(
  server: GameServer,
  token: string,
): Promise<{ wire: Wire; hello: unknown; sid: string }> {
  const wire = await Wire.open(server);
  expect(JSON.parse((await wire.next((frame) => frame.startsWith("0"))).slice(1))).toEqual({
    sid: expect.any(String),
    upgrades: [],
    pingInterval: 300,
    pingTimeout: 1000,
    maxPayload: 1_000_000,
  });
  wire.send(connectFrame(token));
  const connected = await wire.next((frame) => frame.startsWith("40"));
  expect(connected).toMatch(/^40\{"sid":"[\w-]+"\}$/);
  const { sid } = JSON.parse(connected.slice(2)) as { readonly sid: string };
  return { wire, hello: payloadOf(await wire.next(isEvent("qd:hello"))), sid };
}

/** Sends a session frame that asks for an acknowledgement, and resolves with the reply. */
async function ask(wire: Wire, frame: string): Promise<unknown> {
  wire.send(frame);
  const id = Number(/^42(\d+)\[/.exec(frame)?.[1]);
  return payloadOf(await wire.next(isAck(id)));
}

/** The host mode message a `qd:relay` frame carries: its label and its parsed text, or undefined. */
function hostMessageOf(frame: string): { label: string; message: readonly unknown[] } | undefined {
  if (!isEvent("qd:relay")(frame) || isClockFrame(frame)) {
    return undefined;
  }
  const [, , label = "", text = ""] = payloadOf(frame) as readonly string[];
  const message = JSON.parse(text) as readonly unknown[];
  return typeof message[0] === "number" && message[0] >= 3 ? { label, message } : undefined;
}

/** The next host mode message of kind `kind` relayed to `wire`. */
async function hostMessage(wire: Wire, kind: number): Promise<ReturnType<typeof hostMessageOf>> {
  return hostMessageOf(await wire.next((frame) => hostMessageOf(frame)?.message[0] === kind));
}

/**
 * Sends `steer` until the host served `count` steers: `fast` is unreliable,
 * never resent, and dropped wherever a connection is backed up.
 */
async function steerUntil(
  wire: Wire,
  steer: string,
  host: WorldHost,
  count: number,
): Promise<void> {
  for (let attempt = 0; attempt < 20 && host.steers.length < count; attempt += 1) {
    wire.send(steer);
    for (let wait = 0; wait < 10 && host.steers.length < count; wait += 1) {
      await new Promise((resolve) => {
        setTimeout(resolve, 10);
      });
    }
  }
  expect(host.steers.length).toBeGreaterThanOrEqual(count);
}

const moved = (dx: number) => (frame: string) =>
  isEvent("qd:event")(frame) &&
  JSON.stringify(payloadOf(frame)) ===
    JSON.stringify(["gameService", "moved", { userId: "ada", dx, dy: 0 }]);

describe("the GDScript client's session, frame by frame", () => {
  it("handshakes, calls, joins the world and hears it, as smoke.gd does in Godot", async () => {
    const server = await start();
    const { wire, hello } = await connect(server, "ada");
    expect(hello).toEqual({
      protocol: 5,
      server: expect.any(String),
      serverId: expect.any(String),
      limits: {
        maxInFlightQueries: 1,
        maxQueuedQueries: 0,
        maxSubscribeIds: 500,
        callTimeoutMs: 30000,
        subscriptions: {
          maxInFlight: 8,
          maxQueued: 64,
          maxEntityIds: 10000,
          maxScopes: 1000,
          maxTopics: 1000,
        },
        peers: {
          maxLinks: 64,
          maxMessageBytes: 65536,
          relayRate: 120,
          relayBurst: 240,
          relayBytesPerSecond: 1048576,
          relayBytesBurst: 2097152,
        },
      },
      features: ["peer"],
      userId: "ada",
      serviceAccess: {},
    });
    expect(await ask(wire, SESSION[1] ?? "")).toEqual({
      ok: true,
      d: { text: "hi", userId: "ada" },
    });
    expect(await ask(wire, SESSION[2] ?? "")).toEqual({
      ok: false,
      e: { code: "NOT_FOUND", message: 'Unknown method "nope" on service "gameService"' },
    });
    // A move before joining the world: no acknowledgement, and the server drops it.
    wire.send(SESSION[3] ?? "");
    expect(await ask(wire, SESSION[4] ?? "")).toEqual({ ok: true, seed: [] });
    wire.send(SESSION[5] ?? "");
    expect(payloadOf(await wire.next(isEvent("qd:presence")))).toEqual({
      room: WORLD,
      users: ["ada"],
    });
    expect(payloadOf(await wire.next(isAck(3)))).toEqual({ ok: true, d: { players: ["ada"] } });
    wire.send(SESSION[6] ?? "");
    await wire.next(moved(1));
    // [service, stream, scope, item], scope null for a global stream: no key names on the wire.
    const item = await wire.next(isEvent("qd:stream"));
    expect(item).toBe('42["qd:stream",["gameService","ticks",null,{"n":1}]]');
    // rc.3 sent the object { s, stream, scope?, item }: 15 bytes more for this global stream's
    // frame, 28 for a scoped one's (its scope key too), per frame and per subscriber.
    const rc3 = `42${JSON.stringify(["qd:stream", { s: "gameService", stream: "ticks", item: { n: 1 } }])}`;
    expect(Buffer.byteLength(rc3) - Buffer.byteLength(item)).toBe(15);
  });

  it("answers a second query in flight RATE_LIMITED, and a cancelled one CANCELLED", async () => {
    const server = await start();
    const { wire } = await connect(server, "ada");
    wire.send(SESSION[7] ?? "");
    wire.send(SESSION[8] ?? "");
    expect(payloadOf(await wire.next(isAck(5)))).toEqual({
      ok: false,
      e: {
        code: "RATE_LIMITED",
        message: "Too many queries in flight on this connection",
        data: { retryAfterMs: 300 },
      },
    });
    expect(payloadOf(await wire.next(isAck(4)))).toEqual({ ok: true, d: 200 });
    // The client sends nothing for call 6: it backs off for retryAfterMs and some.
    expect(await ask(wire, SESSION[9] ?? "")).toEqual({
      ok: true,
      d: { text: "again", userId: "ada" },
    });
    wire.send(SESSION[10] ?? "");
    wire.send(SESSION[11] ?? "");
    expect(payloadOf(await wire.next(isAck(8)))).toEqual({
      ok: false,
      e: { code: "CANCELLED", message: "The call was cancelled" },
    });
  });

  it("answers calls during a rotate window, then a new socket handshakes, resubscribes and must join again", async () => {
    const server = await start();
    const first = await connect(server, "ada");
    await ask(first.wire, SESSION[4] ?? "");
    await ask(first.wire, SESSION[5] ?? "");
    first.wire.send(SESSION[6] ?? "");
    await first.wire.next(moved(1));
    server.server.rotate({ withinMs: 1000 });
    expect(payloadOf(await first.wire.next(isEvent("qd:rotate")))).toEqual({ withinMs: 1000 });
    // The socket stays the client's until its moment within the window: a call is answered.
    expect(await ask(first.wire, SESSION[12] ?? "")).toEqual({
      ok: true,
      d: { text: "rotating", userId: "ada" },
    });
    // At the moment: Socket.IO DISCONNECT, then the client closes the WebSocket itself.
    first.wire.send(SESSION[13] ?? "");
    first.wire.close();

    const { wire } = await connect(server, "ada");
    expect(await ask(wire, SESSION[15] ?? "")).toEqual({ ok: true, seed: [{ n: 1 }] });
    // Not in the world yet: the new socket's move is dropped.
    wire.send(SESSION[16] ?? "");
    expect(await ask(wire, SESSION[17] ?? "")).toEqual({ ok: true, d: { players: ["ada"] } });
    wire.send(SESSION[18] ?? "");
    await wire.next(moved(3));
    expect(payloadOf(await wire.next(isEvent("qd:stream")))).toEqual([
      "gameService",
      "ticks",
      null,
      { n: 2 },
    ]);
    expect(wire.frames.filter((frame) => moved(8)(frame) || moved(9)(frame))).toEqual([]);
    // A stream the service lacks is refused: the client then holds no feed (finding F6.6).
    expect(await ask(wire, SESSION[19] ?? "")).toMatchObject({
      ok: false,
      e: { code: "NOT_FOUND" },
    });
    wire.send(SESSION[20] ?? "");
    wire.close();
    await expect.poll(async () => await server.server.presence.users(WORLD)).toEqual([]);
  });

  it("refuses a token the server does not know with UNAUTHENTICATED", async () => {
    const server = await start();
    const wire = await Wire.open(server);
    await wire.next((frame) => frame.startsWith("0"));
    wire.send(SESSION[21] ?? "");
    expect(await wire.next((frame) => frame.startsWith("44"))).toBe(
      '44{"message":"Authentication failed","data":{"code":"UNAUTHENTICATED"}}',
    );
  });
});

describe("the wire beyond the session", () => {
  it("refuses a client that speaks another protocol, or a 4.x client without auth.qd", async () => {
    const server = await start();
    for (const auth of [{ qd: { protocol: 4, client: "old" }, token: "ada" }, { token: "ada" }]) {
      const wire = await Wire.open(server);
      await wire.next((frame) => frame.startsWith("0"));
      wire.send(`40${godotJson(auth)}`);
      expect(await wire.next((frame) => frame.startsWith("44"))).toBe(
        '44{"message":"This server speaks quickdraw protocol 5","data":{"code":"PROTOCOL_MISMATCH","expected":5}}',
      );
    }
  });

  it("pings every pingInterval, and closes a client that stops answering", async () => {
    const server = await start();
    const { wire } = await connect(server, "ada");
    const silent = await Wire.open(server, false);
    await silent.next((frame) => frame.startsWith("0"));
    silent.send(connectFrame("bo"));
    await silent.next(isEvent("qd:hello"));
    // pingInterval 300 ms and pingTimeout 1,000 ms: the silent socket is gone well within 2 s.
    expect(await silent.closedWithin(2500)).toBe(true);
    expect(silent.pings).toBeGreaterThanOrEqual(1);
    expect(wire.pings).toBeGreaterThanOrEqual(3);
    expect(wire.closed).toBe(false);
  });

  it("tells each player who joins and leaves the world, and relays the other's moves", async () => {
    const server = await start();
    const ada = (await connect(server, "ada")).wire;
    await ask(ada, SESSION[5] ?? "");
    await ada.next(isEvent("qd:presence"));
    const bo = (await connect(server, "bo")).wire;
    const join = `420${godotJson(["qd:call", { id: 0, s: "gameService", m: "join", i: { name: "bo" } }])}`;
    expect(await ask(bo, join)).toEqual({ ok: true, d: { players: ["ada", "bo"] } });
    expect(payloadOf(await bo.next(isEvent("qd:presence")))).toEqual({
      room: WORLD,
      users: ["ada", "bo"],
    });
    expect(payloadOf(await ada.next(isEvent("qd:presence")))).toEqual({
      room: WORLD,
      joined: "bo",
    });
    bo.send(`42${godotJson(["qd:ch", ["gameService", "move", { dx: 0, dy: 5 }]])}`);
    expect(payloadOf(await ada.next(isEvent("qd:event")))).toEqual([
      "gameService",
      "moved",
      { userId: "bo", dx: 0, dy: 5 },
    ]);
    bo.close();
    expect(payloadOf(await ada.next(isEvent("qd:presence")))).toEqual({ room: WORLD, left: "bo" });
  });

  it("never acknowledges qd:ch, even when asked", async () => {
    const server = await start();
    const { wire } = await connect(server, "ada");
    await ask(wire, SESSION[5] ?? "");
    wire.send(`4277${godotJson(["qd:ch", ["gameService", "move", { dx: 1, dy: 0 }]])}`);
    await wire.next(moved(1));
    expect(await ask(wire, SESSION[1] ?? "")).toMatchObject({ ok: true });
    expect(wire.frames.filter(isAck(77))).toEqual([]);
  });

  it("links two players over the relay, as the client answers a peer that offers one", async () => {
    const server = await start();
    const ada = await connect(server, "ada");
    await ask(ada.wire, SESSION[5] ?? "");
    const bo = await connect(server, "bo");
    const join = `420${godotJson(["qd:call", { id: 0, s: "gameService", m: "join", i: { name: "bo" } }])}`;
    await ask(bo.wire, join);
    // Bo, without WebRTC, offers a link over the relay; the client hears a request with his user.
    const offer = `421${godotJson(["qd:peer", { room: WORLD, to: ada.sid, sig: { relay: true } }])}`;
    expect(await ask(bo.wire, offer)).toEqual({ ok: true });
    expect(payloadOf(await ada.wire.next(isEvent("qd:peer")))).toEqual({
      room: WORLD,
      from: bo.sid,
      userId: "bo",
      sig: { relay: true },
    });
    // The client answers with the frame `peer_link` writes, then relays its messages.
    expect(await ask(ada.wire, relayHelloFrame(bo.sid))).toEqual({ ok: true });
    expect(relayHelloFrame(bo.sid)).toMatch(new RegExp(`^42${String(PEER_SIGNAL_ID)}\\[`));
    expect(payloadOf(await bo.wire.next(isEvent("qd:peer")))).toEqual({
      room: WORLD,
      from: ada.sid,
      userId: "ada",
      sig: { relay: true },
    });
    ada.wire.send(relayFrame(bo.sid, "rel", { hi: "bo" }));
    expect(payloadOf(await bo.wire.next(isEvent("qd:relay")))).toEqual([
      WORLD,
      ada.sid,
      "rel",
      '[0,{"hi":"bo"}]',
    ]);
    const ping = `42${godotJson(["qd:relay", [WORLD, bo.sid, "fast", "[1,1234]"]])}`;
    expect([isClockFrame(ping), isClockFrame(relayFrame(bo.sid, "fast", 1))]).toEqual([
      true,
      false,
    ]);
    ada.wire.send(ping);
    expect(payloadOf(await bo.wire.next(isEvent("qd:relay")))).toEqual([
      WORLD,
      ada.sid,
      "fast",
      "[1,1234]",
    ]);
    // Bo leaves: the server tells the client bye for him.
    bo.wire.close();
    expect(payloadOf(await ada.wire.next(isEvent("qd:peer")))).toEqual({
      room: WORLD,
      from: bo.sid,
      userId: "bo",
      sig: { bye: true },
    });
  });

  it("refuses a peer signal from outside the room, and relays nothing there", async () => {
    const server = await start();
    const ada = await connect(server, "ada");
    await ask(ada.wire, SESSION[5] ?? "");
    const bo = await connect(server, "bo");
    expect(
      await ask(
        bo.wire,
        `421${godotJson(["qd:peer", { room: WORLD, to: ada.sid, sig: { relay: true } }])}`,
      ),
    ).toMatchObject({
      ok: false,
      e: { code: "FORBIDDEN" },
    });
    bo.wire.send(`42${godotJson(["qd:relay", [WORLD, ada.sid, "rel", "[0,1]"]])}`);
    expect(await ask(ada.wire, SESSION[1] ?? "")).toMatchObject({ ok: true });
    expect(
      ada.wire.frames.filter((frame) => isEvent("qd:peer")(frame) || isEvent("qd:relay")(frame)),
    ).toEqual([]);
  });

  it("serves a player from the world's host, as the client links to it, subscribes, steers and unsubscribes", async () => {
    const server = await start();
    const ada = await connect(server, "ada");
    await ask(ada.wire, SESSION[5] ?? "");
    const host = await hostWorld(server);
    hosts.push(host);
    expect(payloadOf(await ada.wire.next(isEvent("qd:host")))).toEqual([WORLD, host.socketId]);
    // The client offers the host a link over the relay, with the frames of `hostFrames`; the host answers.
    const [hello = "", subscribe = "", steer = "", unsubscribe = ""] = hostFrames(host.socketId);
    expect(await ask(ada.wire, hello)).toEqual({ ok: true });
    expect(payloadOf(await ada.wire.next(isEvent("qd:peer")))).toEqual({
      room: WORLD,
      from: host.socketId,
      userId: "bo",
      sig: { relay: true },
    });
    ada.wire.send(subscribe);
    expect(await hostMessage(ada.wire, 6)).toEqual({
      label: "rel",
      message: [6, "gameService", "world", WORLD_ID, [{ tick: 0, by: "" }], true],
    });
    await steerUntil(ada.wire, steer, host, 1);
    expect(await hostMessage(ada.wire, 7)).toEqual({
      label: "rel",
      message: [7, "gameService", "world", WORLD_ID, { tick: 1, by: "ada" }],
    });
    expect(host.steers[0]).toEqual([{ worldId: WORLD_ID, dx: 2 }, "ada"]);
    // Unsubscribed, the client hears no item for its next steer. The link
    // keeps the order of `rel`: the host refused the subscribe that follows
    // the unsubscribe after it, and the seed of a new one comes after the steer.
    ada.wire.send(unsubscribe);
    ada.wire.send(hostFrame(host.socketId, "rel", [4, "gameService", "world", "elsewhere"]));
    expect(await hostMessage(ada.wire, 8)).toEqual({
      label: "rel",
      message: [
        8,
        "gameService",
        "world",
        "elsewhere",
        {
          code: "FORBIDDEN",
          message: 'The feed of scope "elsewhere" is served by the host of another room',
        },
      ],
    });
    const mark = ada.wire.frames.length;
    const steered = host.steers.length;
    await steerUntil(ada.wire, steer, host, steered + 1);
    ada.wire.send(subscribe);
    expect(await hostMessage(ada.wire, 6)).toEqual({
      label: "rel",
      message: [6, "gameService", "world", WORLD_ID, [{ tick: host.steers.length, by: "" }], true],
    });
    expect(
      ada.wire.frames.slice(mark).filter((frame) => hostMessageOf(frame) !== undefined),
    ).toEqual([]);
    // The host disconnects: the server says bye for it, then that the world has no host.
    host.close();
    expect(payloadOf(await ada.wire.next(isEvent("qd:host")))).toEqual([WORLD, null]);
    expect(ada.wire.frames.filter(isEvent("qd:peer")).map(payloadOf)).toEqual([
      { room: WORLD, from: host.socketId, userId: "bo", sig: { bye: true } },
    ]);
  });
});
