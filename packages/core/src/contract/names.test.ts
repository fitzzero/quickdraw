import { describe, expect, it } from "vitest";
import {
  CLIENT_EVENTS,
  RESERVED_ROOM_PREFIXES,
  SERVER_EVENTS,
  SERVICE_TOPIC,
  collectionRoom,
  collectionTopic,
  entityRoom,
  streamRoom,
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

  it("names change topics as RFC 0003 section 11.3 does", () => {
    expect(collectionTopic("byProject", "p1")).toBe("byProject:p1");
    expect(SERVICE_TOPIC).toBe("service");
    expect(topicRoom("taskService", SERVICE_TOPIC)).toBe("qd:t:taskService:service");
  });

  it("names a stream feed's room, with the scope for a scoped stream only", () => {
    expect(streamRoom("taskService", "logs", "t1")).toBe("qd:s:taskService:logs:t1");
    expect(streamRoom("opsService", "metrics")).toBe("qd:s:opsService:metrics");
  });

  it("reserves the framework's room prefixes, which every framework room starts with", () => {
    expect(RESERVED_ROOM_PREFIXES).toEqual(["qd:", "user:"]);
    const rooms = [
      entityRoom("s", "1", "Read"),
      collectionRoom("s", "c", "1"),
      topicRoom("s", "service"),
      streamRoom("s", "n", "1"),
      userRoom("u1"),
    ];
    for (const room of rooms) {
      expect(
        RESERVED_ROOM_PREFIXES.some((prefix) => room.startsWith(prefix)),
        room,
      ).toBe(true);
    }
  });
});

describe("event names", () => {
  it("lists every protocol v5 event once, under the qd: prefix", () => {
    const names = [...Object.values(CLIENT_EVENTS), ...Object.values(SERVER_EVENTS)];
    expect(names).toHaveLength(22);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((name) => name.startsWith("qd:"))).toBe(true);
  });

  it("matches RFC 0003 section 8", () => {
    expect(CLIENT_EVENTS.call).toBe("qd:call");
    expect(CLIENT_EVENTS.collectionSub).toBe("qd:col:sub");
    expect(CLIENT_EVENTS.channel).toBe("qd:ch");
    expect(SERVER_EVENTS.entity).toBe("qd:e");
    expect(SERVER_EVENTS.collection).toBe("qd:c");
    expect(SERVER_EVENTS.presence).toBe("qd:presence");
    expect(CLIENT_EVENTS.streamSub).toBe("qd:stream:sub");
    expect(Object.isFrozen(CLIENT_EVENTS) && Object.isFrozen(SERVER_EVENTS)).toBe(true);
  });
});
