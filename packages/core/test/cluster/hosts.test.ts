// Room hosts across nodes behind a real Valkey (host mode, RFC 0003 section
// 12.5): every node keeps the host of every room, so a socket that joins a
// room on another node than its host's hears `qd:host` at once, and hears
// the room left without one when the host disconnects; two sockets on two
// nodes that set themselves the host at once leave every node with the same
// one; a node that starts after a host was set asks the others for the
// hosts they hold, whether it started with its adapter or was wired with
// `setupRedisAdapter` after `createServer` (as docs/deploying.md does).
// `src/server/realtime/hosts.test.ts` runs here too, with the clients on
// one node.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostFrame } from "../../src/protocol/envelope";
import { alice, bob, captureLogger } from "../../src/server/__tests__/fixtures";
import { frames, settle } from "../../src/server/realtime/__tests__/fixture";
import { defineGameService, WORLD, WORLD_ID } from "../../src/server/realtime/__tests__/hostGame";
import type { Principal } from "../../src/server/index";
import { setupRedisAdapter, type RedisAdapterResult } from "../../src/server/redis";
import type * as Testing from "../../src/testing/createTestApp";
import { startNode, stopNodes, type ClusterNode, type CreateTestApp } from "./nodes";
import { uniquePrefix, VALKEY_URL } from "./valkey";

// The single-server `createTestApp`: these tests boot each node themselves.
const { createTestApp } = await vi.importActual<typeof Testing>("../../src/testing/createTestApp");

const running: ClusterNode[] = [];
/** The servers `setupRedisAdapter` wired, and their adapters' clients. */
const wired: { readonly app: ClusterNode["app"]; readonly redis: RedisAdapterResult }[] = [];

afterEach(async () => {
  // Every server closes before any node's Valkey connections do.
  const servers = wired.splice(0);
  await Promise.all(servers.map(async ({ app }) => await app.close()));
  await stopNodes(running.splice(0));
  await Promise.all(servers.map(async ({ redis }) => await redis.cleanup()));
});

const world = { worldId: WORLD_ID };

type Game = {
  readonly gameService: {
    enter(input: typeof world): Promise<boolean>;
    host(input: typeof world): Promise<boolean>;
    hostOf(input: typeof world): Promise<string | null>;
  };
};

/** One more node of the cluster `prefix` names. */
async function node(prefix: string): Promise<ClusterNode> {
  const started = await startNode(
    createTestApp as CreateTestApp,
    { services: [defineGameService()], peers: true },
    { prefix },
  );
  running.push(started);
  return started;
}

/** One more node of the cluster `prefix`, started alone and wired with `setupRedisAdapter`. */
async function wiredNode(prefix: string): Promise<ClusterNode> {
  const app = await createTestApp({
    services: [defineGameService()],
    peers: true,
    cluster: { keyPrefix: prefix },
  });
  const { hostname, port } = new URL(VALKEY_URL);
  const redis = await setupRedisAdapter(app.server.io, {
    host: hostname,
    port: Number(port),
    logger: captureLogger(),
  });
  const started: ClusterNode = { app: app as unknown as ClusterNode["app"], clients: [] };
  wired.push({ app: started.app, redis });
  return started;
}

/** A socket of `on` acting as `principal`, in the world, with the `qd:host` frames it hears. */
async function player(on: ClusterNode, principal: Principal) {
  const connection = await on.app.connect(principal);
  const hosts = frames<HostFrame>(connection, "qd:host");
  const calls = connection.call as unknown as Game;
  await calls.gameService.enter(world);
  return { connection, hosts, calls, id: connection.socket.id ?? "" };
}

describe("room hosts across nodes", () => {
  it("reach a socket that joins on another node, and tell it when the host disconnects", async () => {
    const prefix = uniquePrefix("hosts");
    const a = await node(prefix);
    const b = await node(prefix);
    const host = await player(a, alice);
    expect(await host.calls.gameService.host(world)).toBe(true);
    await vi.waitFor(() => {
      expect(b.app.server.rooms.hostOf(WORLD)).toBe(host.id);
    });
    const peer = await player(b, bob);
    expect(await peer.calls.gameService.hostOf(world)).toBe(host.id);
    host.connection.socket.disconnect();
    await vi.waitFor(() => {
      expect(peer.hosts).toEqual([
        [WORLD, host.id],
        [WORLD, null],
      ]);
    });
    expect(b.app.server.rooms.hostOf(WORLD)).toBe(null);
  });

  it("settle on one host on every node when two nodes set one at once, and clear it when it leaves", async () => {
    const prefix = uniquePrefix("hosts");
    const a = await node(prefix);
    const b = await node(prefix);
    const onA = await player(a, alice);
    const onB = await player(b, bob);
    expect(
      await Promise.all([onA.calls.gameService.host(world), onB.calls.gameService.host(world)]),
    ).toEqual([true, true]);
    const hostOn = (on: ClusterNode) => on.app.server.rooms.hostOf(WORLD);
    await vi.waitFor(() => {
      expect(hostOn(a)).not.toBe(null);
      expect(hostOn(b)).toBe(hostOn(a));
      expect([onA.hosts.at(-1), onB.hosts.at(-1)]).toEqual([
        [WORLD, hostOn(a)],
        [WORLD, hostOn(a)],
      ]);
    });
    const [host, other] = hostOn(a) === onA.id ? [onA, onB] : [onB, onA];
    host.connection.socket.disconnect();
    await vi.waitFor(() => {
      expect([hostOn(a), hostOn(b)]).toEqual([null, null]);
      expect(other.hosts.at(-1)).toEqual([WORLD, null]);
    });
  });

  it("reach the sockets of a node that started after the host was set", async () => {
    const prefix = uniquePrefix("hosts");
    const a = await node(prefix);
    const host = await player(a, alice);
    await host.calls.gameService.host(world);
    const late = await node(prefix);
    await vi.waitFor(() => {
      expect(late.app.server.rooms.hostOf(WORLD)).toBe(host.id);
    });
    const peer = await player(late, bob);
    await settle(peer.connection);
    expect(peer.hosts).toEqual([[WORLD, host.id]]);
  });

  it("reach the sockets of a node wired with setupRedisAdapter after the host was set", async () => {
    const prefix = uniquePrefix("hosts");
    const a = await node(prefix);
    const host = await player(a, alice);
    await host.calls.gameService.host(world);
    const late = await wiredNode(prefix);
    await vi.waitFor(() => {
      expect(late.app.server.rooms.hostOf(WORLD)).toBe(host.id);
    }, 5000);
    const peer = await player(late, bob);
    await settle(peer.connection);
    expect(peer.hosts).toEqual([[WORLD, host.id]]);
  });
});
