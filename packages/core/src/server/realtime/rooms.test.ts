// App rooms from code that is not a handler, and leaving them (RFC 0003
// section 12.5, pack H child 3's open questions): `qd.rooms` /
// `server.rooms` send a contract's event to a room from a game loop or a job;
// `rooms.leave(room, { userId })` takes every socket of a user out of a room,
// from a handler or from outside one, so they stop hearing it and a channel
// requiring the room drops their messages; `onRoomLeave` hears once per
// socket that leaves (its own leave, a removal, a disconnect) whether it was
// its user's last socket in the room, and runs in a unit of work of its own.
//
// In the cluster projects (`bun run test:cluster`) every test here runs with
// the clients on node A and `app.server`, `app.as` and `qd` on node B: an
// event sent on B reaches A's sockets, a removal on B takes A's sockets out
// before it resolves, and the hook fires once, on A.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { inCluster } from "../../../test/cluster/mode";
import { defineContract } from "../../contract/defineContract";
import type { EventFrame, PresenceFrame } from "../../protocol/envelope";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { as, projectService, qd, seedBoard, type Board } from "../access/__tests__/board";
import { initQuickdraw, type Principal, type RoomLeave, type RoomLeaveHandler } from "../index";
import {
  defineLiveService,
  frames,
  liveContract,
  LOBBY,
  received,
  send,
  settle,
} from "./__tests__/fixture";

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

interface StartOptions {
  readonly onRoomLeave?: RoomLeaveHandler;
  /** Behind a cluster adapter that is still in memory, for the path that asks every node. */
  readonly cluster?: boolean;
}

async function start(options: StartOptions = {}) {
  const into = received();
  const app = await createTestApp({
    services: [projectService, defineLiveService(into)],
    db: h.db,
    ...(options.onRoomLeave === undefined ? {} : { onRoomLeave: options.onRoomLeave }),
  });
  apps.push(app as unknown as TestApp);
  if (options.cluster === true && !inCluster()) {
    // Any adapter other than the one the server was created with counts as a
    // cluster adapter (`transports/pushes.ts`); this one still answers
    // `fetchSockets` from this process, through the cluster path.
    const { io } = app.server;
    const InMemory = io.adapter() as unknown as new (...args: never[]) => object;
    class Cluster extends InMemory {}
    io.adapter(Cluster as unknown as Parameters<typeof io.adapter>[0]);
  }
  return { app, into };
}

type App = Awaited<ReturnType<typeof start>>["app"];

/** A socket acting as `principal`, with the events and presence frames it receives. */
async function member(app: App, principal: Principal | null) {
  const connection = await app.connect(principal);
  return {
    connection,
    events: frames<EventFrame>(connection, "qd:event"),
    presence: frames<PresenceFrame>(connection, "qd:presence"),
  };
}

type Member = Awaited<ReturnType<typeof member>>;

async function settleAll(...members: readonly Member[]): Promise<void> {
  await Promise.all(members.map(async ({ connection }) => await settle(connection)));
}

/** Records every leave the hook hears, in order. */
function leaves(): { readonly heard: RoomLeave[]; readonly hook: RoomLeaveHandler } {
  const heard: RoomLeave[] = [];
  return {
    heard,
    hook: (leave) => {
      heard.push(leave);
    },
  };
}

const celebrated = (taskId: string): EventFrame => ["taskService", "celebrated", { taskId }];

describe("a game loop's room, from outside any handler", () => {
  it("reaches the room's sockets, stops once a player is taken out, and the hook hears it once", async () => {
    // In the cluster projects: the clients sit on node A, `app.server` is node B.
    const { heard, hook } = leaves();
    const { app } = await start({ onRoomLeave: hook });
    const player = await member(app, as(board.ada));
    const watcher = await member(app, as(board.bo));
    await player.connection.call.taskService.enter({ room: "world" });
    await watcher.connection.call.taskService.enter({ room: "world" });
    app.server.rooms.emit("world", liveContract, "celebrated", { taskId: board.t1 });
    await settleAll(player, watcher);
    expect([player.events, watcher.events]).toEqual([
      [celebrated(board.t1)],
      [celebrated(board.t1)],
    ]);
    await app.server.rooms.leave("world", { userId: board.ada });
    app.server.rooms.emit("world", liveContract, "celebrated", { taskId: board.t2 });
    await settleAll(player, watcher);
    expect([player.events, watcher.events]).toEqual([
      [celebrated(board.t1)],
      [celebrated(board.t1), celebrated(board.t2)],
    ]);
    await vi.waitFor(() => {
      expect(heard).toHaveLength(1);
    });
    expect(heard).toEqual([
      {
        principal: expect.objectContaining({ userId: board.ada }),
        socketId: player.connection.socket.id,
        reason: "removed",
        rooms: [{ room: "world", last: true }],
      },
    ]);
  });
});

describe("qd.rooms and server.rooms", () => {
  it("send a contract's event from outside a handler to every socket in the room, on every node", async () => {
    const { app } = await start();
    const ada = await member(app, as(board.ada));
    const bo = await member(app, as(board.bo));
    await ada.connection.call.taskService.enter({ room: "lobby" });
    app.server.rooms.emit("lobby", liveContract, "celebrated", { taskId: board.t1 });
    qd.rooms.emit("lobby", liveContract, "celebrated", { taskId: board.t2 });
    qd.rooms.emitToUser(board.bo, liveContract, "celebrated", { taskId: board.t1 });
    await settleAll(ada, bo);
    expect(ada.events).toEqual([celebrated(board.t1), celebrated(board.t2)]);
    expect(bo.events).toEqual([celebrated(board.t1)]);
  });

  it("check the payload first, sending nothing for one that fails the event's schema", async () => {
    const { app } = await start();
    const ada = await member(app, as(board.ada));
    await ada.connection.call.taskService.enter({ room: "lobby" });
    const bad = { taskId: 42 } as unknown as { taskId: string };
    expect(() => {
      app.server.rooms.emit("lobby", liveContract, "celebrated", bad);
    }).toThrow(expect.objectContaining({ code: "INTERNAL" }));
    await settleAll(ada);
    expect(ada.events).toEqual([]);
  });

  it("need a dispatcher: qd.rooms of an instance that never made one throws INTERNAL", async () => {
    const fresh = initQuickdraw();
    expect(() => {
      fresh.rooms.emit("lobby", liveContract, "celebrated", { taskId: "t" });
    }).toThrow(expect.objectContaining({ code: "INTERNAL" }));
    await expect(fresh.rooms.leave("lobby", { userId: "u" })).rejects.toMatchObject({
      code: "INTERNAL",
    });
  });
});

describe("rooms.leave(room, { userId })", () => {
  it("takes every socket of the user out of the room, on every node: they hear nothing more of it", async () => {
    const { app } = await start();
    const ada1 = await member(app, as(board.ada));
    const ada2 = await member(app, as(board.ada));
    const bo = await member(app, as(board.bo));
    for (const each of [ada1, ada2, bo]) {
      await each.connection.call.taskService.enter({ room: "lobby" });
    }
    await app.server.rooms.leave("lobby", { userId: board.ada });
    app.server.rooms.emit("lobby", liveContract, "celebrated", { taskId: board.t1 });
    await settleAll(ada1, ada2, bo);
    expect(ada1.events).toEqual([]);
    expect(ada2.events).toEqual([]);
    expect(bo.events).toEqual([celebrated(board.t1)]);
    // Each removed socket is told it sees nobody now; the room hears the user left.
    expect(ada1.presence.at(-1)).toEqual({ room: "lobby", users: [] });
    expect(ada2.presence.at(-1)).toEqual({ room: "lobby", users: [] });
    expect(bo.presence).toContainEqual({ room: "lobby", left: board.ada });
    expect(await qd.presence.users("lobby")).toEqual([board.bo]);
  });

  it("drops the removed user's messages on a channel that requires the room", async () => {
    const { app, into } = await start();
    const ada = await member(app, as(board.ada));
    const bo = await member(app, as(board.bo));
    await ada.connection.call.taskService.enter({ room: LOBBY });
    await bo.connection.call.taskService.enter({ room: LOBBY });
    await qd.rooms.leave(LOBBY, { userId: board.ada });
    send(ada.connection, "shout", { n: 1 });
    send(bo.connection, "shout", { n: 2 });
    await settleAll(ada, bo);
    expect(into.shout.map(({ userId, n }) => ({ userId, n }))).toEqual([
      { userId: board.bo, n: 2 },
    ]);
  });

  it("works from a handler, with or without a socket, and from a method that shares its runs", async () => {
    const { app } = await start();
    const ada = await member(app, as(board.ada));
    const cy = await member(app, as(board.cy));
    await ada.connection.call.taskService.enter({ room: "lobby" });
    await cy.connection.call.taskService.enter({ room: "lobby" });
    // In process: no socket of the caller's own is involved.
    expect(
      await app.as(as(board.bo)).taskService.kick({ room: "lobby", userId: board.ada }),
    ).toBeNull();
    // Over a socket, the caller takes another user out.
    expect(
      await ada.connection.call.taskService.kick({ room: "lobby", userId: board.cy }),
    ).toBeNull();
    app.server.rooms.emit("lobby", liveContract, "celebrated", { taskId: board.t1 });
    await settleAll(ada, cy);
    expect([ada.events, cy.events]).toEqual([[], []]);
    expect(await qd.presence.users("lobby")).toEqual([]);
  });

  it("refuses the framework's rooms and a target without a user", async () => {
    const { app } = await start();
    await expect(
      app.server.rooms.leave(`user:${board.ada}`, { userId: board.ada }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      app.server.rooms.leave("qd:e:taskService:x@Read", { userId: board.ada }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      app.server.rooms.leave("lobby", {} as unknown as { userId: string }),
    ).rejects.toThrow("pass { userId }");
  });

  it("is nothing to do for a user with no socket in the room", async () => {
    const { app } = await start();
    const bo = await member(app, as(board.bo));
    await bo.connection.call.taskService.enter({ room: "lobby" });
    await app.server.rooms.leave("lobby", { userId: board.ada });
    await settleAll(bo);
    expect(bo.presence.filter((frame) => frame.left !== undefined)).toEqual([]);
    expect(await qd.presence.users("lobby")).toEqual([board.bo]);
  });
});

describe("onRoomLeave", () => {
  it("hears each socket once, with whether it was its user's last in the room", async () => {
    const { heard, hook } = leaves();
    const { app } = await start({ onRoomLeave: hook });
    const ada1 = await member(app, as(board.ada));
    const ada2 = await member(app, as(board.ada));
    await ada1.connection.call.taskService.enter({ room: "lobby" });
    await ada2.connection.call.taskService.enter({ room: "lobby" });
    await ada2.connection.call.taskService.enter({ room: "hall" });
    await ada1.connection.call.taskService.exit({ room: "lobby" });
    await vi.waitFor(() => {
      expect(heard).toHaveLength(1);
    });
    const ada2Id = ada2.connection.socket.id ?? "";
    ada2.connection.close();
    await vi.waitFor(() => {
      expect(heard).toHaveLength(2);
    });
    expect(heard).toEqual([
      {
        principal: expect.objectContaining({ userId: board.ada }),
        socketId: ada1.connection.socket.id,
        reason: "leave",
        // ada's other socket is still in the lobby.
        rooms: [{ room: "lobby", last: false }],
      },
      {
        principal: expect.objectContaining({ userId: board.ada }),
        socketId: ada2Id,
        reason: "disconnect",
        rooms: [
          { room: "lobby", last: true },
          { room: "hall", last: true },
        ],
      },
    ]);
  });

  it("hears a removal once per removed socket, and an anonymous socket as its own last", async () => {
    const { heard, hook } = leaves();
    const { app } = await start({ onRoomLeave: hook });
    const ada1 = await member(app, as(board.ada));
    const ada2 = await member(app, as(board.ada));
    const spectator = await member(app, null);
    for (const each of [ada1, ada2]) {
      await each.connection.call.taskService.enter({ room: "lobby" });
    }
    await spectator.connection.call.taskService.enterAnyone({ room: "lobby" });
    await app.server.rooms.leave("lobby", { userId: board.ada });
    await vi.waitFor(() => {
      expect(heard).toHaveLength(2);
    });
    expect(heard.map(({ reason, rooms }) => ({ reason, rooms }))).toEqual([
      { reason: "removed", rooms: [{ room: "lobby", last: false }] },
      { reason: "removed", rooms: [{ room: "lobby", last: true }] },
    ]);
    expect(new Set(heard.map(({ socketId }) => socketId))).toEqual(
      new Set([ada1.connection.socket.id, ada2.connection.socket.id]),
    );
    heard.length = 0;
    spectator.connection.close();
    await vi.waitFor(() => {
      expect(heard).toHaveLength(1);
    });
    expect(heard[0]).toMatchObject({
      principal: null,
      reason: "disconnect",
      rooms: [{ room: "lobby", last: true }],
    });
  });

  it("asks every node whether the user is still in the room behind a cluster adapter", async () => {
    const { heard, hook } = leaves();
    const { app } = await start({ onRoomLeave: hook, cluster: true });
    const ada1 = await member(app, as(board.ada));
    const ada2 = await member(app, as(board.ada));
    await ada1.connection.call.taskService.enter({ room: "lobby" });
    await ada2.connection.call.taskService.enter({ room: "lobby" });
    ada1.connection.close();
    await vi.waitFor(() => {
      expect(heard).toHaveLength(1);
    });
    ada2.connection.close();
    await vi.waitFor(() => {
      expect(heard).toHaveLength(2);
    });
    expect(heard.map(({ rooms }) => rooms)).toEqual([
      [{ room: "lobby", last: false }],
      [{ room: "lobby", last: true }],
    ]);
  });

  it("is never heard for a socket that was in no app room", async () => {
    const { heard, hook } = leaves();
    const { app } = await start({ onRoomLeave: hook });
    const ada = await member(app, as(board.ada));
    await ada.connection.call.taskService.exit({ room: "lobby" });
    ada.connection.close();
    await app.close();
    expect(heard).toEqual([]);
  });

  it("runs in a unit of work of its own: its writes flush, never with the handler that left", async () => {
    const writes: string[] = [];
    const { app } = await start({
      onRoomLeave: async ({ principal }) => {
        await h.db.task.update({ where: { id: board.t1 }, data: { title: "Left" } });
        writes.push(principal?.userId ?? "anonymous");
      },
    });
    const watcher = await app.connect(as(board.ada));
    const updates = frames<{ t: string; id: string; d?: { title?: string } }>(watcher, "qd:e");
    await emitWithAck(watcher.socket, "qd:sub", { s: "taskService", ids: [board.t1] });
    const cy = await member(app, as(board.cy));
    await cy.connection.call.taskService.enter({ room: "lobby" });
    await cy.connection.call.taskService.exit({ room: "lobby" });
    await vi.waitFor(async () => {
      await settle(watcher);
      expect(updates.map((frame) => frame.d?.title)).toContain("Left");
    });
    expect(writes).toEqual([board.cy]);
  });

  it("logs what the hook throws, and carries on", async () => {
    const errors: unknown[] = [];
    const app = await createTestApp({
      services: [projectService, defineLiveService(received())],
      db: h.db,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (message: string, meta?: Record<string, unknown>) => {
          errors.push({ message, ...meta });
        },
        child() {
          return this;
        },
      },
      onRoomLeave: () => {
        throw new Error("hook boom");
      },
    });
    apps.push(app as unknown as TestApp);
    const ada = await app.connect(as(board.ada));
    await ada.call.taskService.enter({ room: "lobby" });
    expect(await ada.call.taskService.exit({ room: "lobby" })).toBe(true);
    await vi.waitFor(() => {
      expect(errors).toContainEqual(
        expect.objectContaining({ message: "onRoomLeave threw", reason: "leave" }),
      );
    });
  });

  it("refuses a hook that is not a function", async () => {
    await expect(
      createTestApp({
        services: [projectService],
        db: h.db,
        onRoomLeave: "nope" as unknown as RoomLeaveHandler,
      }),
    ).rejects.toThrow("onRoomLeave must be a function");
  });
});

describe("a service's own onRoomLeave", () => {
  /** A service that only hears leaves: its hook is all it declares. */
  const hall = defineContract("hallService", {});

  it("runs in every server the service runs in, createTestApp included, with no option of its own", async () => {
    const { heard, hook } = leaves();
    const app = await createTestApp({
      services: [projectService, defineLiveService(received(), { onRoomLeave: hook })],
      db: h.db,
    });
    apps.push(app as unknown as TestApp);
    const ada = await member(app, as(board.ada));
    await ada.connection.call.taskService.enter({ room: "lobby" });
    await ada.connection.call.taskService.enter({ room: "hall" });
    await ada.connection.call.taskService.exit({ room: "hall" });
    await vi.waitFor(() => {
      expect(heard).toHaveLength(1);
    });
    ada.connection.close();
    await vi.waitFor(() => {
      expect(heard).toHaveLength(2);
    });
    expect(heard.map(({ reason, rooms }) => ({ reason, rooms }))).toEqual([
      { reason: "leave", rooms: [{ room: "hall", last: true }] },
      { reason: "disconnect", rooms: [{ room: "lobby", last: true }] },
    ]);
  });

  it("runs beside every other service's and the server's, once each per leave; one that throws stops none", async () => {
    const live = leaves();
    const server = leaves();
    const errors: Record<string, unknown>[] = [];
    let hallRuns = 0;
    const hallService = qd.defineService(hall, {
      methods: {},
      onRoomLeave: () => {
        hallRuns += 1;
        throw new Error("hall boom");
      },
    });
    const app = await createTestApp({
      services: [
        projectService,
        defineLiveService(received(), { onRoomLeave: live.hook }),
        hallService,
      ],
      db: h.db,
      logger: {
        debug: () => undefined,
        info: () => undefined,
        warn: () => undefined,
        error: (message: string, meta?: Record<string, unknown>) => {
          errors.push({ message, ...meta });
        },
        child() {
          return this;
        },
      },
      onRoomLeave: server.hook,
    });
    apps.push(app as unknown as TestApp);
    const cy = await member(app, as(board.cy));
    await cy.connection.call.taskService.enter({ room: "lobby" });
    await app.server.rooms.leave("lobby", { userId: board.cy });
    await vi.waitFor(() => {
      expect([live.heard.length, server.heard.length, hallRuns]).toEqual([1, 1, 1]);
    });
    expect(live.heard[0]).toEqual(server.heard[0]);
    expect(live.heard[0]).toMatchObject({
      reason: "removed",
      rooms: [{ room: "lobby", last: true }],
    });
    await vi.waitFor(() => {
      expect(errors).toContainEqual(
        expect.objectContaining({ message: "onRoomLeave threw", owner: "hallService" }),
      );
    });
  });

  it("refuses a hook that is not a function when the service is defined", () => {
    expect(() =>
      (qd.defineService as unknown as (contract: unknown, definition: unknown) => unknown)(hall, {
        methods: {},
        onRoomLeave: { onLeave: () => undefined },
      }),
    ).toThrow('defineService("hallService"): onRoomLeave must be a function');
  });
});
