// Peer links on the server (RFC 0003 section 12.5): a server created with
// `peers: true` forwards `qd:peer` signals between two signed-in sockets of
// one app room, with the sender's user, and relays `qd:relay` link messages
// between two sockets that signalled each other, within a per-peer rate and
// a per-socket byte budget; a socket that floods either is disconnected, and
// a socket that leaves a room, is taken out of it or disconnects says `bye`
// to the peers it signalled there and to those that signalled it. Without
// `peers`, the server serves none of it.
//
// In the cluster projects (`bun run test:cluster`) both sockets of a test
// sit on one node; the peered-bus tests at the end, and
// `test/cluster/peers.test.ts` behind Valkey, put them on two.

import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { inCluster } from "../../../test/cluster/mode";
import type { PeerForwardFrame, RelayForwardFrame } from "../../protocol/envelope";
import {
  MAX_PEER_LINKS,
  MAX_PEER_MESSAGE_BYTES,
  PEER_RELAY_BURST,
  PEER_RELAY_BYTES_BURST,
  PEER_RELAY_BYTES_PER_SECOND,
  PEER_RELAY_FAST_BACKLOG,
  PEER_RELAY_RATE,
  PEER_SIGNAL_BURST,
} from "../../protocol/version";
import { createTestApp, type TestApp } from "../../testing/index";
import { alice, bob, captureLogger, type AppPrincipal } from "../__tests__/fixtures";
import type { Hub } from "../emit/hub";
import { peeredCluster } from "../transports/__tests__/harness";
import type { QuickdrawServerSocket } from "../transports/types";
import {
  carol,
  defineLobbyService,
  GAME,
  message,
  OFFER,
  peerOf,
  settle,
  type Peer,
} from "./__tests__/peers";
import { sendRelay } from "./peerDelivery";
import { disengage, engage, hear, MAX_HEARD, pairOf, peersOf } from "./peerState";

const apps: TestApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

interface StartOptions {
  readonly peers?: boolean;
  readonly logger?: ReturnType<typeof captureLogger>;
  readonly bus?: ReturnType<typeof peeredCluster>;
  readonly rateLimit?: { readonly maxRequests: number };
}

async function start(options: StartOptions = {}) {
  const { bus, logger, rateLimit } = options;
  const app = await createTestApp({
    services: [defineLobbyService()],
    peers: options.peers ?? true,
    ...(logger === undefined ? {} : { logger }),
    ...(bus === undefined ? {} : { socket: { adapter: bus.adapter } }),
    ...(rateLimit === undefined ? {} : { rateLimit }),
  });
  apps.push(app as unknown as TestApp);
  bus?.servers.push(app.server.io);
  return app;
}

type App = Awaited<ReturnType<typeof start>>;

type Player = Peer<Awaited<ReturnType<App["connect"]>>>;

/** A socket acting as `principal`, in app room `room` unless `null`. */
async function player(
  app: App,
  principal: AppPrincipal | null,
  room: string | null = GAME,
): Promise<Player> {
  const connection = await app.connect(principal);
  if (room !== null) {
    await (principal === null
      ? connection.call.lobbyService.enterAnyone({ room })
      : connection.call.lobbyService.enter({ room }));
  }
  return peerOf(connection);
}

/** Two players who signalled each other in `room`, so each may relay to the other. */
async function linked(app: App, room = GAME): Promise<readonly [Player, Player]> {
  const a = await player(app, alice, room);
  const b = await player(app, bob, room);
  expect(await a.signal(room, b.id, OFFER)).toEqual({ ok: true });
  expect(await b.signal(room, a.id, { relay: true })).toEqual({ ok: true });
  await settle(a, b);
  return [a, b];
}

const ok = { ok: true };

function refused(code: string): unknown {
  return { ok: false, e: expect.objectContaining({ code }) };
}

const bye = (room: string, from: Peer, userId: string): PeerForwardFrame => ({
  room,
  from: from.id,
  userId,
  sig: { bye: true },
});

describe("the hello", () => {
  it("announces peer links and their limits on a server created with peers: true", async () => {
    const app = await start();
    const { hello } = await app.connect(alice);
    expect(hello.features).toEqual(["peer"]);
    expect(hello.limits.peers).toEqual({
      maxLinks: MAX_PEER_LINKS,
      maxMessageBytes: MAX_PEER_MESSAGE_BYTES,
      relayRate: PEER_RELAY_RATE,
      relayBurst: PEER_RELAY_BURST,
      relayBytesPerSecond: PEER_RELAY_BYTES_PER_SECOND,
      relayBytesBurst: PEER_RELAY_BYTES_BURST,
    });
  });

  it("announces none on a server without peers, which forwards nothing", async () => {
    const app = await start({ peers: false });
    const a = await player(app, alice);
    const b = await player(app, bob);
    expect(a.connection.socket.connected).toBe(true);
    const { hello } = await app.connect(carol);
    expect(hello.features).toEqual([]);
    expect(hello.limits.peers).toBeUndefined();
    // No listener: the signal is never acknowledged.
    await expect(
      Promise.race([
        a.signal(GAME, b.id, OFFER),
        new Promise((_resolve, reject) => {
          setTimeout(() => {
            reject(new Error("no answer"));
          }, 300);
        }),
      ]),
    ).rejects.toThrow("no answer");
    a.relay(GAME, b.id, "rel", message(1));
    await settle(a, b);
    expect([b.signals, b.relayed]).toEqual([[], []]);
  });

  it("refuses a peers option that is not a boolean", async () => {
    await expect(
      createTestApp({ services: [defineLobbyService()], peers: "yes" as unknown as boolean }),
    ).rejects.toThrow("createServer: peers must be true or false");
  });
});

describe("signals", () => {
  it("forward between two sockets of one room, naming the sender's user", async () => {
    const app = await start();
    const a = await player(app, alice);
    const b = await player(app, bob);
    expect(await a.signal(GAME, b.id, OFFER)).toEqual(ok);
    const candidate = { candidate: "candidate:1 1 udp 2122260223 10.0.0.2 51000 typ host" };
    expect(await b.signal(GAME, a.id, { ice: { ...candidate, sdpMid: "0" } })).toEqual(ok);
    await settle(a, b);
    expect(b.signals).toEqual([{ room: GAME, from: a.id, userId: "alice", sig: OFFER }]);
    expect(a.signals).toEqual([
      { room: GAME, from: b.id, userId: "bob", sig: { ice: { ...candidate, sdpMid: "0" } } },
    ]);
  });

  it("carry only what the server read: fields it does not know stay behind", async () => {
    const app = await start();
    const a = await player(app, alice);
    const b = await player(app, bob);
    const ice = { candidate: "candidate:2", sdpMLineIndex: 0, usernameFragment: null };
    expect(await a.signal(GAME, b.id, { ice: { ...ice, extra: "x" }, future: 1 })).toEqual(ok);
    await settle(a, b);
    expect(b.signals).toEqual([{ room: GAME, from: a.id, userId: "alice", sig: { ice } }]);
  });

  it("are refused from outside the room, to a socket outside it, to itself, and anonymous", async () => {
    const app = await start();
    const a = await player(app, alice);
    const b = await player(app, bob);
    const outside = await player(app, carol, null);
    const anonymous = await player(app, null);
    expect(await outside.signal(GAME, b.id, OFFER)).toEqual(refused("FORBIDDEN"));
    expect(await a.signal(GAME, outside.id, OFFER)).toEqual(refused("NOT_FOUND"));
    expect(await a.signal(GAME, anonymous.id, OFFER)).toEqual(refused("NOT_FOUND"));
    expect(await a.signal(GAME, a.id, OFFER)).toEqual(refused("VALIDATION"));
    expect(await anonymous.signal(GAME, b.id, OFFER)).toEqual(refused("UNAUTHENTICATED"));
    await settle(a, b, outside, anonymous);
    expect([a.signals, b.signals, outside.signals, anonymous.signals]).toEqual([[], [], [], []]);
  });

  it("are refused when malformed: one known member, each well formed", async () => {
    const app = await start();
    const a = await player(app, alice);
    const b = await player(app, bob);
    for (const sig of [
      { ...OFFER, bye: true },
      { sdp: { type: "pranswer", sdp: "" } },
      { relay: false },
      { ice: { candidate: 7 } },
      { sdp: { type: "offer", sdp: "x".repeat(16_385) } },
      { ice: { candidate: "c".repeat(1025) } },
      { ice: { candidate: "c", usernameFragment: "u".repeat(1025) } },
      {},
    ]) {
      expect(await a.signal(GAME, b.id, sig)).toEqual(refused("VALIDATION"));
    }
    const frames = [null, [GAME, b.id, OFFER], { room: "", to: b.id, sig: OFFER }];
    for (const frame of frames) {
      const answer = await new Promise((resolve) => {
        a.connection.socket.emit("qd:peer", frame, resolve);
      });
      expect(answer).toEqual(refused("VALIDATION"));
    }
    await settle(a, b);
    expect(b.signals).toEqual([]);
  });

  it("to a socket no node of a single server holds are NOT_FOUND; behind a cluster they go out", async () => {
    const app = await start();
    const a = await player(app, alice);
    const answer = await a.signal(GAME, "abcdefghijklmnopqrst", OFFER);
    expect(answer).toEqual(inCluster() ? ok : refused("NOT_FOUND"));
  });

  it("are held to the socket's rate, with the wait in the refusal", async () => {
    const app = await start();
    const a = await player(app, alice);
    const b = await player(app, bob);
    const answers = await Promise.all(
      Array.from({ length: PEER_SIGNAL_BURST + 5 }, async () => await a.signal(GAME, b.id, OFFER)),
    );
    const passed = answers.filter((answer) => answer.ok).length;
    expect(passed).toBeGreaterThanOrEqual(PEER_SIGNAL_BURST);
    expect(passed).toBeLessThan(PEER_SIGNAL_BURST + 5);
    expect(answers.at(-1)).toEqual({
      ok: false,
      e: {
        code: "RATE_LIMITED",
        message: "Too many peer signals from this socket",
        data: { retryAfterMs: expect.any(Number) as number },
      },
    });
  });

  it("end the pair here when a bye comes over the rate, though the peer is not told", async () => {
    const app = await start();
    const [a, b] = await linked(app);
    const answers = await Promise.all([
      ...Array.from({ length: PEER_SIGNAL_BURST + 5 }, () => a.signal(GAME, b.id, OFFER)),
      a.signal(GAME, b.id, { bye: true }),
    ]);
    expect(answers.at(-1)).toEqual(refused("RATE_LIMITED"));
    const aSocket = app.server.io.sockets.sockets.get(a.id);
    expect(aSocket === undefined ? "gone" : pairOf(peersOf(aSocket), GAME, b.id)).toBeUndefined();
  });

  it("say bye past the socket rate limiter, uncounted: the pair ends and the peer hears it", async () => {
    const app = await start({ rateLimit: { maxRequests: 4 } });
    const [a, b] = await linked(app);
    let answer = await a.signal(GAME, b.id, OFFER);
    for (let n = 0; n < 10 && answer.ok; n += 1) {
      answer = await a.signal(GAME, b.id, OFFER);
    }
    expect(answer).toEqual({
      ok: false,
      e: {
        code: "RATE_LIMITED",
        message: "Rate limit exceeded",
        data: expect.anything() as object,
      },
    });
    expect(await a.signal(GAME, b.id, { bye: true })).toEqual(ok);
    await settle(a, b);
    expect(b.signals.at(-1)).toEqual(bye(GAME, a, "alice"));
    const aSocket = app.server.io.sockets.sockets.get(a.id);
    expect(aSocket === undefined ? "gone" : pairOf(peersOf(aSocket), GAME, b.id)).toBeUndefined();
  });

  it("disconnect a socket that keeps sending far over the rate", async () => {
    const logger = captureLogger();
    const app = await start({ logger });
    const a = await player(app, alice);
    const b = await player(app, bob);
    const gone = new Promise<string>((resolve) => {
      a.connection.socket.once("disconnect", resolve);
    });
    // 20 signals a second: more than 2,000 refused within 10 s is a flood.
    for (let n = 0; n < 2_100; n += 1) {
      a.connection.socket.emit("qd:peer", { room: GAME, to: b.id, sig: OFFER });
    }
    expect(await gone).toBe("io server disconnect");
    expect(logger.at("warn").map((entry) => entry.message)).toEqual([
      expect.stringContaining("for sustained flooding of qd:peer"),
    ]);
  });
});

describe("relay", () => {
  it("passes a link message only between two sockets that signalled each other, in order, with the sender's id", async () => {
    const app = await start();
    const a = await player(app, alice);
    const b = await player(app, bob);
    a.relay(GAME, b.id, "rel", message("before"));
    await settle(a);
    expect(await a.signal(GAME, b.id, OFFER)).toEqual(ok);
    // Bob has not answered: neither side's messages go anywhere yet.
    a.relay(GAME, b.id, "rel", message("unanswered"));
    b.relay(GAME, a.id, "rel", message("unasked"));
    await settle(a, b);
    expect(await b.signal(GAME, a.id, { relay: true })).toEqual(ok);
    await settle(a, b);
    a.relay(GAME, b.id, "rel", message({ n: 1 }));
    await settle(a, b);
    // Volatile: sent while Bob's connection is not writing, or dropped.
    a.relay(GAME, b.id, "fast", message({ n: 2 }));
    b.relay(GAME, a.id, "rel", message("answered"));
    await settle(a, b);
    expect(b.relayed).toEqual<RelayForwardFrame[]>([
      [GAME, a.id, "rel", message({ n: 1 })],
      [GAME, a.id, "fast", message({ n: 2 })],
    ]);
    expect(a.relayed).toEqual([[GAME, b.id, "rel", message("answered")]]);
  });

  it("drops a message over the size limit, counted in UTF-8 bytes", async () => {
    const app = await start();
    const [a, b] = await linked(app);
    a.relay(GAME, b.id, "rel", "x".repeat(MAX_PEER_MESSAGE_BYTES + 1));
    // Fewer units than the limit, more bytes: "é" is two.
    a.relay(GAME, b.id, "rel", "é".repeat(MAX_PEER_MESSAGE_BYTES / 2 + 1));
    a.relay(GAME, b.id, "rel", "y".repeat(MAX_PEER_MESSAGE_BYTES));
    a.relay(GAME, b.id, "nope" as "rel", message(1));
    await settle(a, b);
    expect(b.relayed.map(([, , , text]) => text.length)).toEqual([MAX_PEER_MESSAGE_BYTES]);
  });

  it("holds each pair to its rate", async () => {
    const app = await start();
    const [a, b] = await linked(app);
    for (let n = 0; n < PEER_RELAY_BURST + 60; n += 1) {
      a.relay(GAME, b.id, "rel", message(n));
    }
    await settle(a, b);
    // The burst, and what the rate refilled while they arrived.
    expect(b.relayed.length).toBeGreaterThanOrEqual(PEER_RELAY_BURST);
    expect(b.relayed.length).toBeLessThan(PEER_RELAY_BURST + 20);
    expect(b.relayed.map(([, , , text]) => text).slice(0, 3)).toEqual([0, 1, 2].map(message));
  });

  it("holds a socket's bytes to one budget across its peers", async () => {
    const app = await start();
    const a = await player(app, alice);
    const b = await player(app, bob);
    const c = await player(app, carol);
    expect(await a.signal(GAME, b.id, OFFER)).toEqual(ok);
    expect(await a.signal(GAME, c.id, OFFER)).toEqual(ok);
    expect(await b.signal(GAME, a.id, { relay: true })).toEqual(ok);
    expect(await c.signal(GAME, a.id, { relay: true })).toEqual(ok);
    await settle(a, b, c);
    const text = message("z".repeat(59_990));
    for (let n = 0; n < 20; n += 1) {
      a.relay(GAME, b.id, "rel", text);
      a.relay(GAME, c.id, "rel", text);
    }
    await settle(a, b, c);
    const delivered = b.relayed.length + c.relayed.length;
    const fit = Math.floor(PEER_RELAY_BYTES_BURST / text.length);
    expect(delivered).toBeGreaterThanOrEqual(fit);
    expect(delivered).toBeLessThan(fit + 4);
    expect(Math.abs(b.relayed.length - c.relayed.length)).toBeLessThanOrEqual(1);
  });

  it("disconnects a socket that floods it", async () => {
    const logger = captureLogger();
    const app = await start({ logger });
    const a = await player(app, alice);
    const b = await player(app, bob);
    const gone = new Promise<string>((resolve) => {
      a.connection.socket.once("disconnect", resolve);
    });
    // Never signalled: every one is dropped, and past 100 times the rate within 10 s it is a flood.
    // A socket id nobody holds, or one that never answered, is the same.
    for (let n = 0; n <= PEER_RELAY_RATE * 100; n += 1) {
      a.relay(GAME, b.id, "fast", "[1,0]");
    }
    expect(await gone).toBe("io server disconnect");
    expect(logger.at("warn").map((entry) => entry.message)).toEqual([
      expect.stringContaining("for sustained flooding of qd:relay"),
    ]);
  });

  it("drops a fast message only while the target's connection is backed up, never a rel one", () => {
    const sent: string[] = [];
    const conn = new EventEmitter();
    const target = {
      connected: true,
      data: { protocol: 5, principal: bob, appRooms: { [GAME]: true } },
      conn,
      emit: (_event: string, frame: RelayForwardFrame) => sent.push(frame[3]),
    };
    const hub = {
      io: { sockets: { sockets: new Map([["target", target]]) } },
      probe: { local: () => true },
    } as unknown as Hub;
    // Two at once both go: the count only grows while nothing drains.
    for (let n = 0; n <= PEER_RELAY_FAST_BACKLOG; n += 1) {
      sendRelay(hub, "target", [GAME, "source", "fast", message(n)]);
    }
    sendRelay(hub, "target", [GAME, "source", "rel", message("rel")]);
    expect(sent).toEqual([
      ...Array.from({ length: PEER_RELAY_FAST_BACKLOG }, (_, n) => message(n)),
      message("rel"),
    ]);
    conn.emit("drain");
    sendRelay(hub, "target", [GAME, "source", "fast", message("after")]);
    expect(sent.at(-1)).toBe(message("after"));
  });
});

describe("ending links", () => {
  it("tells the peers a socket signalled when it leaves the room", async () => {
    const app = await start();
    const [a, b] = await linked(app);
    await b.connection.call.lobbyService.exit({ room: GAME });
    await settle(a, b);
    expect(a.signals.at(-1)).toEqual(bye(GAME, b, "bob"));
    // Alice's side of the pair ended with it: her messages to Bob go nowhere.
    a.relay(GAME, b.id, "rel", message("gone"));
    await settle(a, b);
    expect(b.relayed).toEqual([]);
  });

  it("tells them when a socket is taken out of the room, or disconnects", async () => {
    const app = await start();
    const [a, b] = await linked(app);
    const c = await player(app, carol);
    expect(await c.signal(GAME, a.id, OFFER)).toEqual(ok);
    await a.connection.call.lobbyService.kick({ room: GAME, userId: "bob" });
    await settle(a, b, c);
    expect(a.signals.at(-1)).toEqual(bye(GAME, b, "bob"));
    c.connection.socket.disconnect();
    await settle(a);
    expect(a.signals.at(-1)).toEqual(bye(GAME, c, "carol"));
  });

  it("tells only the peers it signalled, and only for the room it left", async () => {
    const app = await start();
    const [a, b] = await linked(app);
    await a.connection.call.lobbyService.enter({ room: "game:2" });
    await b.connection.call.lobbyService.enter({ room: "game:2" });
    expect(await b.signal("game:2", a.id, { relay: true })).toEqual(ok);
    const c = await player(app, carol);
    await b.connection.call.lobbyService.exit({ room: "game:2" });
    await settle(a, b, c);
    expect(a.signals.filter((frame) => frame.sig.bye === true)).toEqual([bye("game:2", b, "bob")]);
    expect(c.signals).toEqual([]);
    // The link in the room Bob stayed in still relays.
    b.relay(GAME, a.id, "rel", message("still here"));
    await settle(a, b);
    expect(a.relayed).toEqual([[GAME, b.id, "rel", message("still here")]]);
  });

  it("tells the peers that signalled a socket when it disconnects, though it never answered", async () => {
    const app = await start();
    const a = await player(app, alice);
    const b = await player(app, bob);
    expect(await a.signal(GAME, b.id, OFFER)).toEqual(ok);
    await settle(a, b);
    b.connection.socket.disconnect();
    await settle(a);
    expect(a.signals).toEqual([bye(GAME, b, "bob")]);
    // Alice's place for the pair is free again.
    const aSocket = app.server.io.sockets.sockets.get(a.id);
    expect(aSocket === undefined ? undefined : pairOf(peersOf(aSocket), GAME, b.id)).toBe(
      undefined,
    );
  });

  it("frees a pair whose peer went away without a bye when the peer is not found", async () => {
    const app = await start();
    const a = await player(app, alice);
    const b = await player(app, bob);
    expect(await a.signal(GAME, b.id, OFFER)).toEqual(ok);
    await settle(a, b);
    const aSocket = app.server.io.sockets.sockets.get(a.id);
    const bSocket = app.server.io.sockets.sockets.get(b.id);
    if (aSocket === undefined || bSocket === undefined) {
      throw new Error("the sockets are on this node");
    }
    // Bob's node forgot hearing Alice (as when more peers signalled him since): he leaves with no bye.
    peersOf(bSocket).heard.clear();
    await b.connection.call.lobbyService.exit({ room: GAME });
    await settle(a, b);
    expect(a.signals).toEqual([]);
    expect(pairOf(peersOf(aSocket), GAME, b.id)).toBeDefined();
    expect(await a.signal(GAME, b.id, OFFER)).toEqual(refused("NOT_FOUND"));
    expect(pairOf(peersOf(aSocket), GAME, b.id)).toBeUndefined();
  });

  it("ends the pair on both sides when a socket says bye itself", async () => {
    const app = await start();
    const [a, b] = await linked(app);
    expect(await a.signal(GAME, b.id, { bye: true })).toEqual(ok);
    await settle(a, b);
    expect(b.signals.at(-1)).toEqual(bye(GAME, a, "alice"));
    a.relay(GAME, b.id, "rel", message(1));
    b.relay(GAME, a.id, "rel", message(2));
    await settle(a, b);
    expect([a.relayed, b.relayed]).toEqual([[], []]);
    // A bye to a peer it never signalled, or twice, is answered all the same.
    expect(await a.signal(GAME, b.id, { bye: true })).toEqual(ok);
  });
});

describe("the pairs a socket holds", () => {
  const socket = { id: "s", data: { principal: alice } } as unknown as QuickdrawServerSocket;

  it("turn mutual once the peer signalled too, whichever side signalled first", () => {
    const state = peersOf({ id: "t", data: {} } as unknown as QuickdrawServerSocket, 0);
    expect(engage(state, GAME, "offered", 0)).toBe(true);
    expect(pairOf(state, GAME, "offered")?.mutual).toBe(false);
    hear(state, GAME, "offered");
    hear(state, GAME, "asking");
    expect(engage(state, GAME, "asking", 0)).toBe(true);
    expect([pairOf(state, GAME, "offered")?.mutual, pairOf(state, GAME, "asking")?.mutual]).toEqual(
      [true, true],
    );
    expect(state.heard.size).toBe(0);
  });

  it(`keep at most ${MAX_HEARD} unanswered peers, forgetting the oldest first`, () => {
    const state = peersOf({ id: "u", data: {} } as unknown as QuickdrawServerSocket, 0);
    for (let n = 0; n <= MAX_HEARD; n += 1) {
      hear(state, GAME, `peer-${n}`);
    }
    expect(state.heard.size).toBe(MAX_HEARD);
    // Peer 0 was forgotten: answering it now makes a pair that is not mutual.
    expect(engage(state, GAME, "peer-0", 0)).toBe(true);
    expect(engage(state, GAME, "peer-1", 0)).toBe(true);
    expect([pairOf(state, GAME, "peer-0")?.mutual, pairOf(state, GAME, "peer-1")?.mutual]).toEqual([
      false,
      true,
    ]);
  });

  it(`are at most ${MAX_PEER_LINKS}, and an ended one makes room`, () => {
    const state = peersOf(socket, 0);
    for (let n = 0; n < MAX_PEER_LINKS; n += 1) {
      expect(engage(state, GAME, `peer-${n}`, 0)).toBe(true);
    }
    expect(engage(state, GAME, "one-more", 0)).toBe(false);
    // Signalling a peer it holds again takes no new place.
    expect(engage(state, GAME, "peer-0", 0)).toBe(true);
    disengage(state, GAME, "peer-0");
    expect(engage(state, "game:2", "one-more", 0)).toBe(true);
    expect(state.count).toBe(MAX_PEER_LINKS);
  });
});

describe("behind a cluster adapter", () => {
  async function twoNodes() {
    const bus = peeredCluster();
    const first = await start({ bus });
    const second = await start({ bus });
    return { first, second };
  }

  it("forwards signals and relay messages to a socket of another node, and its bye back", async () => {
    const { first, second } = await twoNodes();
    const a = await player(first, alice);
    const b = await player(second, bob);
    expect(await a.signal(GAME, b.id, OFFER)).toEqual(ok);
    expect(await b.signal(GAME, a.id, { relay: true })).toEqual(ok);
    a.relay(GAME, b.id, "rel", message("over"));
    b.relay(GAME, a.id, "fast", message("back"));
    await settle(a, b);
    expect(b.signals).toEqual([{ room: GAME, from: a.id, userId: "alice", sig: OFFER }]);
    expect(b.relayed).toEqual([[GAME, a.id, "rel", message("over")]]);
    expect(a.relayed).toEqual([[GAME, b.id, "fast", message("back")]]);
    b.connection.socket.disconnect();
    await expect.poll(() => a.signals.at(-1)).toEqual(bye(GAME, b, "bob"));
  });

  it("drops a relay message on the target's node once the target left the room, the pair still mutual", async () => {
    const { first, second } = await twoNodes();
    const a = await player(first, alice);
    const b = await player(second, bob);
    expect(await a.signal(GAME, b.id, OFFER)).toEqual(ok);
    expect(await b.signal(GAME, a.id, { relay: true })).toEqual(ok);
    await settle(a, b);
    await b.connection.call.lobbyService.exit({ room: GAME });
    await expect.poll(() => a.signals.at(-1)).toEqual(bye(GAME, b, "bob"));
    // The pair as node A holds it while B's bye has not reached it yet.
    const aSocket = first.server.io.sockets.sockets.get(a.id) as QuickdrawServerSocket;
    engage(peersOf(aSocket), GAME, b.id, Date.now());
    hear(peersOf(aSocket), GAME, b.id);
    expect(pairOf(peersOf(aSocket), GAME, b.id)?.mutual).toBe(true);
    a.relay(GAME, b.id, "rel", message("too late"));
    await settle(a, b);
    expect(b.relayed).toEqual([]);
  });

  it("delivers nothing to a socket of another node that is not in the room", async () => {
    const { first, second } = await twoNodes();
    const a = await player(first, alice);
    const outside = await player(second, carol, null);
    expect(await a.signal(GAME, outside.id, OFFER)).toEqual(ok);
    a.relay(GAME, outside.id, "rel", message(1));
    await settle(a, outside);
    expect([outside.signals, outside.relayed]).toEqual([[], []]);
  });
});
