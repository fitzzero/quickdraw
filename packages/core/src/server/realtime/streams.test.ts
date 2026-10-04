// Streams (RFC 0003 section 12.5) through a real server against PGlite: a
// subscriber gets the seed, then every item pushed after it in order; a later
// subscriber's seed holds the latest items, at most `seed` of them, per
// scope; `qd:stream:sub` is authorized with the stream's access form through
// the access engine (a stream without one is closed); malformed frames,
// unknown names and scopes that do not fit are refused; an unsubscribe stops
// the frames, even one that arrives while the subscribe is being
// authorized; and `push` checks what it sends.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { settleCluster } from "../../../test/cluster/mode";
import { defineContract } from "../../contract/defineContract";
import type { Logger } from "../../contract/logger";
import type { StreamFrame } from "../../protocol/envelope";
import { QuickdrawError } from "../../protocol/errors";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { connectV5 } from "../../testing/socket";
import {
  createTestApp,
  emitWithAck,
  eventFrames,
  streamFrames,
  type TestApp,
  type TestConnection,
} from "../../testing/index";
import { as, projectService, qd, seedBoard, type Board } from "../access/__tests__/board";
import { recordingStorage, type Read } from "../emit/__tests__/live";
import { createDispatcher, initQuickdraw, type Principal } from "../index";
import {
  defineLiveService,
  frames,
  liveContract,
  LOBBY,
  received,
  refused,
  settle,
  streamSub,
  streamUnsub,
} from "./__tests__/fixture";
import { STREAM_MAX_SCOPES, StreamSeeds } from "./seeds";
import { MAX_STREAMS_PER_SOCKET } from "./streamSubscriptions";

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
  readonly after?: (read: Read) => Promise<void> | undefined;
  readonly rateLimit?: { readonly maxRequests: number };
  readonly loadServiceAccess?: () => Record<string, never>;
}

async function start(options: StartOptions = {}) {
  const recorded = recordingStorage(h.storage, options.after);
  const app = await createTestApp({
    services: [projectService, defineLiveService(received())],
    db: h.db,
    storage: recorded.storage,
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
    ...(options.loadServiceAccess === undefined
      ? {}
      : { auth: { loadServiceAccess: options.loadServiceAccess } }),
  });
  apps.push(app as unknown as TestApp);
  return app;
}

type App = Awaited<ReturnType<typeof start>>;

/**
 * In the cluster projects a push goes out on the writer node and reaches the
 * reader node's seeds through Valkey: waits for it there before a subscriber
 * on the reader node reads a seed. Nothing on one server.
 */
async function pushed(): Promise<void> {
  await settleCluster();
}

function logs(app: App) {
  return app.server.stream(liveContract, "logs");
}

/** What a stream test reads of an app's sockets: any test app's. */
interface Connects {
  connect(principal: Principal | null): Promise<Pick<TestConnection, "socket">>;
}

async function connect(app: Connects, principal: Principal | null) {
  const connection = await app.connect(principal);
  return { connection, items: frames<StreamFrame>(connection, "qd:stream") };
}

describe("qd:stream:sub", () => {
  it("answers with the seed, then sends every item pushed after it, in order", async () => {
    const app = await start();
    logs(app).push(board.t1, { line: "one" });
    logs(app).push(board.t1, { line: "two" });
    await pushed();
    const { connection, items } = await connect(app, as(board.cy));
    expect(await streamSub(connection, "logs", board.t1)).toEqual({
      ok: true,
      seed: [{ line: "one" }, { line: "two" }],
    });
    for (const line of ["three", "four", "five"]) {
      logs(app).push(board.t1, { line });
    }
    await settle(connection);
    expect(items).toEqual(
      ["three", "four", "five"].map((line) => ["taskService", "logs", board.t1, { line }]),
    );
  });

  it("gives a later subscriber a seed holding the latest items, at most the stream's seed", async () => {
    const app = await start();
    const first = await connect(app, as(board.cy));
    await streamSub(first.connection, "logs", board.t1);
    for (const line of ["a", "b", "c", "d"]) {
      logs(app).push(board.t1, { line });
    }
    await pushed();
    const second = await connect(app, as(board.bo));
    expect(await streamSub(second.connection, "logs", board.t1)).toEqual({
      ok: true,
      seed: [{ line: "b" }, { line: "c" }, { line: "d" }],
    });
    await settle(first.connection);
    expect(first.items.map((frame) => frame[3])).toEqual(
      ["a", "b", "c", "d"].map((line) => ({ line })),
    );
  });

  it("keeps one feed and one seed per scope, and one for a global stream", async () => {
    const app = await start();
    logs(app).push(board.t1, { line: "on t1" });
    logs(app).push(board.t2, { line: "on t2" });
    const status = app.server.stream(liveContract, "status");
    status.push("up");
    await pushed();
    const cy = await connect(app, as(board.cy));
    expect(await streamSub(cy.connection, "logs", board.t1)).toEqual({
      ok: true,
      seed: [{ line: "on t1" }],
    });
    expect(await streamSub(cy.connection, "status")).toEqual({ ok: true, seed: ["up"] });
    logs(app).push(board.t2, { line: "t2 again" });
    status.push("down");
    await settle(cy.connection);
    expect(cy.items).toEqual([["taskService", "status", null, "down"]]);
  });

  it("authorizes with the stream's row-level access form", async () => {
    const app = await start();
    const ed = await connect(app, as(board.ed));
    const cy = await connect(app, as(board.cy));
    const bo = await connect(app, as(board.bo));
    // logs: { entry: "Read" } on the task the scope names.
    expect(await streamSub(ed.connection, "logs", board.t1)).toEqual(refused("FORBIDDEN"));
    expect(await streamSub(ed.connection, "logs", "missing")).toEqual(refused("FORBIDDEN"));
    expect(await streamSub(cy.connection, "logs", board.t1)).toMatchObject({ ok: true });
    // projectFeed: { scope: "Moderate", of: project } on the project the scope names.
    expect(await streamSub(cy.connection, "projectFeed", board.p1)).toEqual(refused("FORBIDDEN"));
    expect(await streamSub(bo.connection, "projectFeed", board.p1)).toMatchObject({ ok: true });
    const admin = await connect(app, as(board.ed, { taskService: "Admin" }));
    expect(await streamSub(admin.connection, "logs", board.t1)).toMatchObject({ ok: true });
  });

  it("opens a public stream to anyone, an authenticated one to any principal, and { service } to the grant", async () => {
    const app = await start();
    const anonymous = await connect(app, null);
    const cy = await connect(app, as(board.cy));
    const granted = await connect(app, as(board.cy, { taskService: "Admin" }));
    expect(await streamSub(anonymous.connection, "ticks")).toEqual({ ok: true, seed: [] });
    expect(await streamSub(anonymous.connection, "status")).toEqual(refused("UNAUTHENTICATED"));
    expect(await streamSub(cy.connection, "status")).toEqual({ ok: true, seed: [] });
    expect(await streamSub(cy.connection, "adminFeed")).toEqual(refused("FORBIDDEN"));
    expect(await streamSub(granted.connection, "adminFeed")).toEqual({ ok: true, seed: [] });
    app.server.stream(liveContract, "ticks").push(1);
    await settle(anonymous.connection);
    expect(anonymous.items).toEqual([["taskService", "ticks", null, 1]]);
  });

  it("refuses everyone, an Admin grant included, on a stream that declares no access", async () => {
    const app = await start();
    const admin = await connect(app, as(board.ada, { taskService: "Admin" }));
    expect(await streamSub(admin.connection, "closed", board.t1)).toEqual(refused("FORBIDDEN"));
  });

  it("refuses malformed frames, unknown names and scopes that do not fit the stream", async () => {
    const app = await start();
    const { connection } = await connect(app, as(board.ada));
    const ask = (frame: unknown) => emitFrame(connection, frame);
    expect(await ask("garbage")).toEqual(refused("VALIDATION"));
    expect(await ask({ s: "taskService" })).toEqual(refused("VALIDATION"));
    expect(await ask({ s: "noService", stream: "logs", scope: "x" })).toEqual(refused("NOT_FOUND"));
    expect(await ask({ s: "taskService", stream: "nope" })).toEqual(refused("NOT_FOUND"));
    expect(await ask({ s: "__proto__", stream: "logs" })).toEqual(refused("NOT_FOUND"));
    expect(await ask({ s: "taskService", stream: "constructor" })).toEqual(refused("NOT_FOUND"));
    expect(await ask({ s: "taskService", stream: "logs" })).toEqual(refused("VALIDATION"));
    expect(await ask({ s: "taskService", stream: "logs", scope: "" })).toEqual(
      refused("VALIDATION"),
    );
    expect(await ask({ s: "taskService", stream: "logs", scope: "x".repeat(257) })).toEqual(
      refused("VALIDATION"),
    );
    expect(await ask({ s: "taskService", stream: "status", scope: "x" })).toEqual(
      refused("VALIDATION"),
    );
  });

  it("stops the frames after qd:stream:unsub", async () => {
    const app = await start();
    const { connection, items } = await connect(app, as(board.cy));
    await streamSub(connection, "logs", board.t1);
    expect(await streamUnsub(connection, "logs", board.t1)).toEqual({ ok: true });
    logs(app).push(board.t1, { line: "unheard" });
    await settle(connection);
    expect(items).toEqual([]);
    expect(app.server.io.sockets.sockets.get(connection.socket.id ?? "")?.data.streams).toEqual({});
  });

  it("does not join when the client unsubscribed while the subscribe was being authorized", async () => {
    let release = (): void => undefined;
    let reading = (): void => undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      reading = resolve;
    });
    const app = await start({
      after: (read) => {
        if (read.model !== "task") {
          return undefined;
        }
        reading();
        return held;
      },
    });
    const { connection, items } = await connect(app, as(board.cy));
    const subscribing = streamSub(connection, "logs", board.t1);
    await started;
    expect(await streamUnsub(connection, "logs", board.t1)).toEqual({ ok: true });
    release();
    expect(await subscribing).toMatchObject({ ok: true });
    logs(app).push(board.t1, { line: "unheard" });
    await settle(connection);
    expect(items).toEqual([]);
  });

  it("is never counted by the socket rate limiter", async () => {
    const app = await start({ rateLimit: { maxRequests: 1 } });
    const { connection } = await connect(app, as(board.cy));
    for (const stream of ["status", "ticks", "status"]) {
      expect(await streamSub(connection, stream)).toMatchObject({ ok: true });
    }
    expect(await streamUnsub(connection, "status")).toEqual({ ok: true });
  });

  it("needs a principal to unsubscribe from a stream that is not public", async () => {
    const app = await start();
    const { connection } = await connect(app, null);
    expect(await streamUnsub(connection, "status")).toEqual(refused("UNAUTHENTICATED"));
    expect(await streamUnsub(connection, "ticks")).toEqual({ ok: true });
  });

  it(`holds at most ${MAX_STREAMS_PER_SOCKET} feeds per socket`, async () => {
    const app = await start();
    const { connection } = await connect(app, null);
    // In runs that fit the socket's lane (8 running, 64 waiting), which refuses more at once.
    const answers: Record<string, unknown>[] = [];
    for (let first = 0; first < MAX_STREAMS_PER_SOCKET; first += 50) {
      const run = Array.from({ length: 50 }, (_, n) =>
        streamSub(connection, "rooms", `r${first + n}`),
      );
      answers.push(...(await Promise.all(run)));
    }
    expect(answers.every((answer) => answer.ok === true)).toBe(true);
    expect(await streamSub(connection, "rooms", "one-more")).toEqual(refused("CONFLICT"));
    expect(await streamSub(connection, "rooms", "r0")).toMatchObject({ ok: true });
    await streamUnsub(connection, "rooms", "r0");
    expect(await streamSub(connection, "rooms", "one-more")).toMatchObject({ ok: true });
  });
});

describe("revocation", () => {
  it("revokes a feed whose subscriber lost the row's access, and sends it nothing more", async () => {
    const app = await start();
    const reader = await connect(app, as(board.cy));
    const owner = await connect(app, as(board.ada));
    const revoked = frames(reader.connection, "qd:revoked");
    for (const { connection } of [reader, owner]) {
      expect(await streamSub(connection, "logs", board.t1)).toEqual({ ok: true, seed: [] });
    }
    logs(app).push(board.t1, { line: "before" });
    await settle(reader.connection);
    expect(reader.items).toHaveLength(1);
    // Cy reads T1 as a Read member of P1; a tracked write ends the membership.
    await app.server.dispatcher.run(() =>
      h.db.projectMember.deleteMany({ where: { projectId: board.p1, userId: board.cy } }),
    );
    await settle(reader.connection);
    expect(revoked).toEqual([
      { kind: "stream", reason: "access", s: "taskService", stream: "logs", scope: board.t1 },
    ]);
    logs(app).push(board.t1, { line: "after" });
    await settle(reader.connection);
    await settle(owner.connection);
    expect(reader.items.map((frame) => frame[3])).toEqual([{ line: "before" }]);
    expect(owner.items.map((frame) => frame[3])).toEqual([{ line: "before" }, { line: "after" }]);
  });

  it("revokes a scope-form feed when the subscriber's level on the other row drops below the form", async () => {
    const app = await start();
    const member = await connect(app, as(board.bo));
    const revoked = frames(member.connection, "qd:revoked");
    expect(await streamSub(member.connection, "projectFeed", board.p1)).toMatchObject({ ok: true });
    // Bo moderates P1; a Read role is below projectFeed's Moderate.
    await app.server.dispatcher.run(() =>
      h.db.projectMember.updateMany({
        where: { projectId: board.p1, userId: board.bo },
        data: { role: "Read" },
      }),
    );
    await settle(member.connection);
    expect(revoked).toEqual([
      {
        kind: "stream",
        reason: "access",
        s: "taskService",
        stream: "projectFeed",
        scope: board.p1,
      },
    ]);
    app.server.stream(liveContract, "projectFeed").push(board.p1, { n: 1 });
    await settle(member.connection);
    expect(member.items).toEqual([]);
  });

  it("authorizes a { service } feed again when the user's grants change", async () => {
    const app = await start({ loadServiceAccess: () => ({}) });
    const admin = await connect(app, as(board.di, { taskService: "Admin" }));
    const revoked = frames(admin.connection, "qd:revoked");
    expect(await streamSub(admin.connection, "adminFeed")).toMatchObject({ ok: true });
    expect(await app.server.access.refresh(board.di)).toEqual({});
    await settle(admin.connection);
    expect(revoked).toEqual([
      { kind: "stream", reason: "access", s: "taskService", stream: "adminFeed" },
    ]);
    app.server.stream(liveContract, "adminFeed").push(1);
    await settle(admin.connection);
    expect(admin.items).toEqual([]);
  });
});

describe("push", () => {
  it("keeps and sends the validated item: keys the stream's schema does not name are stripped", async () => {
    const app = await start();
    const { connection, items } = await connect(app, as(board.ada));
    expect(await streamSub(connection, "logs", board.t1)).toEqual({ ok: true, seed: [] });
    const extra = { line: "built", token: "not in the schema" } as { line: string };
    logs(app).push(board.t1, extra);
    await settle(connection);
    expect(items).toEqual([["taskService", "logs", board.t1, { line: "built" }]]);
    const later = await connect(app, as(board.ada));
    expect(await streamSub(later.connection, "logs", board.t1)).toEqual({
      ok: true,
      seed: [{ line: "built" }],
    });
  });

  it("sends each item as [service, stream, scope, item]: no key names, scope null for a global stream", async () => {
    const app = await start();
    const { connection, items } = await connect(app, as(board.cy));
    await streamSub(connection, "logs", board.t1);
    await streamSub(connection, "status");
    // An item the size of quickdraw-chat's two-player world snapshot.
    const player = { x: 1204.5, y: 880.25, dx: 0.6, dy: -0.8, len: 42, boost: false, ack: 118 };
    const snapshot = { line: JSON.stringify({ tick: 4120, players: [player, player] }) };
    logs(app).push(board.t1, snapshot);
    app.server.stream(liveContract, "status").push("up");
    await settle(connection);
    expect(items).toEqual([
      ["taskService", "logs", board.t1, snapshot],
      ["taskService", "status", null, "up"],
    ]);
    // What each frame costs on the wire against rc.3's object frame, { s, stream, scope?, item }.
    const packet = (frame: unknown): number =>
      Buffer.byteLength(`42${JSON.stringify(["qd:stream", frame])}`);
    const [scoped, global] = items;
    const rc3Scoped = { s: "taskService", stream: "logs", scope: board.t1, item: snapshot };
    const rc3Global = { s: "taskService", stream: "status", item: "up" };
    // `"s":`, `"stream":`, `"scope":` and `"item":`: 28 bytes per scoped frame per subscriber.
    expect(packet(rc3Scoped) - packet(scoped)).toBe(28);
    // A global frame writes `null,` for its scope instead: 15 bytes.
    expect(packet(rc3Global) - packet(global)).toBe(15);
  });

  it("checks the item against the stream's schema, and keeps and sends nothing on a mismatch", async () => {
    const app = await start();
    const { connection, items } = await connect(app, as(board.cy));
    await streamSub(connection, "logs", board.t1);
    const bad = { line: 42 } as unknown as { line: string };
    expect(() => {
      logs(app).push(board.t1, bad);
    }).toThrow(expect.objectContaining({ code: "INTERNAL" }) as Error);
    await settle(connection);
    expect(items).toEqual([]);
    expect(await streamSub(connection, "logs", board.t1)).toEqual({ ok: true, seed: [] });
  });

  it("takes (scope, item) for a scoped stream and (item) for a global one", async () => {
    const app = await start();
    const loose = (name: "logs" | "status") =>
      app.server.stream(liveContract, name) as unknown as { push(...args: unknown[]): void };
    expect(() => {
      loose("logs").push({ line: "no scope" });
    }).toThrow("taskService.logs.push: logs is scoped");
    expect(() => {
      loose("logs").push("", { line: "empty scope" });
    }).toThrow("logs is scoped");
    expect(() => {
      loose("status").push("scope", "item");
    }).toThrow("taskService.status.push: pass (item)");
    expect(() => {
      loose("logs").push(board.t1, { line: "ok" }, "extra");
    }).toThrow("pass (scope, item)");
  });

  it("pushMany sends several items to one feed as pushes would, in order, and seeds them", async () => {
    const app = await start();
    const { connection, items } = await connect(app, as(board.cy));
    await streamSub(connection, "logs", board.t1);
    logs(app).pushMany(board.t1, [{ line: "a" }, { line: "b" }, { line: "c" }, { line: "d" }]);
    app.server.stream(liveContract, "status").pushMany(["up", "down"]);
    await settle(connection);
    expect(items).toEqual(
      ["a", "b", "c", "d"].map((line) => ["taskService", "logs", board.t1, { line }]),
    );
    const later = await connect(app, as(board.bo));
    expect(await streamSub(later.connection, "logs", board.t1)).toEqual({
      ok: true,
      seed: [{ line: "b" }, { line: "c" }, { line: "d" }],
    });
  });

  it("pushMany checks every item first: one mismatch keeps and sends none", async () => {
    const app = await start();
    const { connection, items } = await connect(app, as(board.cy));
    await streamSub(connection, "logs", board.t1);
    const bad = [{ line: "fine" }, { line: 42 }] as unknown as { line: string }[];
    expect(() => {
      logs(app).pushMany(board.t1, bad);
    }).toThrow(expect.objectContaining({ code: "INTERNAL" }) as Error);
    const loose = logs(app) as unknown as { pushMany(...args: unknown[]): void };
    expect(() => {
      loose.pushMany(board.t1, { line: "not a list" });
    }).toThrow("taskService.logs.pushMany: pass the items as an array");
    expect(() => {
      loose.pushMany([{ line: "no scope" }]);
    }).toThrow("taskService.logs.pushMany: logs is scoped");
    await settle(connection);
    expect(items).toEqual([]);
    expect(await streamSub(connection, "logs", board.t1)).toEqual({ ok: true, seed: [] });
  });

  it("throws a TypeError for a stream the dispatcher does not serve", async () => {
    const app = await start();
    const other = defineContract("otherService", { streams: { feed: { item: z.number() } } });
    expect(() => app.server.stream(other, "feed")).toThrow(
      "stream: the dispatcher serves no service named otherService",
    );
    expect(() => app.server.stream(liveContract, "nope" as "logs")).toThrow(
      'stream: taskService has no stream "nope"',
    );
  });

  it("keeps seeds without a server, sending nothing", () => {
    const local = initQuickdraw<{ principal: Principal }>();
    const feed = defineContract("feedService", {
      streams: { news: { item: z.string(), seed: 1, access: "public" } },
    });
    const dispatcher = createDispatcher({
      services: [local.defineService(feed, { methods: {} })],
    });
    expect(() => {
      dispatcher.stream(feed, "news").push("quiet");
    }).not.toThrow();
  });
});

const worldSnapshot = z.object({ tick: z.number().int(), food: z.array(z.string()) });

type WorldSnapshot = z.infer<typeof worldSnapshot>;

/** A game's worlds: its stream's items are deltas, so a subscriber starts from the current world. */
const worldContract = defineContract("worldService", {
  streams: {
    world: { item: worldSnapshot, scope: "worldId", volatile: true, access: "public" },
    lobby: { item: z.string(), access: "authenticated" },
  },
});

/** What a seed function was called with. */
interface SeedCall {
  readonly scope: string | undefined;
  readonly userId: string | null;
  readonly socketId: string;
}

/** The world service over `worlds`, the app's own state, recording each seed call into `calls`. */
function defineWorldService(worlds: Map<string, unknown>, calls: SeedCall[], wait?: Promise<void>) {
  return qd.defineService(worldContract, {
    methods: {},
    streams: {
      world: {
        seed: async (worldId, ctx) => {
          calls.push({
            scope: worldId,
            userId: ctx.principal?.userId ?? null,
            socketId: ctx.socketId,
          });
          await wait;
          if (worldId === "garbage") {
            return "not a list" as unknown as WorldSnapshot[];
          }
          const world = worlds.get(worldId);
          if (world === undefined) {
            throw new QuickdrawError("NOT_FOUND", `No world "${worldId}"`);
          }
          return [world as WorldSnapshot];
        },
      },
      lobby: {
        seed: (scope, ctx) => {
          calls.push({ scope, userId: ctx.principal?.userId ?? null, socketId: ctx.socketId });
          return ["welcome"];
        },
      },
    },
  });
}

async function startWorlds(
  worlds: Map<string, unknown>,
  calls: SeedCall[],
  options: { readonly wait?: Promise<void>; readonly logger?: Logger } = {},
) {
  const app = await createTestApp({
    services: [defineWorldService(worlds, calls, options.wait)],
    db: h.db,
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  apps.push(app as unknown as TestApp);
  return app;
}

describe("a seed the service computes", () => {
  it("answers each subscriber with the current state, under its principal, then the items pushed after it", async () => {
    const worlds = new Map<string, unknown>([["w1", { tick: 3, food: ["a", "b"] }]]);
    const calls: SeedCall[] = [];
    const app = await startWorlds(worlds, calls);
    const player = await connect(app, as(board.ada));
    expect(await streamSub(player.connection, "world", "w1", "worldService")).toEqual({
      ok: true,
      seed: [{ tick: 3, food: ["a", "b"] }],
    });
    expect(calls).toEqual([
      { scope: "w1", userId: board.ada, socketId: player.connection.socket.id },
    ]);
    // A tick: the app changes its world, then pushes the delta.
    worlds.set("w1", { tick: 4, food: ["b", "c"] });
    app.server.stream(worldContract, "world").push("w1", { tick: 4, food: ["c"] });
    await settle(player.connection);
    expect(player.items.map((frame) => frame[3])).toEqual([{ tick: 4, food: ["c"] }]);
    // A later spectator starts from the world as it is, not from the deltas pushed so far.
    const spectator = await connect(app, null);
    expect(await streamSub(spectator.connection, "world", "w1", "worldService")).toEqual({
      ok: true,
      seed: [{ tick: 4, food: ["b", "c"] }],
    });
    expect(calls[1]).toEqual({
      scope: "w1",
      userId: null,
      socketId: spectator.connection.socket.id,
    });
    // A global stream's seed function gets no scope.
    expect(await streamSub(player.connection, "lobby", undefined, "worldService")).toEqual({
      ok: true,
      seed: ["welcome"],
    });
    expect(calls[2]).toMatchObject({ scope: undefined, userId: board.ada });
  });

  it("joins before an asynchronous seed resolves: an item pushed meanwhile arrives too", async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const worlds = new Map<string, unknown>([["w1", { tick: 1, food: [] }]]);
    const calls: SeedCall[] = [];
    const app = await startWorlds(worlds, calls, { wait: gate });
    const { connection, items } = await connect(app, as(board.cy));
    const subscribing = streamSub(connection, "world", "w1", "worldService");
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    worlds.set("w1", { tick: 2, food: ["x"] });
    app.server.stream(worldContract, "world").push("w1", { tick: 2, food: ["x"] });
    await vi.waitFor(() => {
      expect(items).toHaveLength(1);
    });
    release();
    // The seed read the world after the push: the item arrived both ways, never neither.
    expect(await subscribing).toEqual({ ok: true, seed: [{ tick: 2, food: ["x"] }] });
  });

  it("answers what the function throws, or a seed that does not fit the stream, and leaves the feed", async () => {
    const worlds = new Map<string, unknown>([["bad", { tick: "late", food: [] }]]);
    const calls: SeedCall[] = [];
    const errors: string[] = [];
    const app = await startWorlds(worlds, calls, {
      logger: { ...quietLogger, error: (message) => errors.push(message) },
    });
    const { connection, items } = await connect(app, as(board.cy));
    expect(await streamSub(connection, "world", "w404", "worldService")).toEqual(
      refused("NOT_FOUND"),
    );
    expect(await streamSub(connection, "world", "bad", "worldService")).toEqual(
      refused("INTERNAL"),
    );
    expect(await streamSub(connection, "world", "garbage", "worldService")).toEqual(
      refused("INTERNAL"),
    );
    const world = app.server.stream(worldContract, "world");
    for (const scope of ["w404", "bad", "garbage"]) {
      world.push(scope, { tick: 9, food: [] });
    }
    await settle(connection);
    expect(items).toEqual([]);
    expect(app.server.io.sockets.sockets.get(connection.socket.id ?? "")?.data.streams).toEqual({});
    // The app's bugs are logged; a refusal it chose (NOT_FOUND) is the subscriber's answer only.
    expect(errors).toEqual(["A qd:stream:sub failed", "A qd:stream:sub failed"]);
  });

  it("is never called for a subscriber the stream's access refuses", async () => {
    const calls: SeedCall[] = [];
    const app = await startWorlds(new Map(), calls);
    const { connection } = await connect(app, null);
    expect(await streamSub(connection, "lobby", undefined, "worldService")).toEqual(
      refused("UNAUTHENTICATED"),
    );
    expect(calls).toEqual([]);
  });

  it("keeps nothing of what is pushed: every subscriber is asked for", async () => {
    const calls: SeedCall[] = [];
    const app = await startWorlds(new Map(), calls);
    const lobby = app.server.stream(worldContract, "lobby");
    lobby.push("one");
    lobby.push("two");
    const { connection } = await connect(app, as(board.cy));
    expect(await streamSub(connection, "lobby", undefined, "worldService")).toEqual({
      ok: true,
      seed: ["welcome"],
    });
  });
});

describe("access: { room }", () => {
  /** A socket of `app` with its typed calls, and the stream items it receives. */
  async function member(app: App, principal: Principal | null) {
    const connection = await app.connect(principal);
    return { connection, items: frames<StreamFrame>(connection, "qd:stream") };
  }

  it("opens a feed to the sockets in its app room, and revokes it when they leave", async () => {
    const app = await start();
    const cy = await member(app, as(board.cy));
    const revoked = frames(cy.connection, "qd:revoked");
    expect(await streamSub(cy.connection, "lobbyFeed")).toEqual(refused("FORBIDDEN"));
    await cy.connection.call.taskService.enter({ room: LOBBY });
    expect(await streamSub(cy.connection, "lobbyFeed")).toEqual({ ok: true, seed: [] });
    const lobby = app.server.stream(liveContract, "lobbyFeed");
    lobby.push(1);
    await settle(cy.connection);
    await cy.connection.call.taskService.exit({ room: LOBBY });
    expect(revoked).toEqual([
      { kind: "stream", reason: "access", s: "taskService", stream: "lobbyFeed" },
    ]);
    lobby.push(2);
    await settle(cy.connection);
    expect(cy.items).toEqual([["taskService", "lobbyFeed", null, 1]]);
  });

  it("computes a scoped feed's room from its scope, takes a prefix, and follows a removal", async () => {
    const app = await start();
    const cy = await member(app, as(board.cy));
    const revoked = frames<{ stream: string; scope?: string }>(cy.connection, "qd:revoked");
    await cy.connection.call.taskService.enter({ room: "world:1" });
    expect(await streamSub(cy.connection, "worldFeed", "1")).toEqual({ ok: true, seed: [] });
    expect(await streamSub(cy.connection, "worldFeed", "2")).toEqual(refused("FORBIDDEN"));
    expect(await streamSub(cy.connection, "anyWorld")).toEqual({ ok: true, seed: [] });
    await app.server.rooms.leave("world:1", { userId: board.cy });
    await vi.waitFor(() => {
      expect(revoked.map(({ stream, scope }) => `${stream}/${scope ?? ""}`).sort()).toEqual([
        "anyWorld/",
        "worldFeed/1",
      ]);
    });
    app.server.stream(liveContract, "worldFeed").push("1", 7);
    app.server.stream(liveContract, "anyWorld").push(8);
    await settle(cy.connection);
    expect(cy.items).toEqual([]);
  });

  it("lets an anonymous socket in the room subscribe and unsubscribe", async () => {
    const app = await start();
    const spectator = await member(app, null);
    await spectator.connection.call.taskService.enterAnyone({ room: LOBBY });
    expect(await streamSub(spectator.connection, "lobbyFeed")).toEqual({ ok: true, seed: [] });
    expect(await streamUnsub(spectator.connection, "lobbyFeed")).toEqual({ ok: true });
  });

  it("refuses a room no socket could be in, when the contract is defined", () => {
    const stream = (access: unknown, scope?: string) => () =>
      (defineContract as unknown as (name: string, def: unknown) => unknown)("roomFeedService", {
        streams: { feed: { item: z.number(), access, ...(scope === undefined ? {} : { scope }) } },
      });
    expect(stream({ room: "qd:e:x" })).toThrow('room "qd:e:x" is no app room');
    expect(stream({ room: { prefix: "user:" } })).toThrow('room "user:" is no app room');
    expect(stream({ room: "" })).toThrow("room must be an app room's name");
    expect(stream({ room: "lobby", service: "Read" })).toThrow(
      "a room form is { room } and nothing else",
    );
    expect(stream({ room: () => "lobby" })).toThrow(
      "a room computed from the scope needs a scoped stream",
    );
    expect(stream({ room: () => "lobby" }, "lobbyId")).not.toThrow();
  });
});

describe('validate: "development"', () => {
  const hot = defineContract("hotService", {
    streams: {
      snaps: { item: z.object({ tick: z.number() }), access: "public" },
      strict: { item: z.object({ tick: z.number() }), access: "public" },
    },
  });
  const defineHot = () =>
    qd.defineService(hot, {
      methods: {},
      streams: { snaps: { validate: "development" } },
    });

  async function startHot(outputValidation: boolean) {
    const app = await createTestApp({ services: [defineHot()], db: h.db, outputValidation });
    apps.push(app as unknown as TestApp);
    return app;
  }

  it("checks pushed items only while the dispatcher checks outputs", async () => {
    const bad = { tick: "late", extra: true } as unknown as { tick: number };
    const checked = await startHot(true);
    expect(() => {
      checked.server.stream(hot, "snaps").push(bad);
    }).toThrow(expect.objectContaining({ code: "INTERNAL" }) as Error);
    const production = await startHot(false);
    const { connection, items } = await connect(production, null);
    await streamSub(connection, "snaps", undefined, "hotService");
    // Unchecked: the item goes out as pushed, its extra key included.
    production.server.stream(hot, "snaps").push(bad);
    // A stream that keeps the default still checks.
    expect(() => {
      production.server.stream(hot, "strict").push(bad);
    }).toThrow(expect.objectContaining({ code: "INTERNAL" }) as Error);
    await settle(connection);
    expect(items).toEqual([["hotService", "snaps", null, { tick: "late", extra: true }]]);
  });

  it("refuses any other value", () => {
    expect(() =>
      (qd.defineService as unknown as (contract: unknown, definition: unknown) => unknown)(hot, {
        methods: {},
        streams: { snaps: { validate: "sometimes" } },
      }),
    ).toThrow('streams.snaps.validate must be "always" or "development"');
  });
});

describe("app.frames, typed", () => {
  it("waits for a contract's stream item, room event and presence frame, their data typed", async () => {
    const app = await start();
    const cy = await app.connect(as(board.cy));
    await streamSub(cy, "logs", board.t1);
    for (const line of ["one", "two"]) {
      logs(app).push(board.t1, { line });
    }
    const item = await app.frames.waitFor({
      ...streamFrames(liveContract, "logs", (logLine) => logLine.line === "two", board.t1),
      socketId: cy.socket.id,
    });
    expect(item.data[3].line).toBe("two");
    expect(app.frames(streamFrames(liveContract, "logs")).map(({ data }) => data[3].line)).toEqual([
      "one",
      "two",
    ]);
    await cy.call.taskService.enter({ room: LOBBY });
    const joined = await app.frames.waitFor({
      event: "qd:presence",
      where: ({ data }) => data.users?.includes(board.cy) === true,
    });
    expect(joined.data.room).toBe(LOBBY);
    await cy.call.taskService.celebrate({ room: LOBBY, taskId: board.t1 });
    const event = await app.frames.waitFor(
      eventFrames(liveContract, "celebrated", (payload) => payload.taskId === board.t1),
    );
    expect(event.data[2].taskId).toBe(board.t1);
  });
});

describe("streams in defineService", () => {
  const counted = defineContract("countedService", {
    streams: {
      kept: { item: z.number(), seed: 5, access: "public" },
      computed: { item: z.number(), scope: "roomId", access: "public" },
    },
  });
  const define = (streams: unknown): unknown =>
    (qd.defineService as unknown as (contract: unknown, definition: unknown) => unknown)(counted, {
      methods: {},
      streams,
    });
  const seed = (): number[] => [];

  it("takes a seed function per contract stream that keeps none", () => {
    const service = define({ computed: { seed } }) as {
      readonly streams: ReadonlyMap<string, { readonly computeSeed: unknown }>;
    };
    expect(service.streams.get("computed")?.computeSeed).toBe(seed);
    expect(service.streams.get("kept")?.computeSeed).toBeUndefined();
    expect(() => define(undefined)).not.toThrow();
  });

  it("refuses what is not a stream option", () => {
    expect(() => define("seed")).toThrow("streams must be an object");
    expect(() => define({ nope: { seed } })).toThrow(
      'streams: "nope" is not a stream of the contract',
    );
    expect(() => define({ computed: seed })).toThrow("streams.computed must be an object");
    expect(() => define({ computed: { seed, size: 3 } })).toThrow(
      'streams.computed has an unknown option "size"',
    );
    expect(() => define({ computed: { seed: [1, 2] } })).toThrow(
      "streams.computed.seed must be a function",
    );
    expect(() => define({ kept: { seed } })).toThrow(
      "streams.kept.seed computes the seed, but the contract's stream keeps the latest 5 items",
    );
  });
});

describe("the seeds", () => {
  it("keep the latest items of a scope, at most the stream's seed", () => {
    const seeds = new StreamSeeds();
    for (const item of [1, 2, 3]) {
      seeds.push("s\u0000logs", "t1", item, 2);
    }
    seeds.push("s\u0000logs", "t2", 9, 0);
    expect(seeds.seed("s\u0000logs", "t1")).toEqual([2, 3]);
    expect(seeds.seed("s\u0000logs", "t2")).toEqual([]);
    expect(seeds.seed("s\u0000logs", "__proto__")).toEqual([]);
  });

  it(`keep at most ${STREAM_MAX_SCOPES} scopes per stream, dropping the one pushed to least recently`, () => {
    const seeds = new StreamSeeds();
    for (let n = 0; n < STREAM_MAX_SCOPES; n += 1) {
      seeds.push("s\u0000logs", `scope${n}`, n, 1);
    }
    seeds.push("s\u0000logs", "scope0", "fresh", 1);
    seeds.push("s\u0000logs", "newest", "new", 1);
    expect(seeds.scopes("s\u0000logs")).toBe(STREAM_MAX_SCOPES);
    expect(seeds.seed("s\u0000logs", "scope0")).toEqual(["fresh"]);
    expect(seeds.seed("s\u0000logs", "scope1")).toEqual([]);
    expect(seeds.seed("s\u0000logs", "newest")).toEqual(["new"]);
  });
});

describe("qd.stream, qd.presence and qd.run with createTestApp", () => {
  it("go through the test app's dispatcher, the current one of the instance that defined its services", async () => {
    const local = initQuickdraw<{ principal: Principal }>();
    const feed = defineContract("feedService", {
      streams: { news: { item: z.string(), seed: 2, access: "public" } },
    });
    const service = local.defineService(feed, { methods: {} });
    const news = local.stream(feed, "news");
    const app = await createTestApp({ services: [service] });
    apps.push(app as unknown as TestApp);
    const connection = await app.connect({ userId: "u1" });
    const items = frames<StreamFrame>(connection, "qd:stream");
    expect(await streamSub(connection, "news", undefined, "feedService")).toEqual({
      ok: true,
      seed: [],
    });
    news.push("pushed through qd.stream");
    await settle(connection);
    expect(items.map((frame) => frame[3])).toEqual(["pushed through qd.stream"]);
    expect(await local.presence.isOnline("u1")).toBe(true);
    expect(await local.run(() => "ran")).toBe("ran");
  });
});

describe("qd.stream and qd.presence", () => {
  it("push and ask through the dispatcher the instance created last, and fail before there is one", async () => {
    const local = initQuickdraw<{ principal: Principal }>();
    const feed = defineContract("feedService", {
      streams: { news: { item: z.string(), seed: 2, access: "public" } },
    });
    const service = local.defineService(feed, { methods: {} });
    const news = local.stream(feed, "news");
    expect(() => {
      news.push("early");
    }).toThrow("qd.stream has no dispatcher to push through");
    await expect(local.presence.isOnline("u1")).rejects.toThrow("qd.presence has no dispatcher");
    expect(() => local.stream(feed, "nope" as "news")).toThrow(
      'qd.stream: feedService declares no stream "nope"',
    );
    const server = local.createServer({
      services: [service],
      auth: { authenticate: () => ({ userId: "u1" }) },
      logger: quietLogger,
    });
    await new Promise<void>((resolve) => {
      server.httpServer.listen(0, "127.0.0.1", resolve);
    });
    const { port } = server.httpServer.address() as { readonly port: number };
    const { socket } = await connectV5(`http://127.0.0.1:${port}`, {}, 5000);
    try {
      news.push("one");
      news.push("two");
      news.push("three");
      const reply = await socket.timeout(5000).emitWithAck("qd:stream:sub", {
        s: "feedService",
        stream: "news",
      });
      expect(reply).toEqual({ ok: true, seed: ["two", "three"] });
      expect(await local.presence.isOnline("u1")).toBe(true);
      expect(await local.presence.isOnline("u2")).toBe(false);
    } finally {
      socket.disconnect();
      await server.close();
    }
  });
});

const quietLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quietLogger,
};

/** Sends any frame as `qd:stream:sub` and resolves with the acknowledgement. */
function emitFrame(connection: Pick<TestConnection, "socket">, frame: unknown): Promise<unknown> {
  return emitWithAck(connection.socket, "qd:stream:sub", frame);
}
