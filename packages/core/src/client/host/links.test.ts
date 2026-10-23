// The ways to the rooms' hosts (host mode, RFC 0003 section 12.5) and
// `./remote`, which they load on demand: once the server announces peer
// links, and never when it does not; a load that fails is a link that
// closed (the next waits, then loads again); and a load the room no longer
// waits for, its host changed or gone meanwhile, makes no link. Each test
// loads `./links` afresh, so each starts with nothing loaded.
// `host.test.ts` runs the ways against a real server.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HostMessage } from "../../protocol/envelope";
import type { HelloFrame } from "../../protocol/version";
import { createLoopbackPeerLink } from "../../testing/peer";
import { fakeConnection } from "../live/__tests__/fakeSocket";
import { controlOf } from "../peer/core";
import type { HostFeed } from "./links";

const ROOM = "world:1";

const peers = {
  /** How many times `./remote` was loaded, a failed load included. */
  loads: 0,
  /** Loads still to fail. */
  failing: 0,
  /** The sockets links were made to. */
  made: [] as string[],
  /** What the hosts' ends of those links heard. */
  heard: [] as HostMessage[],
};

/**
 * `./remote`, whose `createPeerLink` makes a loopback link to the host, as a
 * relayed link would be. Its helpers are imported once, above: the modules
 * `./links` loads afresh share no link with them.
 */
function remote() {
  peers.loads += 1;
  if (peers.failing > 0) {
    peers.failing -= 1;
    throw new TypeError("Failed to fetch dynamically imported module");
  }
  return {
    controlOf,
    createPeerLink: (_connection: unknown, options: { readonly room: string; to: string }) => {
      const [near, far] = createLoopbackPeerLink({
        room: options.room,
        ends: [
          { socketId: "socket-ada", userId: "ada" },
          { socketId: options.to, userId: "bo" },
        ],
      });
      peers.made.push(options.to);
      controlOf(far)?.on((message) => peers.heard.push(message));
      return near;
    },
  };
}

beforeEach(() => {
  vi.resetModules();
  vi.doMock("./remote", remote);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  peers.loads = 0;
  peers.failing = 0;
  peers.made.length = 0;
  peers.heard.length = 0;
  vi.useRealTimers();
});

/** A connection on socket `socket-ada`, and `./links` loaded afresh. */
async function connected() {
  const fake = fakeConnection();
  (fake.connection.socket as { id?: string }).id = "socket-ada";
  const links = await import("./links");
  return { fake, links };
}

/** The connection's hello, announcing peer links. */
function announcing(hello: HelloFrame | null): HelloFrame {
  const limits = { ...hello?.limits, peers: { maxLinks: 64 } };
  return { ...hello, limits } as unknown as HelloFrame;
}

function feed(): HostFeed {
  return {
    service: "gameService",
    stream: "world",
    scope: "w1",
    seeded: () => undefined,
    item: () => undefined,
    refused: () => undefined,
    lost: () => undefined,
  };
}

/** Lets a load of `./remote` settle, and what waits on it run. */
async function loaded(): Promise<void> {
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
}

/** Lets loopback messages land, a millisecond at a time, until `done` (at most 20 ms). */
async function until(done: () => boolean): Promise<void> {
  for (let ms = 0; ms < 20 && !done(); ms += 1) {
    await vi.advanceTimersByTimeAsync(1);
  }
}

describe("the peer links of host mode", () => {
  it("load once the server announces them, and never while it does not", async () => {
    const { fake, links } = await connected();
    links.hostLinksOf(fake.connection);
    await loaded();
    expect(peers.loads).toBe(0);
    fake.setState({ hello: announcing(fake.connection.getState().hello) });
    await loaded();
    expect([peers.loads, peers.made]).toEqual([1, []]);
    // A hello as the server sent it: one without limits announces nothing.
    const quiet = await connected();
    quiet.fake.setState({ hello: {} as HelloFrame });
    quiet.links.hostLinksOf(quiet.fake.connection);
    await loaded();
    expect(peers.loads).toBe(1);
  });

  it("take a failed load as a link that closed: the next waits, then loads again", async () => {
    peers.failing = 1;
    const { fake, links } = await connected();
    const ways = links.hostLinksOf(fake.connection);
    fake.deliver("qd:host", [ROOM, "socket-bo"]);
    ways.subscribe(ROOM, feed());
    await loaded();
    expect([peers.loads, peers.made]).toEqual([1, []]);
    await vi.advanceTimersByTimeAsync(links.HOST_LINK_RETRY_MS - 1);
    expect(peers.loads).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await loaded();
    expect([peers.loads, peers.made]).toEqual([2, ["socket-bo"]]);
    // The link opens, and the feed subscribes over it.
    await until(() => peers.heard.length > 0);
    expect(peers.heard).toEqual([[4, "gameService", "world", "w1"]]);
  });

  it("make no link to a host the room changed or lost while they loaded", async () => {
    const { fake, links } = await connected();
    const ways = links.hostLinksOf(fake.connection);
    fake.deliver("qd:host", [ROOM, "socket-bo"]);
    // A channel's message, with no feed held: a new host makes no link by itself.
    expect(ways.send(ROOM, "gameService", "move", { dx: 1 })).toBe(false);
    fake.deliver("qd:host", [ROOM, "socket-cy"]);
    await loaded();
    expect(peers.made).toEqual([]);
    // The next message links to the room's host now; one gone meanwhile makes none.
    expect(ways.send(ROOM, "gameService", "move", { dx: 1 })).toBe(false);
    fake.deliver("qd:host", [ROOM, null]);
    await loaded();
    expect(peers.made).toEqual([]);
    fake.deliver("qd:host", [ROOM, "socket-cy"]);
    expect(ways.send(ROOM, "gameService", "move", { dx: 1 })).toBe(false);
    await loaded();
    expect(peers.made).toEqual(["socket-cy"]);
  });
});
