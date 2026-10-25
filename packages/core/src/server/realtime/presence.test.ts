// Presence and app rooms (RFC 0003 sections 3 and 12.5) through a real
// server: a user with two sockets stays online until both close, and is then
// remembered as last seen; `count` and `users` follow joins and leaves;
// `qd:presence` tells each socket in an app room who is there; `ctx.rooms`
// and presence refuse the framework's rooms; `ctx.rooms` joins nothing
// without a socket, and caps a socket's rooms. Behind a cluster adapter (two
// servers on the in-process peered bus) the other nodes answer with user ids
// alone, never their sockets (the 5.1 audit's RT-5); a node of an earlier
// version, which never answers, makes presence read every node's sockets for
// 30 s; another deployment's nodes answer nothing that counts.

import { Server } from "socket.io";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { inCluster } from "../../../test/cluster/mode";
import { defineContract, query } from "../../index";
import type { PresenceFrame } from "../../protocol/envelope";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, type TestApp, type TestConnection } from "../../testing/index";
import { captureLogger } from "../__tests__/fixtures";
import { as, projectService, seedBoard, type Board } from "../access/__tests__/board";
import { createDispatcher, initQuickdraw, type Principal, type QuickdrawIo } from "../index";
import { peeredCluster } from "../transports/__tests__/harness";
import { defineLiveService, frames, received, settle } from "./__tests__/fixture";
import { MAX_APP_ROOMS, PresenceRecords, PRESENCE_MAX_LAST_SEEN } from "./presence";
import { PRESENCE_EVENT } from "./presenceRequests";

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

type App = Awaited<ReturnType<typeof start>>;

type Bus = ReturnType<typeof peeredCluster>;

/**
 * A server on `bus`, one node of a cluster: it hears the servers in
 * `bus.servers`, itself included. With a `fetchSockets` spy on its adapter
 * and the warnings it logged.
 */
async function node(
  bus: Bus,
  cluster: { readonly keyPrefix?: string; readonly timeoutMs?: number } = {},
) {
  const logger = captureLogger();
  const app = await createTestApp({
    services: [projectService, defineLiveService(received())],
    db: h.db,
    socket: { adapter: bus.adapter },
    cluster,
    logger,
  });
  apps.push(app as unknown as TestApp);
  bus.servers.push(app.server.io);
  const fetched = vi.spyOn(app.server.io.sockets.adapter, "fetchSockets");
  const warnings = () => logger.at("warn").map(({ message }) => message);
  return { app, fetched, warnings };
}

/**
 * What each presence request a spy on `serverSideEmitWithAck` saw resolves
 * with, in order: a node asks the others for their room hosts on the same
 * method (`hosts.ts`), once it starts and again a little later.
 */
function presenceAnswers(asks: {
  readonly mock: {
    readonly calls: readonly (readonly unknown[])[];
    readonly results: readonly { readonly value: unknown }[];
  };
}): unknown[] {
  return asks.mock.calls.flatMap((call, index) =>
    call[0] === PRESENCE_EVENT ? [asks.mock.results[index]?.value] : [],
  );
}

/** In the cluster projects, a spy on `fetchSockets` of each of the app's two nodes; elsewhere none. */
async function fetchSocketsOfNodes(app: App) {
  if (!inCluster()) {
    return [];
  }
  const { nodesOf } = await import("../../../test/cluster/nodes");
  return nodesOf(app).map((each) => vi.spyOn(each.app.server.io.sockets.adapter, "fetchSockets"));
}

/** The users a client holding `frames` sees in the room: a list replaces, `joined` adds, `left` removes. */
function seenIn(sent: readonly PresenceFrame[]): string[] {
  let users = new Set<string>();
  for (const frame of sent) {
    if (frame.users !== undefined) {
      users = new Set(frame.users);
    }
    if (frame.joined !== undefined) {
      users.add(frame.joined);
    }
    if (frame.left !== undefined) {
      users.delete(frame.left);
    }
  }
  return [...users].sort();
}

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

  it("refuses the framework's rooms: who is in one would tell who subscribes to a row", async () => {
    const app = await start();
    const cy = await app.connect(as(board.cy));
    const reply = await cy.socket.timeout(5000).emitWithAck("qd:sub", {
      s: "taskService",
      ids: [board.t1],
    });
    expect(reply).toMatchObject({ ok: true });
    const { presence } = app.server;
    for (const ask of [
      presence.users(`qd:e:taskService:${board.t1}@Read`),
      presence.count(`qd:e:taskService:${board.t1}@Read`),
      presence.users(`user:${board.cy}`),
      presence.count(`user:${board.cy}`),
    ]) {
      await expect(ask).rejects.toMatchObject({
        code: "VALIDATION",
        message: expect.stringContaining("is reserved"),
      });
    }
    // A user's own online state is still known, by user id.
    expect(await presence.isOnline(board.cy)).toBe(true);
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
    const fetched = await fetchSocketsOfNodes(app);
    const ada = await connect(app, as(board.ada));
    const cy1 = await connect(app, as(board.cy));
    const cy2 = await connect(app, as(board.cy));
    await ada.connection.call.taskService.enter({ room: "lobby" });
    await cy1.connection.call.taskService.enter({ room: "lobby" });
    await cy2.connection.call.taskService.enter({ room: "lobby" });
    await Promise.all([settle(ada.connection), settle(cy1.connection), settle(cy2.connection)]);
    const both = [board.ada, board.cy].sort();
    if (inCluster()) {
      // Behind a cluster adapter each list is read from every node, after the join's reply, so
      // it may arrive after a `joined` it already counts: the room as a client applies it.
      await expect.poll(() => seenIn(ada.presence)).toEqual(both);
      await expect.poll(() => seenIn(cy1.presence)).toEqual(both);
      await expect.poll(() => seenIn(cy2.presence)).toEqual(both);
    } else {
      expect(ada.presence).toEqual([
        { room: "lobby", users: [board.ada] },
        { room: "lobby", joined: board.cy },
      ]);
      expect(cy1.presence).toEqual([{ room: "lobby", users: [board.ada, board.cy] }]);
      expect(cy2.presence).toEqual([{ room: "lobby", users: [board.ada, board.cy] }]);
    }
    const before = ada.presence.length;
    // Cy keeps a socket in the room: nobody hears of the first one leaving but itself.
    await cy1.connection.call.taskService.exit({ room: "lobby" });
    await close(app, cy2.connection);
    await settle(ada.connection);
    expect(cy1.presence.at(-1)).toEqual({ room: "lobby", users: [] });
    await expect
      .poll(() => ada.presence.slice(before))
      .toEqual([{ room: "lobby", left: board.cy }]);
    // In the cluster projects the lists and the `left` were the other node's answers: ids alone.
    for (const spy of fetched) {
      expect(spy).not.toHaveBeenCalled();
    }
  });

  it("lists no anonymous socket, and tells nobody of one", async () => {
    const app = await start();
    const ada = await connect(app, as(board.ada));
    const anonymous = await connect(app, null);
    await ada.connection.call.taskService.enter({ room: "lobby" });
    expect(await anonymous.connection.call.taskService.enterAnyone({ room: "lobby" })).toBe(true);
    await settle(ada.connection);
    // Behind a cluster adapter the list is read from every node, after the join's reply.
    await expect.poll(() => ada.presence).toEqual([{ room: "lobby", users: [board.ada] }]);
  });
});

/** A logger that prints nothing. */
const quiet = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
};

describe("ctx.rooms.join and leave", () => {
  it("throw INTERNAL in a method that shares its runs, naming why", async () => {
    const local = initQuickdraw<{ principal: Principal }>();
    const lobby = defineContract("lobbyService", {
      methods: {
        enterShared: query({ input: z.object({ room: z.string() }), output: z.boolean() }),
        leaveShared: query({ input: z.object({ room: z.string() }), output: z.boolean() }),
      },
    });
    const service = local.defineService(lobby, {
      methods: {
        enterShared: {
          access: "authenticated",
          share: "caller",
          handler: ({ input, ctx }) => ctx.rooms.join(input.room),
        },
        leaveShared: {
          access: "authenticated",
          share: "all",
          handler: ({ input, ctx }) => ctx.rooms.leave(input.room),
        },
      },
    });
    const errors: unknown[] = [];
    const logger = { ...quiet, error: (_message: string, meta?: unknown) => errors.push(meta) };
    const app = await createTestApp({ services: [service], logger });
    apps.push(app as unknown as TestApp);
    const ada = await app.connect(as(board.ada));
    await expect(ada.call.lobbyService.enterShared({ room: "lobby" })).rejects.toMatchObject({
      code: "INTERNAL",
    });
    await expect(ada.call.lobbyService.leaveShared({ room: "lobby" })).rejects.toMatchObject({
      code: "INTERNAL",
    });
    expect(JSON.stringify(errors)).toContain(
      'ctx.rooms.join cannot run in a method that shares its runs (share: \\"caller\\")',
    );
    const socket = app.server.io.sockets.sockets.get(ada.socket.id ?? "");
    expect(socket?.rooms.has("lobby")).toBe(false);
  });

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

  it("refuse a name with the shape of a socket id: every socket is alone in the room of its id (RT-I1)", async () => {
    const app = await start();
    const ada = await app.connect(as(board.ada));
    const cy = await app.connect(as(board.cy));
    const victim = ada.socket.id ?? "";
    expect(victim).toMatch(/^[\w-]{20}$/);
    const refused = { code: "VALIDATION", message: expect.stringContaining("socket id") };
    await expect(cy.call.taskService.enter({ room: victim })).rejects.toMatchObject(refused);
    await expect(cy.call.taskService.exit({ room: victim })).rejects.toMatchObject(refused);
    await expect(app.server.presence.users(victim)).rejects.toMatchObject(refused);
    await expect(app.server.presence.count(victim)).rejects.toMatchObject(refused);
    expect(() => app.server.rooms.size(victim)).toThrow(
      expect.objectContaining({ code: "VALIDATION" }),
    );
    await expect(app.server.rooms.leave(victim, { userId: board.ada })).rejects.toMatchObject(
      refused,
    );
    const socket = app.server.io.sockets.sockets.get(cy.socket.id ?? "");
    expect([...(socket?.rooms ?? [])].sort()).toEqual([cy.socket.id, `user:${board.cy}`].sort());
  });

  it("count no socket a raw join put in a room: presence answers for the rooms ctx.rooms.join recorded", async () => {
    const app = await start();
    const cy = await app.connect(as(board.cy));
    // On the socket's own server: behind Valkey, `io.in(...).socketsJoin` goes through the adapter.
    await app.server.io.sockets.sockets.get(cy.socket.id ?? "")?.join("raw");
    expect(app.server.io.sockets.adapter.rooms.get("raw")?.size).toBe(1);
    expect(await app.server.presence.users("raw")).toEqual([]);
    expect(await app.server.presence.count("raw")).toBe(0);
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
  it("asks the other nodes for user ids alone, never their sockets, and tells a room once a user's last socket left", async () => {
    const bus = peeredCluster();
    const a = await node(bus);
    const b = await node(bus);
    const ada = await connect(a.app, as(board.ada));
    const cy = await connect(b.app, as(board.cy));
    await ada.connection.call.taskService.enter({ room: "lobby" });
    await cy.connection.call.taskService.enter({ room: "lobby" });
    const both = [board.ada, board.cy].sort();
    await expect.poll(() => seenIn(cy.presence)).toEqual(both);
    const asks = vi.spyOn(b.app.server.io, "serverSideEmitWithAck");
    expect((await b.app.server.presence.users("lobby")).sort()).toEqual(both);
    expect(asks).toHaveBeenCalledWith(PRESENCE_EVENT, { room: "lobby", deployment: "quickdraw" });
    await expect(presenceAnswers(asks)[0]).resolves.toEqual([[board.ada]]);
    expect(await b.app.server.presence.count("lobby")).toBe(2);
    expect(await a.app.server.presence.isOnline(board.cy)).toBe(true);
    expect(await a.app.server.presence.isOnline(board.bo)).toBe(false);

    // Bo watches on node B. Cy's socket on node A leaves while cy keeps one in
    // the room on node B: node A tells its room nothing. Then cy's socket on
    // node B leaves, its last anywhere: node B's room hears it.
    const bo = await connect(b.app, as(board.bo));
    await bo.connection.call.taskService.enter({ room: "lobby" });
    const cyOnA = await connect(a.app, as(board.cy));
    await cyOnA.connection.call.taskService.enter({ room: "lobby" });
    const asksA = vi.spyOn(a.app.server.io, "serverSideEmitWithAck");
    await cyOnA.connection.call.taskService.exit({ room: "lobby" });
    await vi.waitFor(() => {
      expect(asksA).toHaveBeenCalledWith(PRESENCE_EVENT, {
        room: "lobby",
        deployment: "quickdraw",
      });
    });
    await presenceAnswers(asksA)[0];
    await settle(ada.connection);
    expect(ada.presence.filter((frame) => frame.left !== undefined)).toEqual([]);
    await cy.connection.call.taskService.exit({ room: "lobby" });
    await expect
      .poll(() => bo.presence.filter((frame) => frame.left !== undefined))
      .toEqual([{ room: "lobby", left: board.cy }]);
    expect((await a.app.server.presence.users("lobby")).sort()).toEqual(
      [board.ada, board.bo].sort(),
    );
    for (const each of [a, b]) {
      expect(each.fetched).not.toHaveBeenCalled();
      expect(each.warnings()).toEqual([]);
    }
  });

  it("counts the other nodes' answers when one never answers, and reads no node's sockets", async () => {
    // An adapter that hands over the answers that came when its request timeout passes, as Redis's does.
    const bus = peeredCluster({ requestsTimeout: 100 });
    const a = await node(bus);
    const b = await node(bus);
    const ada = await connect(a.app, as(board.ada));
    const cy = await connect(b.app, as(board.cy));
    await ada.connection.call.taskService.enter({ room: "lobby" });
    await cy.connection.call.taskService.enter({ room: "lobby" });
    const both = [board.ada, board.cy].sort();
    await expect.poll(() => seenIn(cy.presence)).toEqual(both);
    // A node of an earlier version hears the bus but knows no `quickdraw:presence`: it never answers.
    bus.servers.push(new Server() as unknown as QuickdrawIo);
    const asks = vi.spyOn(a.app.server.io, "serverSideEmitWithAck");
    expect((await a.app.server.presence.users("lobby")).sort()).toEqual(both);
    expect(presenceAnswers(asks)).toHaveLength(1);
    expect(a.warnings()).toEqual([
      expect.stringContaining("did not answer a presence request in time: 1 other node answered"),
    ]);
    expect(await a.app.server.presence.count("lobby")).toBe(2);
    expect(await a.app.server.presence.isOnline(board.cy)).toBe(true);
    expect(presenceAnswers(asks)).toHaveLength(3);
    expect(a.fetched).not.toHaveBeenCalled();
    // At most once every 10 minutes.
    expect(a.warnings()).toHaveLength(1);
  });

  it("counts none of another deployment's users: its nodes answer null, at once", async () => {
    const bus = peeredCluster();
    const prod = await node(bus, { keyPrefix: "prod" });
    const staging = await node(bus, { keyPrefix: "staging" });
    const ada = await connect(prod.app, as(board.ada));
    const cy = await connect(staging.app, as(board.cy));
    await ada.connection.call.taskService.enter({ room: "lobby" });
    await cy.connection.call.taskService.enter({ room: "lobby" });
    await expect.poll(() => seenIn(cy.presence)).toEqual([board.cy]);
    expect(await prod.app.server.presence.users("lobby")).toEqual([board.ada]);
    expect(await staging.app.server.presence.users("lobby")).toEqual([board.cy]);
    expect(await prod.app.server.presence.isOnline(board.cy)).toBe(false);
    expect(seenIn(ada.presence)).toEqual([board.ada]);
    // Answered, so neither node waited for a timeout or read the other's sockets.
    for (const deployment of [prod, staging]) {
      expect(deployment.fetched).not.toHaveBeenCalled();
      expect(deployment.warnings()).toEqual([]);
    }
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
