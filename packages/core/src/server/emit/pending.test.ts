// The in-flight bookkeeping behind unsubscribe races (`pending.ts`): an
// unsubscribe is counted only while a subscribe of its key runs, so a client
// unsubscribing from keys it never subscribed to leaves nothing behind. 4.x
// and the first 5.0 cut kept a count per key ever unsubscribed, per socket,
// for the socket's life: 480,000 unique ids from one anonymous socket held
// about 90 MB.

import { describe, expect, it } from "vitest";
import { ScopeIndex } from "../collections/scopes";
import { TopicIndex } from "../topicIndex";
import type { QuickdrawServerSocket } from "../transports/types";
import { PendingKeys } from "./pending";
import { SubscriptionIndex } from "./subscriptions";

/** A socket as the indexes see it: a key, with data, that never joins a room. */
function fakeSocket(): QuickdrawServerSocket {
  return {
    connected: true,
    data: { principal: { userId: "u1" }, protocol: 5 },
    join: () => undefined,
    leave: () => undefined,
  } as unknown as QuickdrawServerSocket;
}

describe("PendingKeys", () => {
  it("counts unsubscribes only while a subscribe of the key is in flight", () => {
    const pending = new PendingKeys();
    const socket = fakeSocket();
    pending.unsubscribed(socket, "a");
    expect(pending.size(socket)).toBe(0);
    expect(pending.begin(socket, ["a", "b", "a"])).toEqual(
      new Map([
        ["a", 0],
        ["b", 0],
      ]),
    );
    pending.unsubscribed(socket, "a");
    // A second subscribe of the key, begun after the unsubscribe, starts from it.
    expect(pending.begin(socket, ["a"]).get("a")).toBe(1);
    expect(pending.count(socket, "a")).toBe(1);
    pending.end(socket, ["a", "b"]);
    expect(pending.count(socket, "a")).toBe(1);
    expect(pending.size(socket)).toBe(1);
    pending.end(socket, ["a"]);
    expect(pending.size(socket)).toBe(0);
    expect(pending.count(socket, "a")).toBe(0);
  });

  it("keeps nothing for 480,000 unsubscribes from keys never subscribed to", () => {
    const socket = fakeSocket();
    const entities = new SubscriptionIndex();
    const scopes = new ScopeIndex();
    const topics = new TopicIndex();
    for (let index = 0; index < 480_000; index += 1) {
      entities.unsubscribe(socket, "taskService", `row-${index}`);
      scopes.unsubscribe(socket, `qd:c:taskService:byProject:${index}`);
      topics.unwatch(socket, `qd:t:taskService:byProject:${index}`);
    }
    expect(entities.pending.size(socket)).toBe(0);
    expect(entities.unsubscribes(socket, "taskService", "row-1")).toBe(0);
    expect(scopes.unsubscribes(socket, "qd:c:taskService:byProject:1")).toBe(0);
    expect(topics.unwatches(socket, "qd:t:taskService:byProject:1")).toBe(0);
  });

  it("still stops a subscribe in flight from joining a scope or topic unsubscribed meanwhile", () => {
    const socket = fakeSocket();
    const scopes = new ScopeIndex();
    const topics = new TopicIndex();
    const room = "qd:c:taskService:byProject:p1";
    const topic = "qd:t:taskService:byProject:p1";
    const scopeAtStart = scopes.begin(socket, room);
    const topicAtStart = topics.begin(socket, topic);
    scopes.unsubscribe(socket, room);
    topics.unwatch(socket, topic);
    expect(scopes.unsubscribes(socket, room)).toBe(scopeAtStart + 1);
    expect(topics.unwatches(socket, topic)).toBe(topicAtStart + 1);
    scopes.end(socket, room);
    topics.end(socket, topic);
    expect(scopes.unsubscribes(socket, room)).toBe(0);
  });
});
