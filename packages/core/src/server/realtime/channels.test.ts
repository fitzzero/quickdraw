// Channels (RFC 0003 section 12.5) through a real server against PGlite,
// ported from 4.1's `legacy-src/server/channels.test.ts`: a message reaches
// its handler from an authenticated socket that holds the subscription the
// contract's `requires` names; one over the socket's token bucket, with a
// payload that fails its schema, from an anonymous socket or without the
// access is dropped without an answer; sustained flooding disconnects; a
// handler's failure is logged and the channel keeps working. Plus what 5.0
// adds: the one `qd:ch` event routed by `[service, channel, payload]`, a
// bucket per service and channel, prototype-free lookups, the rate limiter
// that never counts `qd:ch`, the handler's `ctx`, and `requires: { room }`
// (4.1's `requireRoom`): the sending socket itself must have joined the app
// room, through a call over it.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract } from "../../contract/defineContract";
import type { Logger } from "../../contract/logger";
import { entityRoom, userRoom } from "../../contract/names";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../../testing/index";
import { as, projectService, qd, seedBoard, type Board } from "../access/__tests__/board";
import type { Principal } from "../index";
import {
  defineLiveService,
  frames,
  LOBBY,
  received,
  send,
  settle,
  type Received,
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

/** A logger that keeps its errors, warnings and the debug lines of channel handlers. */
function capturing() {
  const errors: string[] = [];
  const warnings: string[] = [];
  const debugs: string[] = [];
  const logger: Logger = {
    debug: (message, meta) => {
      if (meta?.category === "quickdraw.channel") {
        debugs.push(message);
      }
    },
    info: () => undefined,
    warn: (message) => warnings.push(message),
    error: (message) => errors.push(message),
    child: () => logger,
  };
  return { logger, errors, warnings, debugs };
}

async function start(options: { readonly rateLimit?: { readonly maxRequests: number } } = {}) {
  const into = received();
  const log = capturing();
  const app = await createTestApp({
    services: [projectService, defineLiveService(into)],
    db: h.db,
    logger: log.logger,
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
  });
  apps.push(app as unknown as TestApp);
  return { app, into, log };
}

type App = Awaited<ReturnType<typeof start>>["app"];

/** A socket acting as `principal`, subscribed to row T1 (`qd:sub`). */
async function onT1(app: App, principal: Principal) {
  const connection = await app.connect(principal);
  const reply = await emitWithAck(connection.socket, "qd:sub", {
    s: "taskService",
    ids: [board.t1],
  });
  expect(reply).toMatchObject({ ok: true, r: [{ ok: true }] });
  return connection;
}

const input = (seq: number, taskId = board.t1) => ({ taskId, seq, dx: 1, dy: 0 });

describe("qd:ch, ported from 4.1", () => {
  it("delivers messages from an authenticated socket that holds the row the payload names", async () => {
    const { app, into } = await start();
    const cy = await onT1(app, as(board.cy));
    send(cy, "input", input(1));
    send(cy, "input", { ...input(2), dx: 0, dy: 1 });
    await settle(cy);
    expect(into.input).toEqual([
      { userId: board.cy, socketId: cy.socket.id, seq: 1 },
      { userId: board.cy, socketId: cy.socket.id, seq: 2 },
    ]);
  });

  it("drops messages from a socket that does not hold the row, or names another row", async () => {
    const { app, into } = await start();
    const outsider = await app.connect(as(board.di));
    const cy = await onT1(app, as(board.cy));
    send(outsider, "input", input(3));
    send(cy, "input", input(4, board.t2));
    send(cy, "input", input(5, "__proto__"));
    await Promise.all([settle(outsider), settle(cy)]);
    expect(into.input).toEqual([]);
  });

  it("drops messages from a socket that does not hold the collection scope the payload names", async () => {
    const { app, into } = await start();
    const ada = await app.connect(as(board.ada));
    const bo = await app.connect(as(board.bo));
    const reply = await emitWithAck(ada.socket, "qd:col:sub", {
      s: "taskService",
      c: "byProject",
      scope: board.p1,
    });
    expect(reply).toMatchObject({ ok: true });
    send(ada, "typing", { projectId: board.p1, on: true });
    send(ada, "typing", { projectId: board.p2, on: true });
    send(bo, "typing", { projectId: board.p1, on: true });
    await Promise.all([settle(ada), settle(bo)]);
    expect(into.typing).toEqual([{ userId: board.ada, projectId: board.p1 }]);
  });

  it("drops messages that fail schema validation", async () => {
    const { app, into } = await start();
    const cy = await onT1(app, as(board.cy));
    send(cy, "input", { taskId: board.t1, seq: "not-a-number", dx: 1 });
    send(cy, "input", "garbage");
    send(cy, "input", null);
    send(cy, "input", { ...input(1), seq: 1.5 });
    await settle(cy);
    expect(into.input).toEqual([]);
  });

  it("enforces the service-wide grant a channel's access names", async () => {
    const { app, into } = await start();
    const regular = await app.connect(as(board.cy));
    const reader = await app.connect(as(board.di, { taskService: "Moderate" }));
    const admin = await app.connect(as(board.ada, { taskService: "Admin" }));
    send(regular, "adminPing", { note: "from-regular" });
    send(reader, "adminPing", { note: "from-moderate" });
    send(admin, "adminPing", { note: "from-admin" });
    await Promise.all([settle(regular), settle(reader), settle(admin)]);
    expect(into.adminPings).toEqual(["from-admin"]);
  });

  it("drops excess messages through the token bucket without disconnecting", async () => {
    const { app, into } = await start();
    const cy = await onT1(app, as(board.cy));
    for (let seq = 100; seq < 300; seq += 1) {
      send(cy, "input", input(seq));
    }
    await settle(cy);
    // The bucket lets the burst of 60 through at once, plus a trickle of refill.
    expect(into.input.length).toBeGreaterThanOrEqual(60);
    expect(into.input.length).toBeLessThan(100);
    expect(into.input.map(({ seq }) => seq).slice(0, 60)).toEqual(
      Array.from({ length: 60 }, (_, index) => 100 + index),
    );
    expect(cy.socket.connected).toBe(true);
  });

  it("disconnects a socket that floods far past a channel's rate", async () => {
    const { app, into, log } = await start();
    const ada = await app.connect(as(board.ada));
    const gone = new Promise<string>((resolve) => {
      ada.socket.once("disconnect", resolve);
    });
    // `tight` allows 1 message a second: more than 100 drops in 10 s is abuse.
    for (let n = 0; n < 150; n += 1) {
      send(ada, "tight", { n });
    }
    expect(await gone).toBe("io server disconnect");
    expect(into.tight).toEqual([0]);
    expect(log.warnings).toEqual([
      expect.stringContaining("for sustained flooding of channel taskService.tight"),
    ]);
  });

  it("logs a handler's throw or rejection without acknowledging, and the channel keeps working", async () => {
    const { app, into, log } = await start();
    const cy = await onT1(app, as(board.cy));
    const acks: unknown[] = [];
    cy.socket.emit("qd:ch", ["taskService", "input", input(-999)], (reply: unknown) => {
      acks.push(reply);
    });
    send(cy, "input", input(-998));
    send(cy, "input", input(-997));
    await settle(cy);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(into.handlerErrors).toBe(3);
    // A plain Error is a server fault; a QuickdrawError the client caused (CONFLICT,
    // FORBIDDEN) logs at debug, as the pipeline logs calls.
    expect(log.errors).toEqual(["The handler of channel taskService.input failed"]);
    expect(log.debugs).toEqual([
      "The handler of channel taskService.input failed",
      "The handler of channel taskService.input failed",
    ]);
    expect(acks).toEqual([]);
    expect(cy.socket.connected).toBe(true);
    send(cy, "input", input(7));
    await settle(cy);
    expect(into.input.map(({ seq }) => seq)).toEqual([7]);
  });

  it("drops messages from anonymous sockets", async () => {
    const { app, into } = await start();
    const anonymous = await app.connect(null);
    send(anonymous, "input", input(9));
    send(anonymous, "tight", { n: 1 });
    send(anonymous, "adminPing", { note: "anonymous" });
    await settle(anonymous);
    expect(into).toMatchObject({ input: [], tight: [], adminPings: [] });
  });

  it("registers one qd:ch listener per socket, whatever the number of channels", async () => {
    const { app } = await start();
    const ada = await app.connect(as(board.ada));
    const socket = app.server.io.sockets.sockets.get(ada.socket.id ?? "");
    expect(socket?.listeners("qd:ch")).toHaveLength(1);
    expect(app.server.dispatcher.registry.services.get("taskService")?.channels.size).toBe(7);
  });
});

describe("requires: { room }", () => {
  const shouts = (into: Received) => into.shout.map(({ n }) => n);

  it("delivers from a socket in the room, and drops from one that never joined or has left", async () => {
    const { app, into } = await start();
    const cy = await app.connect(as(board.cy));
    const di = await app.connect(as(board.di));
    send(cy, "shout", { n: 1 });
    expect(await cy.call.taskService.enter({ room: LOBBY })).toBe(true);
    send(cy, "shout", { n: 2 });
    send(di, "shout", { n: 3 });
    await Promise.all([settle(cy), settle(di)]);
    expect(await cy.call.taskService.exit({ room: LOBBY })).toBe(true);
    send(cy, "shout", { n: 4 });
    await settle(cy);
    expect(into.shout).toEqual([{ userId: board.cy, socketId: cy.socket.id, n: 2 }]);
  });

  it("counts the rooms the sending socket joined, not the ones its user's other sockets joined", async () => {
    const { app, into } = await start();
    // A player's page and game client: the page joined the lobby, the game client did not.
    const page = await app.connect(as(board.cy));
    const game = await app.connect(as(board.cy));
    await page.call.taskService.enter({ room: LOBBY });
    send(game, "shout", { n: 1 });
    send(page, "shout", { n: 2 });
    await Promise.all([settle(page), settle(game)]);
    expect(shouts(into)).toEqual([2]);
  });

  it("drops what a new connection sends until a call over it joins the room again", async () => {
    const { app, into } = await start();
    const first = await app.connect(as(board.cy));
    await first.call.taskService.enter({ room: LOBBY });
    send(first, "shout", { n: 1 });
    await settle(first);
    first.close();
    const again = await app.connect(as(board.cy));
    send(again, "shout", { n: 2 });
    await settle(again);
    await again.call.taskService.enter({ room: LOBBY });
    send(again, "shout", { n: 3 });
    await settle(again);
    expect(shouts(into)).toEqual([1, 3]);
  });

  it("reads a computed room from the payload, and never takes a framework room for one", async () => {
    const { app, into } = await start();
    const ada = await onT1(app, as(board.ada));
    await ada.call.taskService.enter({ room: "table:7" });
    // The socket is in its user room and in T1's entity room, but those are not app rooms.
    const own = [userRoom(board.ada), entityRoom("taskService", board.t1, "Admin")] as const;
    const rooms = app.server.io.sockets.sockets.get(ada.socket.id ?? "")?.rooms;
    expect(own.every((room) => rooms?.has(room))).toBe(true);
    send(ada, "move", { room: "table:7", n: 1 });
    send(ada, "move", { room: "table:8", n: 2 });
    send(ada, "move", { room: own[0], n: 3 });
    send(ada, "move", { room: own[1], n: 4 });
    send(ada, "move", { room: "", n: 5 });
    await settle(ada);
    expect(into.move).toEqual([{ room: "table:7", n: 1 }]);
  });

  it("drops messages from an anonymous socket, even in the room", async () => {
    const { app, into } = await start();
    const anonymous = await app.connect(null);
    expect(await anonymous.call.taskService.enterAnyone({ room: LOBBY })).toBe(true);
    send(anonymous, "shout", { n: 1 });
    await settle(anonymous);
    expect(shouts(into)).toEqual([]);
  });
});

describe("qd:ch in 5.0", () => {
  it("drops malformed frames and unknown names, and finds nothing through prototype keys", async () => {
    const { app, into, log } = await start();
    const ada = await onT1(app, as(board.ada));
    const raw = [
      "garbage",
      null,
      ["taskService"],
      ["noService", "input", input(1)],
      ["taskService", "nope", input(1)],
      ["__proto__", "input", input(1)],
      ["taskService", "__proto__", input(1)],
      ["taskService", "constructor", input(1)],
      [{ s: 1 }, "input", input(1)],
    ];
    for (const frame of raw) {
      ada.socket.emit("qd:ch", frame);
    }
    await settle(ada);
    expect(into.input).toEqual([]);
    expect(ada.socket.connected).toBe(true);
    expect(log.errors).toEqual([]);
  });

  it("keeps a bucket per socket, service and channel", async () => {
    const { app, into } = await start();
    const cy = await onT1(app, as(board.cy));
    const other = await onT1(app, as(board.cy));
    for (let n = 0; n < 5; n += 1) {
      send(cy, "tight", { n });
    }
    send(cy, "input", input(1));
    send(other, "tight", { n: 10 });
    await Promise.all([settle(cy), settle(other)]);
    expect(into.tight).toEqual([0, 10]);
    expect(into.input.map(({ seq }) => seq)).toEqual([1]);
  });

  it("is never counted by the socket rate limiter", async () => {
    const { app, into } = await start({ rateLimit: { maxRequests: 5 } });
    const cy = await onT1(app, as(board.cy));
    for (let seq = 0; seq < 20; seq += 1) {
      send(cy, "input", input(seq));
    }
    await settle(cy);
    expect(into.input).toHaveLength(20);
    // The limiter counted the calls only (qd:sub is excluded too): the sixth is refused.
    const calls = await Promise.all(
      Array.from({ length: 6 }, async () => {
        try {
          await cy.call.taskService.get({ id: board.t1 });
          return "ok";
        } catch (error) {
          return (error as { readonly code?: string }).code;
        }
      }),
    );
    expect(calls.filter((outcome) => outcome === "ok")).toHaveLength(5);
    expect(calls).toContain("RATE_LIMITED");
  });

  it("gives the handler ctx.rooms acting for the sending socket, and ctx.presence", async () => {
    const { app } = await start();
    const ada = await app.connect(as(board.ada));
    const cy = await app.connect(as(board.cy));
    const events = frames(ada, "qd:event");
    expect(await ada.call.taskService.enter({ room: "lobby" })).toBe(true);
    send(cy, "relay", { room: "lobby", taskId: board.t1 });
    await settle(cy);
    await settle(ada);
    expect(events).toEqual([["taskService", "celebrated", { taskId: board.t1 }]]);
  });

  it("warns once and drops the messages of a channel whose schema validates asynchronously", async () => {
    const slowPayload = {
      "~standard": {
        version: 1 as const,
        vendor: "test",
        validate: (value: unknown) => Promise.resolve({ value }),
      },
    };
    const contract = defineContract("slowService", {
      channels: { slow: { payload: slowPayload } },
    });
    const got: unknown[] = [];
    const service = qd.defineService(contract, {
      methods: {},
      channels: {
        slow: (payload) => {
          got.push(payload);
        },
      },
    });
    const log = capturing();
    const app = await createTestApp({ services: [service], db: h.db, logger: log.logger });
    apps.push(app as unknown as TestApp);
    const ada = await app.connect(as(board.ada));
    send(ada, "slow", { n: 1 }, "slowService");
    send(ada, "slow", { n: 2 }, "slowService");
    await settle(ada);
    expect(got).toEqual([]);
    expect(log.warnings).toEqual([expect.stringContaining("validates asynchronously")]);
  });
});

describe("channel handlers in defineService", () => {
  const payload = z.object({ n: z.number() });
  const pair = defineContract("pairService", {
    channels: { a: { payload }, b: { payload, ratePerSecond: 4 } },
  });
  const define = (channels: unknown): unknown =>
    (qd.defineService as unknown as (contract: unknown, definition: unknown) => unknown)(pair, {
      methods: {},
      channels,
    });
  const handler = (): undefined => undefined;

  it("needs exactly one implementation per contract channel", () => {
    expect(() => define(undefined)).toThrow("channels must be an object");
    expect(() => define({ a: handler })).toThrow('channels has no implementation for "b"');
    expect(() => define({ a: handler, b: handler, c: handler })).toThrow(
      '"c" is not a channel of the contract',
    );
    expect(() => define({ a: handler, b: {} })).toThrow(
      'channel "b" must be a handler function or { access, handler }',
    );
    expect(() => define({ a: handler, b: { handler, rate: 1 } })).toThrow(
      'channel "b" has an unknown option "rate"',
    );
  });

  it("takes access as authenticated or a service-wide grant", () => {
    for (const access of [
      { entry: "Read" },
      "public",
      { service: "Owner" },
      { service: "Read", entry: "Read" },
    ]) {
      expect(() => define({ a: handler, b: { handler, access } })).toThrow(
        'channel "b": access must be "authenticated" or { service: level }',
      );
    }
    const service = define({ a: handler, b: { handler, access: { service: "Moderate" } } }) as {
      readonly channels: ReadonlyMap<string, { readonly access: unknown; readonly burst: number }>;
    };
    expect(service.channels.get("a")).toMatchObject({ access: "authenticated", burst: 60 });
    expect(service.channels.get("b")).toMatchObject({ access: { service: "Moderate" }, burst: 8 });
  });

  it("lets a slow channel's default burst hold at least one message", () => {
    const slow = defineContract("slowRateService", {
      channels: { rare: { payload, ratePerSecond: 0.2 } },
    });
    const service = (
      qd.defineService as unknown as (contract: unknown, definition: unknown) => unknown
    )(slow, { methods: {}, channels: { rare: handler } }) as {
      readonly channels: ReadonlyMap<string, { readonly burst: number }>;
    };
    expect(service.channels.get("rare")?.burst).toBe(1);
  });

  it("refuses channels on a service whose contract declares none", () => {
    const none = defineContract("noneService", {});
    expect(() =>
      (qd.defineService as unknown as (contract: unknown, definition: unknown) => unknown)(none, {
        methods: {},
        channels: { a: handler },
      }),
    ).toThrow('"a" is not a channel of the contract');
  });
});
