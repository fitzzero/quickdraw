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
// node B, whose record of a room's host follows A's changes.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostFrame } from "../../protocol/envelope";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { alice, bob, captureLogger, type AppPrincipal } from "../__tests__/fixtures";
import type { Hub } from "../emit/hub";
import type { QuickdrawServerSocket } from "../transports/types";
import { compileChannels, compileStreams } from "./define";
import { frames, refused, settle } from "./__tests__/fixture";
import { defineGameService, gameContract, WORLD, WORLD_ID } from "./__tests__/hostGame";
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

  it("refuse a subscribe to a host-served stream, and a push from the server", async () => {
    const { app } = await start();
    const peer = await player(app, alice);
    const frame = { s: "gameService", stream: "world", scope: WORLD_ID };
    expect(await emitWithAck(peer.connection.socket, "qd:stream:sub", frame)).toEqual(
      refused("VALIDATION"),
    );
    expect(() =>
      app.server.stream(gameContract, "world").push(WORLD_ID, { tick: 1, players: [] }),
    ).toThrow(`stream: gameService.world is served by the room's host (serve: "host")`);
  });
});
