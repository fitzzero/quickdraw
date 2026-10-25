// A node's presence requests to the other nodes (the 5.1 audit's RT-5),
// against a server that stands in for Socket.IO behind the Redis adapter:
// requests are coalesced per key without handing a caller an answer read
// before it asked, only ids count, a node answers from its app-room records
// alone, and a request a node did not answer in time counts the answers the
// adapter handed over, warns how many came, and reads no node's sockets.
// Two real servers on one bus are `presence.test.ts`'s.

import { describe, expect, it, vi } from "vitest";
import { captureLogger, deferred, type Deferred } from "../__tests__/fixtures";
import { ADAPTER_MARGIN_MS, CLUSTER_ADAPTER_TIMEOUT_MS, requestDeadlineOf } from "../cluster/acks";
import { registerDeployment } from "../cluster/deployment";
import type { Hub } from "../emit/hub";
import type { QuickdrawIo } from "../transports/types";
import { PresenceRecords, usersInRoom } from "./presence";
import { createPresenceRequests, PRESENCE_EVENT, PRESENCE_WARN_EVERY_MS } from "./presenceRequests";

/** What Socket.IO rejects an answered event with on the adapter's own timeout: the answers that came. */
function timedOut(responses: unknown[]): Error {
  return Object.assign(
    new Error(`timeout reached: only ${responses.length} responses received out of 2`),
    { responses },
  );
}

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

  it("wait the adapter's own request timeout and a margin when it has one, else cluster.timeoutMs", () => {
    const { io, hub } = fakeServer();
    const server = io as unknown as QuickdrawIo;
    expect(requestDeadlineOf(hub, server)).toBe(50);
    Object.assign(io.sockets.adapter, { requestsTimeout: 5000 });
    expect(requestDeadlineOf(hub, server)).toBe(5000 + ADAPTER_MARGIN_MS);
    for (const unusable of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31, "5000"]) {
      Object.assign(io.sockets.adapter, { requestsTimeout: unusable });
      expect(requestDeadlineOf(hub, server)).toBe(50);
    }
  });

  it("wait the fixed 5 s of socket.io-adapter's cluster adapter, which exposes no request timeout", () => {
    const { io, hub } = fakeServer();
    const server = io as unknown as QuickdrawIo;
    // The hooks a ClusterAdapter asks of every subclass, and its own publishAndReturnOffset.
    const hooks = {
      doPublish: () => Promise.resolve("offset"),
      doPublishResponse: () => Promise.resolve(),
      publishAndReturnOffset: () => Promise.resolve("offset"),
    };
    Object.assign(io.sockets.adapter, hooks);
    expect(requestDeadlineOf(hub, server)).toBe(CLUSTER_ADAPTER_TIMEOUT_MS + ADAPTER_MARGIN_MS);
    // A request timeout it does expose comes first.
    Object.assign(io.sockets.adapter, { requestsTimeout: 800 });
    expect(requestDeadlineOf(hub, server)).toBe(800 + ADAPTER_MARGIN_MS);
    // Half of the hooks is no cluster adapter.
    const { io: other, hub: otherHub } = fakeServer();
    Object.assign(other.sockets.adapter, { doPublish: hooks.doPublish });
    expect(requestDeadlineOf(otherHub, other as unknown as QuickdrawIo)).toBe(50);
  });

  it("count the answers that came when a node did not answer in time, warn how many, and read no node's sockets", async () => {
    const { hub, asked, fetched, logger } = fakeServer();
    let clock = 1_000;
    const requests = createPresenceRequests(hub, new PresenceRecords(), () => clock);
    const warnings = () => logger.at("warn").map(({ message }) => message);
    // One node answered, one did not: the adapter's own timeout hands over the answer that came.
    const users = requests.users("lobby");
    asked[0]?.reject(timedOut([["ada"]]));
    expect(await users).toEqual(["ada"]);
    expect(warnings()).toEqual([
      expect.stringContaining("did not answer a presence request in time: 1 other node answered"),
    ]);
    expect(logger.at("warn")[0]?.meta).toMatchObject({
      answered: 1,
      reason: "timeout reached: only 1 responses received out of 2",
    });
    // No answer before the deadline (cluster.timeoutMs, without an adapter timeout): none of theirs.
    expect(await requests.online("cy")).toBe(false);
    expect(asked).toHaveLength(2);
    expect(warnings()).toHaveLength(1);
    // A stream's count warns on its own.
    const count = requests.sockets("qd:stream:feed");
    asked[2]?.reject(timedOut([2, null]));
    expect(await count).toBe(2);
    expect(warnings()[1]).toContain(
      "did not answer a stream's subscriber count in time: 2 other nodes answered",
    );
    // Ten minutes after the first warning, another.
    clock += PRESENCE_WARN_EVERY_MS;
    const later = requests.users("lobby");
    asked[3]?.reject(timedOut([]));
    expect(await later).toEqual([]);
    expect(warnings()).toHaveLength(3);
    expect(warnings()[2]).toContain("0 other nodes answered");
    expect(fetched).toEqual([]);
  });
});
