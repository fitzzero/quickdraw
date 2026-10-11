// A node's presence requests to the other nodes (the 5.1 audit's RT-5),
// against a server that stands in for Socket.IO behind the Redis adapter:
// requests are coalesced per key without handing a caller an answer read
// before it asked, only ids count, a node answers from its app-room records
// alone, and a request nobody answered falls back to every node's sockets
// for 30 s. Two real servers on one bus are `presence.test.ts`'s.

import { describe, expect, it, vi } from "vitest";
import { captureLogger, deferred, type Deferred } from "../__tests__/fixtures";
import { registerDeployment } from "../cluster/deployment";
import type { Hub } from "../emit/hub";
import { PresenceRecords, usersInRoom } from "./presence";
import {
  createPresenceRequests,
  PRESENCE_EVENT,
  PRESENCE_FALLBACK_MS,
  PRESENCE_WARN_EVERY_MS,
} from "./presenceRequests";

/** A server whose answers the test gives, one request at a time. */
function fakeServer() {
  const asked: Deferred<unknown[]>[] = [];
  const payloads: unknown[] = [];
  const listeners = new Map<string, (...args: unknown[]) => void>();
  const remote = [{ id: "remote-1", data: { principal: { userId: "far" } } }];
  const fetched: string[] = [];
  const io = {
    serverSideEmitWithAck(event: string, payload: unknown) {
      expect(event).toBe(PRESENCE_EVENT);
      payloads.push(payload);
      const answer = deferred<unknown[]>();
      asked.push(answer);
      return answer.promise;
    },
    in(room: string) {
      return {
        fetchSockets: () => {
          fetched.push(room);
          return Promise.resolve(remote);
        },
      };
    },
    on(event: string, listener: (...args: unknown[]) => void) {
      listeners.set(event, listener);
    },
    sockets: {
      sockets: new Map<string, unknown>(),
      adapter: { rooms: new Map<string, Set<string>>([["user:here", new Set(["s1"])]]) },
    },
  };
  registerDeployment(io, "quickdraw");
  const logger = captureLogger();
  const hub = { io, logger, cluster: { timeoutMs: 50 } } as unknown as Hub;
  return { io, hub, logger, asked, payloads, listeners, fetched };
}

describe("presence requests", () => {
  it("share one request in flight and one trailing request per room, sent once the first settles", async () => {
    const { hub, asked, payloads } = fakeServer();
    const requests = createPresenceRequests(hub, new PresenceRecords());
    const a = requests.users("lobby");
    const b = requests.users("lobby");
    const c = requests.users("lobby");
    expect(asked).toHaveLength(1);
    asked[0]?.resolve([["ada"]]);
    expect(await a).toEqual(["ada"]);
    await vi.waitFor(() => {
      expect(asked).toHaveLength(2);
    });
    asked[1]?.resolve([["ada", "cy"]]);
    expect(await b).toEqual(["ada", "cy"]);
    expect(await c).toEqual(["ada", "cy"]);
    expect(asked).toHaveLength(2);
    expect(payloads).toEqual([
      { room: "lobby", deployment: "quickdraw" },
      { room: "lobby", deployment: "quickdraw" },
    ]);
    // Another room, or a user, asks on its own.
    const other = requests.users("world");
    const online = requests.online("bo");
    expect(asked).toHaveLength(4);
    asked[2]?.resolve([]);
    asked[3]?.resolve([false, true]);
    expect(await other).toEqual([]);
    expect(await online).toBe(true);
  });

  it("count ids alone: another deployment's null and anything not an id count for nothing", async () => {
    const { hub, asked } = fakeServer();
    const requests = createPresenceRequests(hub, new PresenceRecords());
    const users = requests.users("lobby");
    asked[0]?.resolve([["ada", 7, "", null], null, "cy", ["ada", "bo"]]);
    expect((await users).sort()).toEqual(["ada", "bo"]);
    const online = requests.online("cy");
    asked[1]?.resolve([null, false]);
    expect(await online).toBe(false);
  });

  it("answer from this node's app-room records alone, and another deployment with null", () => {
    const { io, hub, listeners } = fakeServer();
    const records = new PresenceRecords();
    records.entered("lobby", "ada");
    createPresenceRequests(hub, records).listen();
    const listener = listeners.get(PRESENCE_EVENT);
    const answers: unknown[] = [];
    const answer = (value: unknown) => answers.push(value);
    listener?.({ room: "lobby", deployment: "quickdraw" }, answer);
    listener?.({ room: "raw", deployment: "quickdraw" }, answer);
    listener?.({ userId: "here", deployment: "quickdraw" }, answer);
    listener?.({ userId: "gone", deployment: "quickdraw" }, answer);
    listener?.({ deployment: "quickdraw" }, answer);
    listener?.({ room: "lobby", deployment: "staging" }, answer);
    expect(answers).toEqual([["ada"], [], true, false, null, null]);
    expect(io.sockets.adapter.rooms.has("raw")).toBe(false);
  });

  it("let a room's users be read after the other nodes answered, so a join meanwhile counts", async () => {
    const { hub, asked } = fakeServer();
    const records = new PresenceRecords();
    records.entered("lobby", "here");
    const state = {
      hub: { ...hub, probe: { local: () => false } } as unknown as Hub,
      records,
      requests: createPresenceRequests(hub, records),
    };
    const users = usersInRoom(state, "lobby");
    // A socket joins on this node while the request is out: the list it gets must not undo its `joined`.
    records.entered("lobby", "late");
    asked[0]?.resolve([["ada"]]);
    expect((await users).sort()).toEqual(["ada", "here", "late"]);
  });

  it("read every node's sockets for 30 s after a request nobody answered, warning once an episode", async () => {
    const { hub, asked, fetched, logger } = fakeServer();
    let clock = 1_000;
    const requests = createPresenceRequests(hub, new PresenceRecords(), () => clock);
    // Nobody answers: the request times out (50 ms), and the sockets are read instead.
    expect(await requests.users("lobby")).toEqual(["far"]);
    expect(asked).toHaveLength(1);
    expect(fetched).toEqual(["lobby"]);
    expect(logger.at("warn").map(({ message }) => message)).toEqual([
      expect.stringContaining("did not answer a presence request within cluster.timeoutMs"),
    ]);
    // Within the window: no request at all.
    clock += PRESENCE_FALLBACK_MS - 1;
    expect(await requests.online("cy")).toBe(true);
    expect(asked).toHaveLength(1);
    expect(fetched).toEqual(["lobby", "user:cy"]);
    // Past it: the nodes are asked again.
    clock += 1;
    const users = requests.users("lobby");
    expect(asked).toHaveLength(2);
    asked[1]?.resolve([["ada"]]);
    expect(await users).toEqual(["ada"]);
    expect(logger.at("warn")).toHaveLength(1);
    // Ten minutes after the first warning, a window opens with another.
    clock += PRESENCE_WARN_EVERY_MS;
    expect(await requests.users("lobby")).toEqual(["far"]);
    expect(logger.at("warn")).toHaveLength(2);
  });
});
