// Streams (RFC 0003 section 12.5) through a real server against PGlite: a
// subscriber gets the seed, then every item pushed after it in order; a later
// subscriber's seed holds the latest items, at most `seed` of them, per
// scope; `qd:stream:sub` is authorized with the stream's access form through
// the access engine (a stream without one is closed); malformed frames,
// unknown names and scopes that do not fit are refused; an unsubscribe stops
// the frames, even one that arrives while the subscribe is being
// authorized; and `push` checks what it sends.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract } from "../../contract/defineContract";
import type { Logger } from "../../contract/logger";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { connectV5 } from "../../testing/socket";
import { createTestApp, emitWithAck, type TestApp, type TestConnection } from "../../testing/index";
import { as, projectService, seedBoard, type Board } from "../access/__tests__/board";
import { recordingStorage, type Read } from "../emit/__tests__/live";
import { createDispatcher, initQuickdraw, type Principal } from "../index";
import {
  defineLiveService,
  frames,
  liveContract,
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

function logs(app: App) {
  return app.server.stream(liveContract, "logs");
}

async function connect(app: App, principal: Principal | null) {
  const connection = await app.connect(principal);
  return { connection, items: frames<Record<string, unknown>>(connection, "qd:stream") };
}

describe("qd:stream:sub", () => {
  it("answers with the seed, then sends every item pushed after it, in order", async () => {
    const app = await start();
    logs(app).push(board.t1, { line: "one" });
    logs(app).push(board.t1, { line: "two" });
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
      ["three", "four", "five"].map((line) => ({
        s: "taskService",
        stream: "logs",
        scope: board.t1,
        item: { line },
      })),
    );
  });

  it("gives a later subscriber a seed holding the latest items, at most the stream's seed", async () => {
    const app = await start();
    const first = await connect(app, as(board.cy));
    await streamSub(first.connection, "logs", board.t1);
    for (const line of ["a", "b", "c", "d"]) {
      logs(app).push(board.t1, { line });
    }
    const second = await connect(app, as(board.bo));
    expect(await streamSub(second.connection, "logs", board.t1)).toEqual({
      ok: true,
      seed: [{ line: "b" }, { line: "c" }, { line: "d" }],
    });
    await settle(first.connection);
    expect(first.items.map((frame) => frame.item)).toEqual(
      ["a", "b", "c", "d"].map((line) => ({ line })),
    );
  });

  it("keeps one feed and one seed per scope, and one for a global stream", async () => {
    const app = await start();
    logs(app).push(board.t1, { line: "on t1" });
    logs(app).push(board.t2, { line: "on t2" });
    const status = app.server.stream(liveContract, "status");
    status.push("up");
    const cy = await connect(app, as(board.cy));
    expect(await streamSub(cy.connection, "logs", board.t1)).toEqual({
      ok: true,
      seed: [{ line: "on t1" }],
    });
    expect(await streamSub(cy.connection, "status")).toEqual({ ok: true, seed: ["up"] });
    logs(app).push(board.t2, { line: "t2 again" });
    status.push("down");
    await settle(cy.connection);
    expect(cy.items).toEqual([{ s: "taskService", stream: "status", item: "down" }]);
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
    expect(anonymous.items).toEqual([{ s: "taskService", stream: "ticks", item: 1 }]);
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
    expect(reader.items.map((frame) => frame.item)).toEqual([{ line: "before" }]);
    expect(owner.items.map((frame) => frame.item)).toEqual([{ line: "before" }, { line: "after" }]);
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
