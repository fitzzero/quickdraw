// The ways to the rooms' hosts (host mode, RFC 0003 section 12.5) while
// `../peer/link` loads, which it does on demand: a load that fails is a
// link that closed (the next waits, then loads again), and a load the room
// no longer waits for, its host changed meanwhile, makes no link.
// `host.test.ts` runs the ways against a real server.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { HostMessage } from "../../protocol/envelope";
import { fakeConnection } from "../live/__tests__/fakeSocket";
import { HOST_LINK_RETRY_MS, hostLinksOf, type HostFeed } from "./links";

const ROOM = "world:1";

const peers = vi.hoisted(() => ({
  /** Loads of `../peer/link` still to fail. */
  failing: 0,
  /** The sockets links were made to. */
  made: [] as string[],
  /** What the hosts' ends of those links heard. */
  heard: [] as HostMessage[],
}));

// `createPeerLink` makes a loopback link to the host, as a relayed link would be.
vi.mock("../peer/link", async () => {
  if (peers.failing > 0) {
    peers.failing -= 1;
    throw new TypeError("Failed to fetch dynamically imported module");
  }
  const { createLoopbackPeerLink } = await import("../../testing/peer");
  const { controlOf } = await import("../peer/core");
  return {
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
});

afterEach(() => {
  peers.failing = 0;
  peers.made.length = 0;
  peers.heard.length = 0;
  vi.useRealTimers();
});

/** A connection on socket `socket-ada`, whose ways are made. */
function connected() {
  const fake = fakeConnection();
  (fake.connection.socket as { id?: string }).id = "socket-ada";
  return { fake, links: hostLinksOf(fake.connection) };
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

/** Lets the load of `../peer/link` settle, and what waits on it run. */
async function loaded(): Promise<void> {
  await vi.dynamicImportSettled();
  await vi.advanceTimersByTimeAsync(0);
}

describe("a way to a room's host while the peer links load", () => {
  it("takes a failed load as a link that closed: the next waits, then loads again", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    peers.failing = 1;
    const { fake, links } = connected();
    fake.deliver("qd:host", [ROOM, "socket-bo"]);
    links.subscribe(ROOM, feed());
    await loaded();
    expect([peers.failing, peers.made]).toEqual([0, []]);
    await vi.advanceTimersByTimeAsync(HOST_LINK_RETRY_MS - 1);
    expect(peers.made).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await loaded();
    // The link opened, and the feed subscribed over it.
    expect(peers.made).toEqual(["socket-bo"]);
    expect(peers.heard).toEqual([[4, "gameService", "world", "w1"]]);
  });

  it("makes no link to a host the room lost while the peer links loaded", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const { fake, links } = connected();
    fake.deliver("qd:host", [ROOM, "socket-bo"]);
    // A channel's message, with no feed held: a new host makes no link by itself.
    expect(links.send(ROOM, "gameService", "move", { dx: 1 })).toBe(false);
    fake.deliver("qd:host", [ROOM, "socket-cy"]);
    await loaded();
    expect(peers.made).toEqual([]);
    // The next message links to the room's host now.
    expect(links.send(ROOM, "gameService", "move", { dx: 1 })).toBe(false);
    await loaded();
    expect(peers.made).toEqual(["socket-cy"]);
  });
});
