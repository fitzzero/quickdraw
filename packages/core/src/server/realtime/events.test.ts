// Typed room events (RFC 0003 sections 8.3 and 15): `ctx.rooms.emit` sends
// a contract's event to every socket in a room as `qd:event [service, event,
// payload]`, `emitToUser` to every socket of a user; a payload that fails the
// event's schema fails the call with `INTERNAL` before any frame goes out; an
// undeclared event or an asynchronous schema is the app's mistake; without a
// server nothing is sent, but the payload is still checked.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract, mutation } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, type TestApp } from "../../testing/index";
import { as, projectService, qd, seedBoard, type Board } from "../access/__tests__/board";
import type { Hub } from "../emit/hub";
import { createDispatcher } from "../index";
import { defineLiveService, frames, liveContract, received, settle } from "./__tests__/fixture";
import { createRoomEvents } from "./events";

let h: Harness;
let board: Board;
const apps: TestApp[] = [];

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.database.reset();
  board = await seedBoard(h.prisma);
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

async function start() {
  const app = await createTestApp({
    services: [projectService, defineLiveService(received())],
    db: h.db,
  });
  apps.push(app as unknown as TestApp);
  return app;
}

describe("ctx.rooms.emit", () => {
  it("sends the event to every socket in the room, and to no other", async () => {
    const app = await start();
    const ada = await app.connect(as(board.ada));
    const bo = await app.connect(as(board.bo));
    const cy = await app.connect(as(board.cy));
    const seen = {
      ada: frames(ada, "qd:event"),
      bo: frames(bo, "qd:event"),
      cy: frames(cy, "qd:event"),
    };
    await ada.call.taskService.enter({ room: "lobby" });
    await bo.call.taskService.enter({ room: "lobby" });
    expect(await cy.call.taskService.celebrate({ room: "lobby", taskId: board.t1 })).toBeNull();
    await Promise.all([settle(ada), settle(bo), settle(cy)]);
    const event = ["taskService", "celebrated", { taskId: board.t1 }];
    expect(seen).toEqual({ ada: [event], bo: [event], cy: [] });
  });

  it("sends emitToUser to every socket of the user", async () => {
    const app = await start();
    const ada1 = await app.connect(as(board.ada));
    const ada2 = await app.connect(as(board.ada));
    const cy = await app.connect(as(board.cy));
    const seen = [frames(ada1, "qd:event"), frames(ada2, "qd:event"), frames(cy, "qd:event")];
    await app.as(as(board.cy)).taskService.celebrateUser({ userId: board.ada, taskId: board.t2 });
    await Promise.all([settle(ada1), settle(ada2), settle(cy)]);
    const event = ["taskService", "celebrated", { taskId: board.t2 }];
    expect(seen).toEqual([[event], [event], []]);
  });

  it("fails the call with INTERNAL, sending nothing, when the payload fails the event's schema", async () => {
    const app = await start();
    const ada = await app.connect(as(board.ada));
    await ada.call.taskService.enter({ room: "lobby" });
    await expect(ada.call.taskService.celebrateBadly({ room: "lobby" })).rejects.toMatchObject({
      code: "INTERNAL",
    });
    await settle(ada);
    expect(app.frames({ event: "qd:event" })).toEqual([]);
  });

  it("checks the payload but sends nothing without a server", async () => {
    const dispatcher = createDispatcher({
      services: [projectService, defineLiveService(received())],
      db: h.db,
    });
    const caller = dispatcher.caller(as(board.ada)).taskService;
    expect(await caller.celebrate({ room: "lobby", taskId: board.t1 })).toBeNull();
    await expect(caller.celebrateBadly({ room: "lobby" })).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });
});

describe("the event checks", () => {
  const sent: unknown[][] = [];
  const hub = {
    io: {
      to: (room: string) => ({
        emit: (...args: unknown[]) => {
          sent.push([room, ...args]);
        },
      }),
    },
  } as unknown as Hub;
  const events = createRoomEvents(hub);
  const loose = events as unknown as {
    emit(room: unknown, contract: unknown, event: unknown, payload: unknown): void;
    emitToUser(userId: unknown, contract: unknown, event: unknown, payload: unknown): void;
  };

  it("refuse an event the contract does not declare, and rooms and users that are not names", () => {
    expect(() => {
      loose.emit("lobby", liveContract, "nope", {});
    }).toThrow('ctx.rooms.emit: taskService declares no event "nope"');
    expect(() => {
      loose.emit("lobby", liveContract, "__proto__", {});
    }).toThrow('declares no event "__proto__"');
    expect(() => {
      loose.emit("", liveContract, "celebrated", { taskId: "t1" });
    }).toThrow("room must be a non-empty string");
    expect(() => {
      loose.emitToUser(undefined, liveContract, "celebrated", { taskId: "t1" });
    }).toThrow("userId must be a non-empty string");
    expect(sent).toEqual([]);
  });

  it("send the validated payload, as one qd:event frame: keys the schema does not name are stripped", () => {
    const extra = { taskId: "t1", secret: "not in the schema" } as { taskId: string };
    events.emit("lobby", liveContract, "celebrated", extra);
    events.emitToUser("u1", liveContract, "celebrated", { taskId: "t2" });
    expect(sent).toEqual([
      ["lobby", "qd:event", ["taskService", "celebrated", { taskId: "t1" }]],
      ["user:u1", "qd:event", ["taskService", "celebrated", { taskId: "t2" }]],
    ]);
  });

  it("refuse a schema that validates asynchronously", () => {
    const slow = defineContract("slowService", {
      events: {
        later: {
          payload: {
            "~standard": {
              version: 1 as const,
              vendor: "test",
              validate: (value: unknown) => Promise.resolve({ value }),
            },
          },
        },
      },
    });
    expect(() => {
      events.emit("lobby", slow, "later", {});
    }).toThrow("its schema validates asynchronously");
  });
});

describe("events in a handler's types", () => {
  it("are typed by the contract", () => {
    const typed = defineContract("typedService", {
      methods: { ping: mutation({ input: z.object({ room: z.string() }), output: z.null() }) },
      events: { pinged: { payload: z.object({ at: z.number() }) } },
    });
    const service = qd.defineService(typed, {
      methods: {
        ping: {
          access: "authenticated",
          handler: ({ input, ctx }) => {
            ctx.rooms.emit(input.room, typed, "pinged", { at: 1 });
            // @ts-expect-error -- the payload's at is a number
            ctx.rooms.emit(input.room, typed, "pinged", { at: "now" });
            // @ts-expect-error -- typedService declares no event "pong"
            ctx.rooms.emit(input.room, typed, "pong", { at: 1 });
            return null;
          },
        },
      },
    });
    expect(service.name).toBe("typedService");
  });
});
