// Hosts of app rooms (host mode, RFC 0003 section 12.5): a method makes the
// calling socket its room's host with `ctx.rooms.setHost`; the room hears
// `qd:host [room, host]`, and so does a socket that joins it later; another
// `setHost` replaces the host and `clearHost` clears it; when the host
// leaves the room, is taken out of it or disconnects, the room hears
// `qd:host [room, null]` and `onHostLeave` runs. The server takes nothing
// for a host-served channel or stream: a `qd:ch` to one is dropped with a
// warning, a subscribe is refused, a push throws, and a service may give
// neither a handler nor options.
//
// In the cluster projects the clients sit on node A and `app.server` is
// node B, whose record of a room's host follows A's changes. Fake nodes
// (`fakeNode`) hand their server-to-server events to each other in the
// order a test chooses, for the races a real cluster rarely shows.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostFrame } from "../../protocol/envelope";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { alice, bob, captureLogger, type AppPrincipal } from "../__tests__/fixtures";
import type { Hub } from "../emit/hub";
import type { QuickdrawServerSocket } from "../transports/types";
import { compileChannels, compileStreams } from "./define";
import { frames, refused, settle } from "./__tests__/fixture";
import { defineGameService, gameContract, qd, WORLD, WORLD_ID } from "./__tests__/hostGame";
import { createRoomHosts } from "./hosts";
import type { HostLeave } from "./types";

const carol: AppPrincipal = { userId: "carol", kind: "user" };

const apps: TestApp[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

async function start(logger?: ReturnType<typeof captureLogger>) {
  const left: HostLeave[] = [];
  const app = await createTestApp({
    services: [
      defineGameService((leave) => {
        left.push(leave);
      }),
    ],
    peers: true,
    ...(logger === undefined ? {} : { logger }),
  });
  apps.push(app as unknown as TestApp);
  return { app, left };
}

type App = Awaited<ReturnType<typeof start>>["app"];

const world = { worldId: WORLD_ID };

/** A socket acting as `principal`, in the world unless `enter` is false, with the `qd:host` frames it hears. */
async function player(app: App, principal: AppPrincipal | null, enter = true) {
  const connection = await app.connect(principal);
  const hosts = frames<HostFrame>(connection, "qd:host");
  if (enter) {
    await connection.call.gameService.enter(world);
  }
  return { connection, hosts, id: connection.socket.id ?? "" };
}

describe("a room's host", () => {
  it("is set by a method: the room hears it, and so does a socket that joins later", async () => {
    const { app } = await start();
    const host = await player(app, alice);
    const peer = await player(app, bob);
    expect(await host.connection.call.gameService.host(world)).toBe(true);
    await settle(host.connection);
    await settle(peer.connection);
    expect([host.hosts, peer.hosts]).toEqual([[[WORLD, host.id]], [[WORLD, host.id]]]);
    const late = await player(app, carol);
    await settle(late.connection);
    expect(late.hosts).toEqual([[WORLD, host.id]]);
    expect(await peer.connection.call.gameService.hostOf(world)).toBe(host.id);
    await expect.poll(() => app.server.rooms.hostOf(WORLD)).toBe(host.id);
  });

  it("is replaced by another socket's setHost, and cleared by clearHost, with no onHostLeave", async () => {
    const { app, left } = await start();
    const host = await player(app, alice);
    const peer = await player(app, bob);
    await host.connection.call.gameService.host(world);
    await peer.connection.call.gameService.host(world);
    // Again: the host it already is, so the room hears nothing new.
    await peer.connection.call.gameService.host(world);
    await peer.connection.call.gameService.unhost(world);
    await settle(host.connection);
    expect(host.hosts).toEqual([
      [WORLD, host.id],
      [WORLD, peer.id],
      [WORLD, null],
    ]);
    expect(left).toEqual([]);
    await expect.poll(() => app.server.rooms.hostOf(WORLD)).toBe(null);
  });

  it("is refused to a socket outside the room and to an anonymous one; a call without a socket gets false", async () => {
    const { app } = await start();
    const outside = await player(app, alice, false);
    await expect(outside.connection.call.gameService.host(world)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    const anonymous = await player(app, null);
    await expect(anonymous.connection.call.gameService.host(world)).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
    expect(await app.as(bob).gameService.host(world)).toBe(false);
    expect(await outside.connection.call.gameService.hostOf(world)).toBe(null);
  });

  it("leaves the room without one when it leaves, is taken out or disconnects; onHostLeave hears each", async () => {
    const { app, left } = await start();
    const watcher = await player(app, carol);
    const first = await player(app, alice);
    await first.connection.call.gameService.host(world);
    await first.connection.call.gameService.exit(world);
    const second = await player(app, bob);
    await second.connection.call.gameService.host(world);
    await watcher.connection.call.gameService.kick({ ...world, userId: "bob" });
    const third = await player(app, alice);
    await third.connection.call.gameService.host(world);
    third.connection.socket.disconnect();
    await vi.waitFor(() => {
      expect(left).toHaveLength(3);
    });
    expect(
      left.map(({ room, socketId, principal, reason }) => [
        room,
        socketId,
        principal?.userId,
        reason,
      ]),
    ).toEqual([
      [WORLD, first.id, "alice", "leave"],
      [WORLD, second.id, "bob", "removed"],
      [WORLD, third.id, "alice", "disconnect"],
    ]);
    await settle(watcher.connection);
    expect(watcher.hosts).toEqual(
      [first.id, second.id, third.id].flatMap((id) => [
        [WORLD, id],
        [WORLD, null],
      ]),
    );
  });

  it("needs a server that serves peer links", async () => {
    await expect(createTestApp({ services: [defineGameService()] })).rejects.toThrow(
      `createServer: gameService's channel "move" is served by the room's host (serve: "host"), which runs over peer links; create the server with peers: true`,
    );
    const hosts = createRoomHosts({ io: undefined } as unknown as Hub, () => false);
    const socket = { connected: true, data: { appRooms: { [WORLD]: true } } };
    expect(() => hosts.set(socket as unknown as QuickdrawServerSocket, WORLD)).toThrow(
      "host mode runs over peer links",
    );
  });
});

/** A server-to-server event a fake node sent, waiting for a test to hand it on. */
interface Sent {
  readonly event: string;
  readonly payload: unknown;
}

/**
 * A node of a fake cluster: what it sends the other nodes waits in `sent`
 * until a test hands it on (`deliver`), its startup ask (`asked`) waits for
 * `started`, and `told` holds the `qd:host` frames its sockets heard.
 */
function fakeNode() {
  const listeners = new Map<string, (payload: unknown, ...rest: unknown[]) => void>();
  const sockets = new Map<string, QuickdrawServerSocket>();
  const told: unknown[] = [];
  const sent: Sent[] = [];
  const asked: Sent[] = [];
  let answer: (answers: unknown[]) => void = () => undefined;
  const io = {
    on(event: string, listener: (payload: unknown, ...rest: unknown[]) => void) {
      listeners.set(event, listener);
    },
    serverSideEmit(event: string, payload: unknown) {
      sent.push({ event, payload });
      return true;
    },
    serverSideEmitWithAck(event: string, payload: unknown) {
      asked.push({ event, payload });
      return new Promise<unknown[]>((resolve) => {
        answer = resolve;
      });
    },
    local: { to: () => ({ emit: (_event: string, frame: unknown) => told.push(frame) }) },
    sockets: { sockets },
  };
  const hub = {
    io,
    probe: { local: () => false },
    cluster: undefined,
    logger: captureLogger(),
    inFlight: new Set(),
  };
  const hosts = createRoomHosts(hub as unknown as Hub, () => true);
  hosts.listen();
  return {
    hosts,
    told,
    sent,
    asked,
    /** A signed-in socket of this node, in the world. */
    socket(id: string): QuickdrawServerSocket {
      const data = { appRooms: { [WORLD]: true }, principal: alice };
      const socket = { id, connected: true, data } as unknown as QuickdrawServerSocket;
      sockets.set(id, socket);
      return socket;
    },
    /** Hands this node a server-to-server event: its answer, when it gives one. */
    hear(message: Sent): unknown {
      let answered: unknown;
      listeners.get(message.event)?.(message.payload, (value: unknown) => {
        answered = value;
      });
      return answered;
    },
    /** Ends this node's startup ask with the other nodes' answers. */
    async started(answers: unknown[]): Promise<void> {
      answer(answers);
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    },
  };
}

type FakeNode = ReturnType<typeof fakeNode>;

/** Hands `to` what `from` sent, in order: the first `count` events, all by default. */
function deliver(from: FakeNode, to: FakeNode, count = from.sent.length): void {
  for (const message of from.sent.splice(0, count)) {
    to.hear(message);
  }
}

/** Both nodes' hosts of the world. */
const hostsOf = (...nodes: FakeNode[]) => nodes.map((node) => node.hosts.of(WORLD));

describe("a room's host across nodes", () => {
  const NOW = Date.parse("2026-10-22T12:00:00Z");

  afterEach(() => {
    vi.useRealTimers();
  });

  it("is none on both nodes when two setHost at once race and the winner leaves before the loser's record arrives", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const [a, b] = [fakeNode(), fakeNode()];
    await Promise.all([a.started([]), b.started([])]);
    // Two records of one version: the greater socket id wins the tie.
    const winner = a.socket("socket-2");
    const loser = b.socket("socket-1");
    expect([a.hosts.set(winner, WORLD), b.hosts.set(loser, WORLD)]).toEqual([true, true]);
    // The winner leaves before node A hears the loser's record.
    a.hosts.left(winner, WORLD, "disconnect");
    deliver(b, a);
    expect(hostsOf(a)).toEqual([null]);
    deliver(a, b);
    expect(hostsOf(a, b)).toEqual([null, null]);
    expect(b.told).toEqual([
      [WORLD, loser.id],
      [WORLD, winner.id],
      [WORLD, null],
    ]);
    expect(a.told).toEqual([
      [WORLD, winner.id],
      [WORLD, null],
    ]);
    // The loser leaving node B says nothing: neither node holds it.
    b.hosts.left(loser, WORLD, "disconnect");
    expect([a.sent, b.sent]).toEqual([[], []]);
  });

  it("is none on both nodes when a late setHost from a node whose clock is behind loses to the room's clear", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const a = fakeNode();
    await a.started([]);
    const first = a.socket("socket-1");
    a.hosts.set(first, WORLD);
    a.hosts.left(first, WORLD, "disconnect");
    // Node B starts with its clock 2 s behind, and sets a host before any answer.
    a.sent.length = 0;
    vi.setSystemTime(NOW - 2000);
    const b = fakeNode();
    b.hosts.set(b.socket("socket-2"), WORLD);
    // Node A turns down a record older than the room's clear, and sends the clear again.
    deliver(b, a);
    expect(hostsOf(a, b)).toEqual([null, "socket-2"]);
    expect(a.sent).toHaveLength(1);
    deliver(a, b);
    expect(hostsOf(a, b)).toEqual([null, null]);
    expect(b.told.at(-1)).toEqual([WORLD, null]);
    // What a node already holds is not answered: nothing more goes out.
    expect([a.sent, b.sent]).toEqual([[], []]);
    // Node B heard the clear's version: its next setHost is later, on both nodes.
    b.hosts.set(b.socket("socket-0"), WORLD);
    deliver(b, a);
    expect(hostsOf(a, b)).toEqual(["socket-0", "socket-0"]);
  });

  it("is the later host on both nodes when one never heard it, once the other turns down its older record", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const [a, b] = [fakeNode(), fakeNode()];
    await Promise.all([a.started([]), b.started([])]);
    a.hosts.set(a.socket("socket-1"), WORLD);
    // Node B never hears it, and its clock is behind.
    a.sent.length = 0;
    vi.setSystemTime(NOW - 2000);
    b.hosts.set(b.socket("socket-2"), WORLD);
    deliver(b, a);
    expect(a.sent).toHaveLength(1);
    deliver(a, b);
    expect(hostsOf(a, b)).toEqual(["socket-1", "socket-1"]);
    expect([a.sent, b.sent]).toEqual([[], []]);
  });

  it("takes the other nodes' clock when a node starts: its setHost wins over what they cleared before", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const a = fakeNode();
    await a.started([]);
    const first = a.socket("socket-1");
    a.hosts.set(first, WORLD);
    a.hosts.left(first, WORLD, "disconnect");
    a.sent.length = 0;
    vi.setSystemTime(NOW - 2000);
    const b = fakeNode();
    await b.started(b.asked.map((ask) => a.hear(ask)));
    b.hosts.set(b.socket("socket-0"), WORLD);
    deliver(b, a);
    expect(hostsOf(a, b)).toEqual(["socket-0", "socket-0"]);
    expect(a.sent).toEqual([]);
  });

  it("takes no host from a starting node's late answer when the room's clear arrived first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const a = fakeNode();
    await a.started([]);
    const host = a.socket("socket-1");
    a.hosts.set(host, WORLD);
    a.sent.length = 0;
    const c = fakeNode();
    const answers = c.asked.map((ask) => a.hear(ask));
    expect(answers).toEqual([{ hosts: [[WORLD, host.id, NOW * 1000]], clock: NOW * 1000 }]);
    a.hosts.left(host, WORLD, "disconnect");
    deliver(a, c);
    await c.started(answers);
    expect(hostsOf(a, c)).toEqual([null, null]);
    expect(c.told).toEqual([]);
  });
});

describe("host-served members on the server", () => {
  const fail = (message: string): never => {
    throw new TypeError(message);
  };

  it("take no channel handler and no stream options", () => {
    expect(compileChannels(gameContract, undefined, undefined, fail).size).toBe(0);
    expect(() => compileChannels(gameContract, { move: () => undefined }, undefined, fail)).toThrow(
      `channel "move" is served by the room's host (serve: "host"): its messages never reach the server, so it takes no handler`,
    );
    const needs = { model: undefined, hasPolicy: false };
    expect(compileStreams(gameContract, needs, undefined, fail).get("world")?.host).toBe(true);
    expect(() => compileStreams(gameContract, needs, { world: { seed: () => [] } }, fail)).toThrow(
      `streams.world: the stream is served by the room's host (serve: "host")`,
    );
  });

  it("drop a qd:ch to a host-served channel, warning once", async () => {
    const logger = captureLogger();
    const { app } = await start(logger);
    const sender = await player(app, alice);
    for (let n = 0; n < 3; n += 1) {
      sender.connection.socket.emit("qd:ch", ["gameService", "move", { ...world, dx: 1, dy: 0 }]);
    }
    await settle(sender.connection);
    expect(logger.at("warn").map((entry) => entry.message)).toEqual([
      expect.stringContaining(`Channel gameService.move is served by the room's host`),
    ]);
  });

  it("refuse a subscribe to a host-served stream, a push from the server, and a count", async () => {
    const { app } = await start();
    const peer = await player(app, alice);
    const frame = { s: "gameService", stream: "world", scope: WORLD_ID };
    expect(await emitWithAck(peer.connection.socket, "qd:stream:sub", frame)).toEqual(
      refused("VALIDATION"),
    );
    expect(() =>
      app.server.stream(gameContract, "world").push(WORLD_ID, { tick: 1, players: [] }),
    ).toThrow(`stream: gameService.world is served by the room's host (serve: "host")`);
    // its subscribers are the host's, over peer links the server never reads: a job's count rejects
    await expect(qd.stream(gameContract, "world").subscribers(WORLD_ID)).rejects.toThrow(
      `stream: gameService.world is served by the room's host (serve: "host")`,
    );
  });
});
