import { describe, expect, it } from "vitest";
import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  collectionRoom,
  entityRoom,
  topicRoom,
  userRoom,
} from "./names";

describe("room names", () => {
  it("names an entity room per access tier", () => {
    expect(entityRoom("taskService", "t1", "Read")).toBe("qd:e:taskService:t1@Read");
    expect(entityRoom("taskService", "t1", "Admin")).toBe("qd:e:taskService:t1@Admin");
  });

  it("names collection, topic and user rooms", () => {
    expect(collectionRoom("taskService", "byProject", "p1")).toBe("qd:c:taskService:byProject:p1");
    expect(topicRoom("taskService", "byProject:p1")).toBe("qd:t:taskService:byProject:p1");
    expect(userRoom("u1")).toBe("user:u1");
  });
});

describe("event names", () => {
  it("lists every protocol v5 event once, under the qd: prefix", () => {
    const names = [...Object.values(CLIENT_EVENTS), ...Object.values(SERVER_EVENTS)];
    expect(names).toHaveLength(21);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.startsWith("qd:"))).toBe(true);
  });

  it("matches RFC 0003 section 8", () => {
    expect(CLIENT_EVENTS.call).toBe("qd:call");
    expect(CLIENT_EVENTS.collectionSub).toBe("qd:col:sub");
    expect(CLIENT_EVENTS.channel).toBe("qd:ch");
    expect(SERVER_EVENTS.entity).toBe("qd:e");
    expect(SERVER_EVENTS.collection).toBe("qd:c");
    expect(Object.isFrozen(CLIENT_EVENTS) && Object.isFrozen(SERVER_EVENTS)).toBe(true);
  });
});
