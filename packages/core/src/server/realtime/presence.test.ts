// Presence and app rooms (RFC 0003 sections 3 and 12.5) through a real
// server: a user with two sockets stays online until both close, and is then
// remembered as last seen; `count` and `users` follow joins and leaves;
// `qd:presence` tells each socket in an app room who is there; `ctx.rooms`
// refuses the framework's rooms, joins nothing without a socket, and caps a
// socket's rooms; behind a cluster adapter the answers come from every node.

import { Adapter } from "socket.io-adapter";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PresenceFrame } from "../../protocol/envelope";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, type TestApp, type TestConnection } from "../../testing/index";
import { as, projectService, seedBoard, type Board } from "../access/__tests__/board";
import { createDispatcher, type Principal } from "../index";
import { defineLiveService, frames, received, settle } from "./__tests__/fixture";
import { MAX_APP_ROOMS, PresenceRecords, PRESENCE_MAX_LAST_SEEN } from "./presence";

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

async function start(options: { readonly cluster?: boolean } = {}) {
  const app = await createTestApp({
    services: [projectService, defineLiveService(received())],
    db: h.db,
    // The in-memory adapter, but given as an option: the server then treats it as a cluster adapter.
    ...(options.cluster === true ? { socket: { adapter: Adapter } } : {}),
  });
  apps.push(app as unknown as TestApp);
  return app;
}

type App = Awaited<ReturnType<typeof start>>;

/** A socket acting as `principal`, with the `qd:presence` frames it receives. */
async function connect(app: App, principal: Principal | null) {
  const connection = await app.connect(principal);
  return { connection, presence: frames<PresenceFrame>(connection, "qd:presence") };
}

/** Closes `connection` and waits until the server has handled its disconnect. */
async function close(
  app: App,
  connection: Pick<TestConnection, "socket" | "close">,
): Promise<void> {
  const id = connection.socket.id ?? "";
  connection.close();
  for (let attempt = 0; attempt < 200 && app.server.io.sockets.sockets.has(id); attempt += 1) {
    await new Promise((resolve) => {
      setTimeout(resolve, 5);
    });
  }
}

describe("presence", () => {
  it("keeps a user with two sockets online until both close, then knows when they left", async () => {
    const app = await start();
    const { presence } = app.server;
    expect(await presence.isOnline(board.ada)).toBe(false);
    expect(await presence.lastSeen(board.ada)).toBeNull();
    const first = await app.connect(as(board.ada));
    const second = await app.connect(as(board.ada));
    expect(await presence.isOnline(board.ada)).toBe(true);
    expect(await presence.lastSeen(board.ada)).toBeCloseTo(Date.now(), -3);
    await close(app, first);
    expect(await presence.isOnline(board.ada)).toBe(true);
    const before = Date.now();
    await close(app, second);
    expect(await presence.isOnline(board.ada)).toBe(false);
    const seen = await presence.lastSeen(board.ada);
    expect(seen).toBeGreaterThanOrEqual(before);
    expect(seen).toBeLessThanOrEqual(Date.now());
  });

  it("counts and lists the users in a room as their sockets join and leave", async () => {
    const app = await start();
    const { presence } = app.server;
    const ada1 = await app.connect(as(board.ada));
    const ada2 = await app.connect(as(board.ada));
    const cy = await app.connect(as(board.cy));
    const anonymous = await app.connect(null);
    for (const connection of [ada1, ada2, cy, anonymous]) {
      expect(await connection.call.taskService.enterAnyone({ room: "lobby" })).toBe(true);
    }
    expect(await presence.count("lobby")).toBe(2);
    expect((await presence.users("lobby")).sort()).toEqual([board.ada, board.cy].sort());
    expect(await ada1.call.taskService.exit({ room: "lobby" })).toBe(true);
    expect(await presence.count("lobby")).toBe(2);
    await close(app, ada2);
    expect(await presence.users("lobby")).toEqual([board.cy]);
    expect(await presence.count("elsewhere")).toBe(0);
  });

  it("reads the framework's rooms from the adapter", async () => {
    const app = await start();
    const cy = await app.connect(as(board.cy));
    await cy.call.taskService.get({ id: board.t1 });
    const reply = await cy.socket.timeout(5000).emitWithAck("qd:sub", {
      s: "taskService",
      ids: [board.t1],
    });
    expect(reply).toMatchObject({ ok: true });
    expect(await app.server.presence.users(`qd:e:taskService:${board.t1}@Read`)).toEqual([
      board.cy,
    ]);
    expect(await app.server.presence.users(`user:${board.cy}`)).toEqual([board.cy]);
  });

  it("rejects an argument that is not a name", async () => {
    const app = await start();
    const loose = app.server.presence as unknown as Record<
      string,
      (value: unknown) => Promise<unknown>
    >;
    for (const member of ["isOnline", "lastSeen", "count", "users"]) {
      await expect(loose[member]?.("")).rejects.toThrow(
        `presence.${member}: pass a non-empty string`,
      );
    }
  });

  it("sees nobody before a server attaches", async () => {
    const dispatcher = createDispatcher({ services: [projectService], db: h.db });
    expect(await dispatcher.presence.isOnline(board.ada)).toBe(false);
    expect(await dispatcher.presence.users("lobby")).toEqual([]);
  });
});

describe("qd:presence", () => {
  it("gives a joining socket the list, then tells the room who joins and who leaves", async () => {
    const app = await start();
    const ada = await connect(app, as(board.ada));
    const cy1 = await connect(app, as(board.cy));
    const cy2 = await connect(app, as(board.cy));
    await ada.connection.call.taskService.enter({ room: "lobby" });
    await cy1.connection.call.taskService.enter({ room: "lobby" });
    await cy2.connection.call.taskService.enter({ room: "lobby" });
    await Promise.all([settle(ada.connection), settle(cy1.connection), settle(cy2.connection)]);
    expect(ada.presence).toEqual([
      { room: "lobby", users: [board.ada] },
      { room: "lobby", joined: board.cy },
    ]);
    expect(cy1.presence).toEqual([{ room: "lobby", users: [board.ada, board.cy] }]);
    expect(cy2.presence).toEqual([{ room: "lobby", users: [board.ada, board.cy] }]);
    // Cy keeps a socket in the room: nobody hears of the first one leaving but itself.
    await cy1.connection.call.taskService.exit({ room: "lobby" });
    await close(app, cy2.connection);
    await settle(ada.connection);
    expect(cy1.presence.at(-1)).toEqual({ room: "lobby", users: [] });
    expect(ada.presence.slice(2)).toEqual([{ room: "lobby", left: board.cy }]);
  });

  it("lists no anonymous socket, and tells nobody of one", async () => {
    const app = await start();
    const ada = await connect(app, as(board.ada));
    const anonymous = await connect(app, null);
    await ada.connection.call.taskService.enter({ room: "lobby" });
    expect(await anonymous.connection.call.taskService.enterAnyone({ room: "lobby" })).toBe(true);
    await settle(ada.connection);
    expect(ada.presence).toEqual([{ room: "lobby", users: [board.ada] }]);
  });
});

describe("ctx.rooms.join and leave", () => {
  it("refuse the framework's rooms and names that cannot be rooms", async () => {
    const app = await start();
    const cy = await app.connect(as(board.cy));
    const rooms = [
      `qd:e:taskService:${board.t1}@Admin`,
      `qd:c:taskService:byProject:${board.p2}`,
      `user:${board.ada}`,
      "",
      "x".repeat(257),
    ];
    for (const room of rooms) {
      await expect(cy.call.taskService.enter({ room })).rejects.toMatchObject({
        code: "VALIDATION",
      });
    }
    await expect(cy.call.taskService.exit({ room: `user:${board.ada}` })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    const socket = app.server.io.sockets.sockets.get(cy.socket.id ?? "");
    expect([...(socket?.rooms ?? [])].sort()).toEqual([cy.socket.id, `user:${board.cy}`].sort());
  });

  it("join nothing for a call that did not arrive over a socket", async () => {
    const app = await start();
    expect(await app.as(as(board.ada)).taskService.enter({ room: "lobby" })).toBe(false);
    expect(await app.as(as(board.ada)).taskService.exit({ room: "lobby" })).toBe(false);
    expect(await app.server.presence.count("lobby")).toBe(0);
  });

  it("answer true for a room already joined, and false for leaving one not joined", async () => {
    const app = await start();
    const cy = await app.connect(as(board.cy));
    expect(await cy.call.taskService.exit({ room: "lobby" })).toBe(false);
    expect(await cy.call.taskService.enter({ room: "lobby" })).toBe(true);
    expect(await cy.call.taskService.enter({ room: "lobby" })).toBe(true);
    expect(await app.server.presence.count("lobby")).toBe(1);
    expect(await cy.call.taskService.enter({ room: "__proto__" })).toBe(true);
    expect(await cy.call.taskService.exit({ room: "__proto__" })).toBe(true);
  });

  it(`hold at most ${MAX_APP_ROOMS} app rooms per socket`, async () => {
    const app = await start();
    const cy = await app.connect(as(board.cy));
    for (let n = 0; n < MAX_APP_ROOMS; n += 1) {
      expect(await cy.call.taskService.enter({ room: `room${n}` })).toBe(true);
    }
    await expect(cy.call.taskService.enter({ room: "one-more" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    await cy.call.taskService.exit({ room: "room0" });
    expect(await cy.call.taskService.enter({ room: "one-more" })).toBe(true);
  });
});

describe("behind a cluster adapter", () => {
  it("answers through every node's sockets, and tells a room when a user's last socket leaves", async () => {
    const app = await start({ cluster: true });
    const ada = await connect(app, as(board.ada));
    const cy1 = await connect(app, as(board.cy));
    const cy2 = await connect(app, as(board.cy));
    await ada.connection.call.taskService.enter({ room: "lobby" });
    await cy1.connection.call.taskService.enter({ room: "lobby" });
    await cy2.connection.call.taskService.enter({ room: "lobby" });
    expect(await app.server.presence.isOnline(board.cy)).toBe(true);
    expect((await app.server.presence.users("lobby")).sort()).toEqual([board.ada, board.cy].sort());
    expect(await app.server.presence.count("lobby")).toBe(2);
    await app.frames.waitFor(
      (frame) => frame.event === "qd:presence" && frame.socketId === cy2.connection.socket.id,
    );
    await cy1.connection.call.taskService.exit({ room: "lobby" });
    await close(app, cy2.connection);
    await app.frames.waitFor({
      event: "qd:presence",
      userId: board.ada,
      socketId: ada.connection.socket.id ?? "",
    });
    await app.frames.waitFor((frame) => {
      const data = frame.data as PresenceFrame;
      return frame.event === "qd:presence" && data.left === board.cy;
    });
    await settle(ada.connection);
    expect(ada.presence[0]).toEqual({ room: "lobby", users: [board.ada] });
    expect(ada.presence.filter((frame) => frame.left !== undefined)).toEqual([
      { room: "lobby", left: board.cy },
    ]);
    expect(await app.server.presence.isOnline(board.cy)).toBe(true);
    expect(await app.server.presence.users("lobby")).toEqual([board.ada]);
  });
});

describe("the presence records", () => {
  it("count each user's sockets per room", () => {
    const records = new PresenceRecords();
    expect(records.entered("lobby", "u1")).toBe(true);
    expect(records.entered("lobby", "u1")).toBe(false);
    expect(records.entered("lobby", "__proto__")).toBe(true);
    expect(records.users("lobby")).toEqual(["u1", "__proto__"]);
    expect(records.exited("lobby", "u1")).toBe(false);
    expect(records.exited("lobby", "u1")).toBe(true);
    expect(records.exited("lobby", "u1")).toBe(false);
    expect(records.exited("lobby", "__proto__")).toBe(true);
    expect(records.users("lobby")).toBeUndefined();
  });

  it(`keep the last-seen times of the ${PRESENCE_MAX_LAST_SEEN} users seen last`, () => {
    const records = new PresenceRecords();
    for (let n = 0; n < PRESENCE_MAX_LAST_SEEN; n += 1) {
      records.seen(`u${n}`, n);
    }
    records.seen("u0", 1e9);
    records.seen("newest", 2e9);
    expect(records.lastSeen("u0")).toBe(1e9);
    expect(records.lastSeen("u1")).toBeUndefined();
    expect(records.lastSeen("newest")).toBe(2e9);
  });
});
