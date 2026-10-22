// A room's host on its client (host mode, RFC 0003 section 12.5): the
// runtime over loopback links checks each channel message as the server
// checks `qd:ch` (the schema, the room, a bucket per peer and channel, a
// flood ending the link), answers a subscribe with the feed's seed (kept
// items or the implementation's, in chunks within the message limit) and
// sends pushed items to the feed's subscribers alone; `defineHost` refuses
// an implementation that does not match the contract. Then a host and a
// peer against a real server, over the relay (Node has no WebRTC), and the
// host's own client in process.

import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { z } from "zod";
import { defineContract } from "../../index";
import type { HostMessage, PeerLabel } from "../../protocol/envelope";
import { MAX_PEER_MESSAGE_BYTES } from "../../protocol/version";
import { alice, bob } from "../../server/__tests__/fixtures";
import {
  defineGameService,
  gameContract,
  WORLD,
  WORLD_ID,
  worldRoom,
} from "../../server/realtime/__tests__/hostGame";
import { createTestApp, type TestApp } from "../../testing/index";
import { createLoopbackPeerLink } from "../../testing/peer";
import type { Principal } from "../../server/index";
import { CHANNEL_ABUSE_MULTIPLIER, CHANNEL_ABUSE_WINDOW_MS } from "../../server/realtime/channels";
import { call } from "../call";
import { createQuickdrawConnection, type QuickdrawConnection } from "../connection";
import { until } from "../__tests__/fixtures";
import { controlOf } from "../peer/core";
import { onPeerRequest } from "../peer/link";
import { defineHost, type HostChannelContext } from "./host";
import { hostOf } from "./hosts";
import { hostLinksOf, type HostFeed } from "./links";
import {
  ABUSE_MULTIPLIER,
  ABUSE_WINDOW_MS,
  createHostRuntime,
  type AnyHostImplementation,
} from "./runtime";

const world = { worldId: WORLD_ID };

const snapshot = (tick: number) => ({ tick, players: [`p${String(tick)}`] });

/** A runtime of the game's host for `WORLD`, recording the moves it handles. */
function hosting(implementation: AnyHostImplementation = {}, maxBytes = MAX_PEER_MESSAGE_BYTES) {
  const moves: [unknown, HostChannelContext][] = [];
  const runtime = createHostRuntime(
    gameContract,
    {
      channels: {
        move: (payload, ctx) => {
          moves.push([payload, ctx]);
        },
      },
      ...implementation,
    },
    WORLD,
    () => maxBytes,
  );
  return { runtime, moves };
}

type Runtime = ReturnType<typeof hosting>["runtime"];

/** A peer of `runtime` over a loopback link: what it sends, and what it hears. */
async function peerOf(runtime: Runtime, socketId: string, userId: string) {
  const [near, far] = createLoopbackPeerLink({
    room: WORLD,
    ends: [
      { socketId, userId },
      { socketId: "host-socket", userId: "ada" },
    ],
  });
  const hostSide = controlOf(far);
  const peerSide = controlOf(near);
  if (hostSide === undefined || peerSide === undefined) {
    throw new Error("a loopback link has a control side");
  }
  const attached = runtime.attach({ socketId, userId }, hostSide.send, () => {
    far.close();
  });
  hostSide.on((message) => {
    attached.receive(message);
  });
  const heard: [HostMessage, PeerLabel][] = [];
  peerSide.on((message, label) => heard.push([message, label]));
  await until(() => near.state === "open" && far.state === "open");
  return { link: near, send: peerSide.send, heard, attached };
}

/**
 * Lets every loopback message sent before now land, and the answers they
 * cause. A loopback message (`ms` 0) is a timer of the least delay, and
 * Node runs those in the order they were set, so each turn here lets one
 * more hop land, however late a busy machine runs the turn.
 */
async function landed(): Promise<void> {
  for (let turn = 0; turn < 4; turn += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
  }
}

describe("a host's runtime", () => {
  it("runs a channel's handler on a checked message, with the peer the server named", async () => {
    const { runtime, moves } = hosting();
    const bo = await peerOf(runtime, "socket-bo", "bo");
    bo.send("fast", [3, "gameService", "move", { ...world, dx: 1, dy: 0 }]);
    // Refused: a payload its schema refuses, another world's room, an unknown channel or service.
    bo.send("fast", [3, "gameService", "move", { ...world, dx: 5, dy: 0 }]);
    bo.send("fast", [3, "gameService", "move", { worldId: "2", dx: 1, dy: 0 }]);
    bo.send("fast", [3, "gameService", "jump", { ...world }]);
    bo.send("fast", [3, "otherService", "move", { ...world, dx: 1, dy: 0 }]);
    await landed();
    expect(moves).toEqual([
      [
        { ...world, dx: 1, dy: 0 },
        { peer: { socketId: "socket-bo", userId: "bo" }, room: WORLD },
      ],
    ]);
  });

  it("drops what passes a peer's bucket for a channel, and ends the link of a peer that floods", async () => {
    const { runtime, moves } = hosting();
    const bo = await peerOf(runtime, "socket-bo", "bo");
    const move = { ...world, dx: 0, dy: 1 };
    for (let n = 0; n < 8; n += 1) {
      bo.send("fast", [3, "gameService", "move", move]);
    }
    await landed();
    // The contract's burst is 5.
    expect(moves).toHaveLength(5);
    // 10 a second: more than 1,000 drops within 10 s is a flood.
    for (let n = 0; n < 1_010; n += 1) {
      bo.send("fast", [3, "gameService", "move", move]);
    }
    await until(() => bo.link.state === "closed");
    expect(bo.link.closeReason).toBe("bye");
    // The server's own flood rule for `qd:ch`.
    expect([ABUSE_WINDOW_MS, ABUSE_MULTIPLIER]).toEqual([
      CHANNEL_ABUSE_WINDOW_MS,
      CHANNEL_ABUSE_MULTIPLIER,
    ]);
  });

  it("answers a subscribe with the seed, and sends pushed items to subscribers alone, on fast for a volatile stream", async () => {
    const { runtime } = hosting();
    const bo = await peerOf(runtime, "socket-bo", "bo");
    const cy = await peerOf(runtime, "socket-cy", "cy");
    bo.send("rel", [4, "gameService", "world", WORLD_ID]);
    await landed();
    runtime.push("world", WORLD_ID, snapshot(1));
    await landed();
    expect(bo.heard).toEqual([
      [[6, "gameService", "world", WORLD_ID, [], true], "rel"],
      [[7, "gameService", "world", WORLD_ID, snapshot(1)], "fast"],
    ]);
    expect(cy.heard).toEqual([]);
    expect(runtime.peers.map((peer) => peer.userId)).toEqual(["bo", "cy"]);
    bo.send("rel", [5, "gameService", "world", WORLD_ID]);
    await landed();
    runtime.push("world", WORLD_ID, snapshot(2));
    await landed();
    expect(bo.heard).toHaveLength(2);
  });

  it("seeds a late subscriber with the latest items it kept, or with the implementation's seed", async () => {
    const kept = hosting();
    for (const tick of [1, 2, 3]) {
      kept.runtime.push("world", WORLD_ID, snapshot(tick));
    }
    const bo = await peerOf(kept.runtime, "socket-bo", "bo");
    bo.send("rel", [4, "gameService", "world", WORLD_ID]);
    await landed();
    // The contract keeps the latest 2.
    expect(bo.heard).toEqual([
      [[6, "gameService", "world", WORLD_ID, [snapshot(2), snapshot(3)], true], "rel"],
    ]);
    const computed = hosting({ streams: { world: { seed: () => [snapshot(9)] } } });
    computed.runtime.push("world", WORLD_ID, snapshot(1));
    const cy = await peerOf(computed.runtime, "socket-cy", "cy");
    cy.send("rel", [4, "gameService", "world", WORLD_ID]);
    await landed();
    expect(cy.heard).toEqual([[[6, "gameService", "world", WORLD_ID, [snapshot(9)], true], "rel"]]);
  });

  it("sends a seed in chunks that each fit the message limit", async () => {
    const items = [1, 2, 3, 4, 5].map((tick) => ({ tick, players: ["x".repeat(60)] }));
    const { runtime } = hosting({ streams: { world: { seed: () => items } } }, 200);
    const bo = await peerOf(runtime, "socket-bo", "bo");
    bo.send("rel", [4, "gameService", "world", WORLD_ID]);
    await landed();
    const seeds = bo.heard.map(([message]) => message) as Extract<
      HostMessage,
      readonly [6, ...unknown[]]
    >[];
    expect(seeds.length).toBeGreaterThan(1);
    expect(seeds.map((seed) => seed[5])).toEqual([...seeds.slice(1).map(() => false), true]);
    expect(seeds.flatMap((seed) => seed[4])).toEqual(items);
    for (const seed of seeds) {
      expect(new TextEncoder().encode(JSON.stringify(seed)).length).toBeLessThanOrEqual(200);
    }
  });

  it("refuses a subscribe to another room's scope or to a stream it does not serve", async () => {
    const { runtime } = hosting();
    const bo = await peerOf(runtime, "socket-bo", "bo");
    bo.send("rel", [4, "gameService", "world", "2"]);
    bo.send("rel", [4, "gameService", "ticks", WORLD_ID]);
    await landed();
    expect(
      bo.heard.map(([message]) => [message[0], message[2], (message[4] as { code: string }).code]),
    ).toEqual([
      [8, "world", "FORBIDDEN"],
      [8, "ticks", "NOT_FOUND"],
    ]);
  });

  it("checks a pushed item against the stream's schema and the message limit", () => {
    const { runtime } = hosting({}, 120);
    expect(() => {
      runtime.push("world", WORLD_ID, { tick: "one" });
    }).toThrow(`host.stream("world").push: the item does not match the stream's schema`);
    expect(() => {
      runtime.push("world", WORLD_ID, { tick: 1, players: ["x".repeat(200)] });
    }).toThrow(RangeError);
    expect(() => {
      runtime.push("ticks", WORLD_ID, 1);
    }).toThrow(`host.stream: gameService has no host-served stream "ticks"`);
  });
});

describe("a host's runtime, one message at a time", () => {
  /** A peer attached straight to `runtime`: what it was sent, and whether its link was closed. */
  function direct(runtime: Runtime, sendOk: () => boolean = () => true) {
    const sent: [PeerLabel, HostMessage][] = [];
    let closed = 0;
    const attached = runtime.attach(
      { socketId: "socket-bo", userId: "bo" },
      (label, message) => {
        if (!sendOk()) {
          return false;
        }
        sent.push([label, message]);
        return true;
      },
      () => {
        closed += 1;
      },
    );
    return { attached, sent, closed: () => closed };
  }

  /** Runs `act`, collecting what it throws later (`throwLater`) instead of failing the run. */
  function thrownLater(act: () => void): unknown[] {
    const errors: unknown[] = [];
    const microtask = vi.spyOn(globalThis, "queueMicrotask").mockImplementation((task) => {
      try {
        task();
      } catch (error) {
        errors.push(error);
      }
    });
    try {
      act();
    } finally {
      microtask.mockRestore();
    }
    return errors;
  }

  it("refuses a seed whose item fits no message alone, and sends none of it", () => {
    const big = { tick: 1, players: ["x".repeat(300)] };
    const { runtime } = hosting({ streams: { world: { seed: () => [snapshot(0), big] } } }, 200);
    const bo = direct(runtime);
    const errors = thrownLater(() => {
      bo.attached.receive([4, "gameService", "world", WORLD_ID]);
    });
    expect(bo.sent).toEqual([
      [
        "rel",
        [
          8,
          "gameService",
          "world",
          WORLD_ID,
          { code: "INTERNAL", message: "The feed's seed holds an item over the message limit" },
        ],
      ],
    ]);
    expect(errors).toEqual([expect.any(RangeError)]);
    runtime.push("world", WORLD_ID, snapshot(1));
    expect(bo.sent).toHaveLength(1);
  });

  it("sends again, in order, what the link drops on rel, and closes a peer that cannot keep up", () => {
    vi.useFakeTimers();
    try {
      let open = false;
      const { runtime } = hosting();
      const bo = direct(runtime, () => open);
      bo.attached.receive([4, "gameService", "world", WORLD_ID]);
      // A volatile stream's item goes on `fast`, as the link takes it: dropped, never sent again.
      runtime.push("world", WORLD_ID, snapshot(1));
      bo.attached.receive([4, "gameService", "ticks", WORLD_ID]);
      expect(bo.sent).toEqual([]);
      open = true;
      vi.advanceTimersByTime(1000);
      expect(bo.sent.map(([label, message]) => [label, message[0], message[2]])).toEqual([
        ["rel", 6, "world"],
        ["rel", 8, "ticks"],
      ]);
      open = false;
      const large = { tick: 2, players: ["x".repeat(30_000)] };
      let subscribes = 0;
      for (; bo.closed() === 0 && subscribes < 300; subscribes += 1) {
        runtime.push("world", WORLD_ID, large);
        bo.attached.receive([4, "gameService", "world", WORLD_ID]);
      }
      // About 60 KB a seed: past 8 MiB waiting, the link closes.
      expect([bo.closed(), subscribes < 300]).toEqual([1, true]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refuses a peer's subscribes past 500 at once and then 50 a second, and ends a flood of them", () => {
    // A stopped clock: no token comes back while the loops run, however long they take.
    vi.useFakeTimers();
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const { runtime } = hosting();
    const bo = direct(runtime);
    for (let n = 0; n < 501; n += 1) {
      bo.attached.receive([4, "gameService", "world", WORLD_ID]);
    }
    expect(bo.sent.at(-1)).toEqual([
      "rel",
      [
        8,
        "gameService",
        "world",
        WORLD_ID,
        { code: "RATE_LIMITED", message: "A peer subscribes at most 50 times a second" },
      ],
    ]);
    expect(bo.closed()).toBe(0);
    for (let n = 0; n < 5_000; n += 1) {
      bo.attached.receive([4, "gameService", "world", WORLD_ID]);
    }
    expect(bo.closed()).toBe(1);
  });
});

describe("defineHost", () => {
  it("refuses an implementation that does not match the contract's host-served members", () => {
    expect(() => defineHost(gameContract, { channels: {} } as never)).toThrow(
      "defineHost(gameService): channels.move must be a handler: the room's host serves it",
    );
    expect(() =>
      defineHost(gameContract, {
        channels: { move: () => undefined, jump: () => undefined },
      } as never),
    ).toThrow(`defineHost(gameService): "jump" is not a channel the room's host serves`);
    expect(() =>
      defineHost(gameContract, {
        channels: { move: () => undefined },
        streams: { world: { seed: [] } },
      } as never),
    ).toThrow("defineHost(gameService): streams.world.seed must be a function of the scope");
  });
});

describe("a host and its peers against a server", () => {
  const apps: TestApp[] = [];
  const connections: QuickdrawConnection[] = [];

  afterEach(async () => {
    for (const connection of connections.splice(0)) {
      connection.close();
    }
    await Promise.all(apps.splice(0).map(async (app) => await app.close()));
  });

  async function player(app: TestApp, principal: Principal): Promise<QuickdrawConnection> {
    const connection = createQuickdrawConnection({
      url: app.url,
      auth: { principal },
      transports: ["websocket"],
    });
    connections.push(connection);
    // Hears `qd:host` before it joins.
    hostOf(connection, WORLD);
    connection.open();
    await until(() => connection.getState().hello !== null);
    await call(connection, {
      service: "gameService",
      method: "enter",
      input: world,
      kind: "mutation",
    });
    return connection;
  }

  function feed(service = "gameService"): HostFeed & {
    readonly seeds: unknown[][];
    readonly items: unknown[];
    readonly errors: unknown[];
  } {
    const seeds: unknown[][] = [];
    const items: unknown[] = [];
    const errors: unknown[] = [];
    return {
      service,
      stream: "world",
      scope: WORLD_ID,
      seeds,
      items,
      errors,
      seeded: (seed) => seeds.push([...seed]),
      item: (item) => items.push(item),
      refused: (error) => errors.push(error),
      lost: () => undefined,
    };
  }

  /** A server for the game, with a socket of `principal` the world's host. */
  async function hostedWorld(principal: Principal = alice) {
    const app = (await createTestApp({
      services: [defineGameService()],
      peers: true,
    })) as unknown as TestApp;
    apps.push(app);
    const hostConnection = await player(app, principal);
    await call(hostConnection, {
      service: "gameService",
      method: "host",
      input: world,
      kind: "mutation",
    });
    return { app, hostConnection };
  }

  it("carries a peer's moves to the host, named by the server, and the host's world to the peer", async () => {
    const app = (await createTestApp({
      services: [defineGameService()],
      peers: true,
    })) as unknown as TestApp;
    apps.push(app);
    const moves: [unknown, HostChannelContext][] = [];
    const worldHost = defineHost(gameContract, {
      channels: { move: (move, ctx) => moves.push([move, ctx]) },
      streams: { world: { seed: () => [snapshot(0)] } },
    });
    const hostConnection = await player(app, alice);
    await call(hostConnection, {
      service: "gameService",
      method: "host",
      input: world,
      kind: "mutation",
    });
    const host = worldHost.serve(hostConnection, { room: WORLD });
    const peer = await player(app, bob);
    await until(() => hostOf(peer, WORLD) === hostConnection.socket.id);
    const bo = feed();
    hostLinksOf(peer).subscribe(WORLD, bo);
    await until(() => bo.seeds.length === 1);
    expect(bo.seeds).toEqual([[snapshot(0)]]);
    host.stream("world").push(WORLD_ID, snapshot(1));
    await until(() => bo.items.length === 1);
    // `fast` is unreliable, never resent: the peer moves again until the
    // host has a move, as a game sends its input each frame.
    await vi.waitFor(async () => {
      expect(
        hostLinksOf(peer).send(WORLD, "gameService", "move", { ...world, dx: -1, dy: 0 }),
      ).toBe(true);
      await until(() => moves.length > 0, 200);
    });
    expect(moves[0]?.[1].peer).toEqual({ socketId: peer.socket.id, userId: "bob" });
    // The host's own client is one of its peers too, in process.
    expect(
      hostLinksOf(hostConnection).send(WORLD, "gameService", "move", { ...world, dx: 1, dy: 1 }),
    ).toBe(true);
    expect(moves.at(-1)?.[1].peer).toEqual({ socketId: hostConnection.socket.id, userId: "alice" });
    host.close();
    await until(() => host.peers.length === 0);
  });

  it("makes no link a send while the host's links keep closing: the next waits", async () => {
    const app = (await createTestApp({
      services: [defineGameService()],
      peers: true,
    })) as unknown as TestApp;
    apps.push(app);
    const hostConnection = await player(app, alice);
    await call(hostConnection, {
      service: "gameService",
      method: "host",
      input: world,
      kind: "mutation",
    });
    // The host's client refuses every link, as a host at its links' cap would be refused.
    onPeerRequest(hostConnection, (request) => {
      request.reject();
    });
    const peer = await player(app, bob);
    await until(() => hostOf(peer, WORLD) === hostConnection.socket.id);
    const offers = () =>
      app
        .frames({ event: "qd:peer", socketId: hostConnection.socket.id })
        .filter((frame) => (frame.data as { readonly sig?: { relay?: true } }).sig?.relay === true);
    const move = () =>
      hostLinksOf(peer).send(WORLD, "gameService", "move", { ...world, dx: 1, dy: 0 });
    // A game sends its input every frame: one link, then a wait of 1 s after it closed.
    for (let frame = 0; frame < 20; frame += 1) {
      expect(move()).toBe(false);
      await new Promise((resolve) => {
        setTimeout(resolve, 16);
      });
    }
    expect(offers()).toHaveLength(1);
    await vi.waitFor(
      () => {
        move();
        expect(offers()).toHaveLength(2);
      },
      { timeout: 3000, interval: 50 },
    );
  });

  it("serves two contracts in one room over the same links, and refuses a service it does not serve", async () => {
    const { app, hostConnection } = await hostedWorld();
    const chatContract = defineContract("chatService", {
      channels: {
        say: {
          payload: z.object({ worldId: z.string(), text: z.string() }),
          requires: { room: (say) => worldRoom(say.worldId) },
          serve: "host",
        },
      },
    });
    const moves: unknown[] = [];
    const said: [unknown, string][] = [];
    const game = defineHost(gameContract, {
      channels: { move: (move) => moves.push(move) },
      streams: { world: { seed: () => [snapshot(0)] } },
    }).serve(hostConnection, { room: WORLD });
    const chatHost = defineHost(chatContract, {
      channels: { say: (say, { peer }) => said.push([say, peer.userId]) },
    });
    chatHost.serve(hostConnection, { room: WORLD });
    expect(() => chatHost.serve(hostConnection, { room: WORLD })).toThrow(
      'serve: this connection serves chatService in room "1" already; close that Host first'.replace(
        '"1"',
        `"${WORLD}"`,
      ),
    );
    const peer = await player(app, bob);
    await until(() => hostOf(peer, WORLD) === hostConnection.socket.id);
    const bo = feed();
    const nobody = feed("nobodyService");
    hostLinksOf(peer).subscribe(WORLD, bo);
    hostLinksOf(peer).subscribe(WORLD, nobody);
    await until(() => bo.seeds.length === 1 && nobody.errors.length === 1);
    expect(nobody.errors).toEqual([
      { code: "NOT_FOUND", message: `The host of ${WORLD} serves no service "nobodyService"` },
    ]);
    // `fast` may drop a message on the relay: send each again until the host has it.
    await vi.waitFor(async () => {
      hostLinksOf(peer).send(WORLD, "chatService", "say", { ...world, text: "hi" });
      hostLinksOf(peer).send(WORLD, "gameService", "move", { ...world, dx: 1, dy: 0 });
      await until(() => said.length > 0 && moves.length > 0, 200);
    });
    expect(said[0]).toEqual([{ ...world, text: "hi" }, "bob"]);
    // Closing one contract's host leaves the other serving over the same link.
    game.close();
    const before = said.length;
    await vi.waitFor(async () => {
      hostLinksOf(peer).send(WORLD, "chatService", "say", { ...world, text: "still here" });
      await until(() => said.length > before, 200);
    });
  });

  it("follows the room to its next host: links again, and the new host's seed replaces the old", async () => {
    const { app, hostConnection } = await hostedWorld();
    defineHost(gameContract, {
      channels: { move: () => undefined },
      streams: { world: { seed: () => [snapshot(1)] } },
    }).serve(hostConnection, { room: WORLD });
    const peer = await player(app, bob);
    await until(() => hostOf(peer, WORLD) === hostConnection.socket.id);
    const bo = feed();
    hostLinksOf(peer).subscribe(WORLD, bo);
    await until(() => bo.seeds.length === 1);
    const next = await player(app, { userId: "cy", serviceAccess: {} } as Principal);
    defineHost(gameContract, {
      channels: { move: () => undefined },
      streams: { world: { seed: () => [snapshot(2)] } },
    }).serve(next, { room: WORLD });
    await call(next, { service: "gameService", method: "host", input: world, kind: "mutation" });
    await until(() => bo.seeds.length === 2);
    expect(bo.seeds).toEqual([[snapshot(1)], [snapshot(2)]]);
  });

  it("lets a peer hear that the room's host is gone", async () => {
    const app = (await createTestApp({
      services: [defineGameService()],
      peers: true,
    })) as unknown as TestApp;
    apps.push(app);
    const hostConnection = await player(app, alice);
    await call(hostConnection, {
      service: "gameService",
      method: "host",
      input: world,
      kind: "mutation",
    });
    const peer = await player(app, bob);
    await until(() => hostOf(peer, WORLD) !== null);
    hostConnection.close();
    await vi.waitFor(() => {
      expect(hostOf(peer, WORLD)).toBe(null);
    });
  });
});
