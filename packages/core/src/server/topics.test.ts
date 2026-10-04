// Change topics (RFC 0003 section 11.3) through a real server against PGlite:
// `qd:watch` is authorized like a subscribe to the scope (or by the service's
// `watchAccess`) and sends no snapshot; every flush that changes a watched
// topic sends `qd:changed { s, topic, rev }` once, with no data; and the
// definition-time checks of `watch` and `watchAccess`.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../test/prisma/setup";
import { defineContract, query, topicRoom, type AnyContract } from "../index";
import { createHarness, type Harness } from "../prisma/__tests__/harness";
import { createTestApp, emitWithAck, type TestApp } from "../testing/index";
import { as, seedBoard, type Board } from "./access/__tests__/board";
import {
  colSub,
  defineTaskService,
  labelService,
  receiveScopes,
  taskContract,
  unwatch,
  watch,
  type TaskServiceOptions,
} from "./collections/__tests__/fixture";
import { projectService, qd, recordingStorage, type Read } from "./emit/__tests__/live";
import type { AnyService, Principal, ServiceGrants } from "./index";

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

/** A service without a model: its rows never change, so it has no topic. */
const pingContract = defineContract("pingService", {
  methods: { ping: query({ input: z.undefined(), output: z.literal("pong") }) },
});

const pingService = qd.defineService(pingContract, {
  methods: { ping: { access: "public", handler: () => "pong" as const } },
});

/**
 * A service with no model that writes labels (a game's high scores, which
 * no service owns): its topic changes with every label written, so a query
 * over them can watch it.
 */
const scoresContract = defineContract("scoresService", {
  methods: {
    best: query({ input: z.undefined(), output: z.number(), watch: "service" }),
  },
});

const scoresService = qd.defineService(scoresContract, {
  writes: ["label"],
  watchAccess: "authenticated",
  methods: {
    best: { access: "authenticated", handler: async ({ db }) => await db.label.count() },
  },
});

interface StartOptions extends TaskServiceOptions {
  readonly after?: (read: Read) => Promise<void> | undefined;
  readonly rateLimit?: { readonly maxRequests: number };
  readonly loadServiceAccess?: (userId: string) => ServiceGrants;
}

async function start(options: StartOptions = {}) {
  const recorded = recordingStorage(h.storage, options.after);
  const app = await createTestApp({
    services: [
      projectService,
      labelService,
      defineTaskService(options),
      pingService,
      scoresService,
    ],
    db: h.db,
    storage: recorded.storage,
    ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }),
    ...(options.loadServiceAccess === undefined
      ? {}
      : { auth: { loadServiceAccess: options.loadServiceAccess } }),
  });
  apps.push(app as unknown as TestApp);
  return { app, reads: recorded.reads };
}

type App = Awaited<ReturnType<typeof start>>["app"];

async function connect(app: App, principal: Principal | null) {
  const connection = await app.connect(principal);
  return { connection, scopes: receiveScopes(connection) };
}

function write<T>(app: App, fn: (db: PrismaClient) => Promise<T>): Promise<T> {
  return app.server.dispatcher.run(async () => await fn(h.db));
}

function inTopic(app: App, topic: string): number {
  return app.server.io.sockets.adapter.rooms.get(topicRoom("taskService", topic))?.size ?? 0;
}

const ok = { ok: true };

function refused(code: string) {
  return { ok: false, e: expect.objectContaining({ code }) };
}

describe("qd:changed", () => {
  it("is sent once per flush per watched topic, ten writes in one method included, with no data", async () => {
    const { app } = await start({ watchAccess: "authenticated" });
    const { connection, scopes } = await connect(app, as(board.ada));
    expect(await watch(connection, `board:${board.p1}`)).toEqual(ok);
    expect(await watch(connection, "service")).toEqual(ok);
    await app.as(as(board.ada)).taskService.renameTenTimes({ id: board.t1 });
    await scopes.settle();
    expect(scopes.changed).toEqual([
      { s: "taskService", topic: "service", rev: expect.any(Number) },
      { s: "taskService", topic: `board:${board.p1}`, rev: expect.any(Number) },
    ]);
    const [service, scope] = scopes.changed;
    expect(service?.rev).toBe(scope?.rev);
    // A change signal carries no rows: the watcher subscribed to nothing.
    expect(scopes.frames).toEqual([]);
  });

  it("is sent for both scopes a row moves between, and only to the scopes a flush changed", async () => {
    const { app } = await start();
    const left = await connect(app, as(board.ada));
    const entered = await connect(app, as(board.ed));
    await watch(left.connection, `board:${board.p1}`);
    await watch(entered.connection, `board:${board.p2}`);
    await write(app, (db) =>
      db.task.update({ where: { id: board.t1 }, data: { projectId: board.p2 } }),
    );
    await Promise.all([left.scopes.settle(), entered.scopes.settle()]);
    expect(left.scopes.changed.map(({ topic }) => topic)).toEqual([`board:${board.p1}`]);
    expect(entered.scopes.changed.map(({ topic }) => topic)).toEqual([`board:${board.p2}`]);
    left.scopes.clear();
    entered.scopes.clear();
    await write(app, (db) => db.task.update({ where: { id: board.t2 }, data: { title: "P2" } }));
    await Promise.all([left.scopes.settle(), entered.scopes.settle()]);
    expect(left.scopes.changed).toEqual([]);
    expect(entered.scopes.changed.map(({ topic }) => topic)).toEqual([`board:${board.p2}`]);
  });

  it("is sent for a scope closed by deleting its anchor row, and for a via scope's junction writes", async () => {
    const { app } = await start({ watchAccess: "authenticated" });
    const label = await h.prisma.label.create({ data: { projectId: board.p1, name: "Bug" } });
    const { connection, scopes } = await connect(app, as(board.ada));
    await watch(connection, `byLabel:${label.id}`);
    await watch(connection, "service");
    await write(app, (db) =>
      db.taskLabel.create({ data: { taskId: board.t1, labelId: label.id } }),
    );
    await scopes.settle();
    expect(scopes.changed.map(({ topic }) => topic)).toEqual(["service", `byLabel:${label.id}`]);
    scopes.clear();
    await watch(connection, `board:${board.p1}`);
    await write(app, (db) => db.project.delete({ where: { id: board.p1 } }));
    await scopes.settle();
    // Deleting the anchor row ends both scopes' watches (the label went with it, by cascade):
    // each gets one last qd:changed as it leaves its room; the service topic stays.
    expect(scopes.changed.map(({ topic }) => topic).sort()).toEqual(
      ["service", `board:${board.p1}`, `byLabel:${label.id}`].sort(),
    );
    expect(scopes.changed.at(-1)?.topic).toBe("service");
    expect(inTopic(app, `board:${board.p1}`)).toBe(0);
    expect(inTopic(app, `byLabel:${label.id}`)).toBe(0);
    expect(inTopic(app, "service")).toBe(1);
  });

  it("stops after qd:unwatch, and a topic watched twice is left at once", async () => {
    const { app } = await start();
    const { connection, scopes } = await connect(app, as(board.ada));
    await watch(connection, `board:${board.p1}`);
    await watch(connection, `board:${board.p1}`);
    expect(inTopic(app, `board:${board.p1}`)).toBe(1);
    expect(await unwatch(connection, `board:${board.p1}`)).toEqual(ok);
    expect(inTopic(app, `board:${board.p1}`)).toBe(0);
    await write(app, (db) =>
      db.task.update({ where: { id: board.t1 }, data: { title: "Unseen" } }),
    );
    await scopes.settle();
    expect(scopes.changed).toEqual([]);
    // Checked as qd:watch is: an unknown service or collection is NOT_FOUND.
    expect(await unwatch(connection, "nope:x", "noService")).toEqual(refused("NOT_FOUND"));
    expect(await unwatch(connection, "nope:x")).toEqual(refused("NOT_FOUND"));
    expect(await emitWithAck(connection.socket, "qd:unwatch", { s: "taskService" })).toMatchObject(
      refused("VALIDATION"),
    );
  });
});

describe("a model a service writes", () => {
  it('changes the writing service\'s topic, which a query over it watches with watch: "service"', async () => {
    const { app } = await start();
    const { connection, scopes } = await connect(app, as(board.ada));
    expect(await watch(connection, "service", "scoresService")).toEqual(ok);
    await write(app, (db) =>
      db.task.update({ where: { id: board.t1 }, data: { title: "Not a label" } }),
    );
    await scopes.settle();
    expect(scopes.changed).toEqual([]);
    await write(app, (db) => db.label.create({ data: { projectId: board.p1, name: "Bug" } }));
    await scopes.settle();
    expect(scopes.changed).toEqual([
      { s: "scoresService", topic: "service", rev: expect.any(Number) },
    ]);
    expect(scoresContract.methods.best.watch).toBe("service");
    expect(await app.as(as(board.ada)).scoresService.best()).toBe(1);
  });
});

describe("access loss", () => {
  it("takes a member who lost access to a scope out of its topic, after one last qd:changed", async () => {
    const { app } = await start();
    const member = await connect(app, as(board.cy));
    const other = await connect(app, as(board.bo));
    await watch(member.connection, `board:${board.p1}`);
    await watch(other.connection, `board:${board.p1}`);
    await app
      .as(as(board.ada))
      .projectService.removeMember({ projectId: board.p1, userId: board.cy });
    await Promise.all([member.scopes.settle(), other.scopes.settle()]);
    expect(member.scopes.changed).toEqual([
      { s: "taskService", topic: `board:${board.p1}`, rev: expect.any(Number) },
    ]);
    expect(other.scopes.changed).toEqual([]);
    expect(inTopic(app, `board:${board.p1}`)).toBe(1);
    member.scopes.clear();
    await write(app, (db) => db.task.update({ where: { id: board.t1 }, data: { title: "Later" } }));
    await Promise.all([member.scopes.settle(), other.scopes.settle()]);
    expect(member.scopes.changed).toEqual([]);
    expect(other.scopes.changed.map(({ topic }) => topic)).toEqual([`board:${board.p1}`]);
  });

  it("takes a user whose grants no longer reach watchAccess out of the service topic", async () => {
    const { app } = await start({
      watchAccess: { service: "Read" },
      loadServiceAccess: () => ({}),
    });
    const reader = await connect(app, as(board.ed, { taskService: "Read" }));
    expect(await watch(reader.connection, "service")).toEqual(ok);
    await app.server.access.refresh(board.ed);
    await reader.scopes.settle();
    expect(reader.scopes.changed).toEqual([
      { s: "taskService", topic: "service", rev: expect.any(Number) },
    ]);
    expect(inTopic(app, "service")).toBe(0);
  });
});

describe("qd:watch", () => {
  it("authorizes a scope's topic exactly as a subscribe to the scope, and sends no snapshot", async () => {
    const { app } = await start();
    const forbidden = refused("FORBIDDEN");
    const member = await connect(app, as(board.cy));
    expect(await watch(member.connection, `board:${board.p1}`)).toEqual(ok);
    const listed = await connect(app, as(board.di));
    expect(await watch(listed.connection, `byProject:${board.p1}`)).toEqual(ok);
    const outsider = await connect(app, as(board.ed));
    expect(await watch(outsider.connection, `board:${board.p1}`)).toEqual(forbidden);
    expect(await colSub(outsider.connection, "board", board.p1)).toEqual(forbidden);
    const owner = await connect(app, as(board.ada));
    expect(await watch(owner.connection, "board:missing")).toEqual(forbidden);
    expect(await watch(owner.connection, `mine:${board.ada}`)).toEqual(ok);
    expect(await watch(owner.connection, `mine:${board.bo}`)).toEqual(forbidden);
    const projectAdmin = await connect(app, as(board.ed, { projectService: "Admin" }));
    expect(await watch(projectAdmin.connection, `board:${board.p1}`)).toEqual(forbidden);
    const taskAdmin = await connect(app, as(board.ed, { taskService: "Admin" }));
    expect(await watch(taskAdmin.connection, "board:missing")).toEqual(ok);
    const anonymous = await connect(app, null);
    expect(await watch(anonymous.connection, `board:${board.p1}`)).toEqual(
      refused("UNAUTHENTICATED"),
    );
    expect(inTopic(app, `board:${board.p1}`)).toBe(1);
    await Promise.all([member.scopes.settle(), owner.scopes.settle()]);
    expect([...member.scopes.frames, ...owner.scopes.frames]).toEqual([]);
  });

  it("keeps the service topic closed without watchAccess: it would tell anyone when other tenants' rows change", async () => {
    const { app } = await start();
    const closed = {
      ok: false,
      e: {
        code: "FORBIDDEN",
        message: "taskService keeps its service topic closed: it declares no watchAccess",
      },
    };
    const anonymous = await connect(app, null);
    expect(await watch(anonymous.connection, "service")).toEqual(closed);
    const owner = await connect(app, as(board.ada));
    expect(await watch(owner.connection, "service")).toEqual(closed);
    const admin = await connect(app, as(board.ed, { taskService: "Admin" }));
    expect(await watch(admin.connection, "service")).toEqual(closed);
    expect(inTopic(app, "service")).toBe(0);
    // A scope's topic stays open to whoever may subscribe to the scope.
    expect(await watch(owner.connection, `board:${board.p1}`)).toEqual(ok);
  });

  it("authorizes the service topic for any signed-in user with watchAccess: authenticated", async () => {
    const { app } = await start({ watchAccess: "authenticated" });
    const anonymous = await connect(app, null);
    expect(await watch(anonymous.connection, "service")).toEqual(refused("UNAUTHENTICATED"));
    const anyone = await connect(app, as(board.ed));
    expect(await watch(anyone.connection, "service")).toEqual(ok);
  });

  it("authorizes the service topic by a service grant, or for anyone", async () => {
    const { app } = await start({ watchAccess: { service: "Moderate" } });
    const plain = await connect(app, as(board.ada));
    expect(await watch(plain.connection, "service")).toEqual(refused("FORBIDDEN"));
    const granted = await connect(app, as(board.ed, { taskService: "Moderate" }));
    expect(await watch(granted.connection, "service")).toEqual(ok);
    // The watch of a scope's topic does not use watchAccess.
    expect(await watch(plain.connection, `board:${board.p1}`)).toEqual(ok);
    const open = await start({ watchAccess: "public" });
    const anonymous = await connect(open.app, null);
    expect(await watch(anonymous.connection, "service")).toEqual(ok);
    await write(open.app, (db) =>
      db.task.update({ where: { id: board.t1 }, data: { title: "Seen" } }),
    );
    await anonymous.scopes.settle();
    expect(anonymous.scopes.changed).toEqual([
      { s: "taskService", topic: "service", rev: expect.any(Number) },
    ]);
  });

  it("refuses malformed frames as VALIDATION and unknown topics as NOT_FOUND", async () => {
    const { app } = await start({ watchAccess: "authenticated" });
    const { connection } = await connect(app, as(board.ada));
    const frame = (value: unknown) => emitWithAck(connection.socket, "qd:watch", value);
    const invalid = (path: string) => ({
      ok: false,
      e: { code: "VALIDATION", data: { issues: [{ path: path === "" ? [] : [path] }] } },
    });
    expect(await frame({ s: "taskService" })).toMatchObject(invalid(""));
    expect(await frame({ s: "taskService", topic: "" })).toMatchObject(invalid(""));
    expect(await frame({ topic: "service" })).toMatchObject(invalid(""));
    for (const topic of ["board", "board:", ":p1"]) {
      expect(await watch(connection, topic), topic).toMatchObject(invalid("topic"));
    }
    expect(await watch(connection, "service", "noService")).toEqual({
      ok: false,
      e: { code: "NOT_FOUND", message: 'Unknown service "noService"' },
    });
    expect(await watch(connection, "nope:p1")).toEqual({
      ok: false,
      e: { code: "NOT_FOUND", message: 'taskService has no collection "nope"' },
    });
    expect(await watch(connection, "service", "pingService")).toMatchObject(refused("NOT_FOUND"));
  });

  it("does not join a topic the client unwatched while it was authorized", async () => {
    let unwatching: (() => Promise<unknown>) | undefined;
    let armed = true;
    const { app } = await start({
      after: (read) => {
        if (!armed || read.model !== "project") {
          return undefined;
        }
        armed = false;
        return unwatching?.().then(() => undefined);
      },
    });
    const { connection } = await connect(app, as(board.ada));
    unwatching = () => unwatch(connection, `board:${board.p1}`);
    expect(await watch(connection, `board:${board.p1}`)).toEqual(ok);
    expect(armed).toBe(false);
    expect(inTopic(app, `board:${board.p1}`)).toBe(0);
  });

  it("is not counted by the socket rate limiter", async () => {
    const { app } = await start({ rateLimit: { maxRequests: 2 } });
    const { connection } = await connect(app, as(board.ada));
    for (let round = 0; round < 5; round += 1) {
      expect(await watch(connection, `board:${board.p1}`)).toEqual(ok);
      expect(await unwatch(connection, `board:${board.p1}`)).toEqual(ok);
    }
    const call = (id: number) =>
      emitWithAck(connection.socket, "qd:call", {
        id,
        s: "taskService",
        m: "get",
        i: { id: board.t1 },
      });
    expect(await call(1)).toMatchObject({ ok: true });
    expect(await call(2)).toMatchObject({ ok: true });
    expect(await call(3)).toMatchObject(refused("RATE_LIMITED"));
  });
});

describe("what topics read", () => {
  /** Reads of task rows: what finding a touched row's scope costs. */
  function taskReads(reads: readonly Read[]): Read[] {
    return reads.filter((read) => read.model === "task");
  }

  it("is nothing for topics nobody here watches, and one read a flush shares with the collection sink", async () => {
    const { app, reads } = await start();
    const touch = h.storage.unitOfWork.touch;
    const touchT1 = () => write(app, () => Promise.resolve(touch?.("task", [board.t1])));
    reads.length = 0;
    await touchT1();
    expect(reads).toEqual([]);
    const watcher = await connect(app, as(board.ada));
    await watch(watcher.connection, `board:${board.p1}`);
    reads.length = 0;
    await touchT1();
    expect(taskReads(reads)).toHaveLength(1);
    const subscriber = await connect(app, as(board.ada));
    await colSub(subscriber.connection, "board", board.p1);
    reads.length = 0;
    await touchT1();
    expect(taskReads(reads)).toHaveLength(1);
    await Promise.all([watcher.scopes.settle(), subscriber.scopes.settle()]);
    expect(watcher.scopes.changed.map(({ topic }) => topic)).toEqual([
      `board:${board.p1}`,
      `board:${board.p1}`,
    ]);
    expect(subscriber.scopes.frames.map(({ deltas }) => deltas.map(({ t }) => t))).toEqual([
      ["added"],
    ]);
  });

  it("forgets a disconnected socket's watches", async () => {
    const { app, reads } = await start();
    const { connection } = await connect(app, as(board.ada));
    await watch(connection, `board:${board.p1}`);
    const serverSocket = app.server.io.sockets.sockets.get(connection.socket.id ?? "");
    const gone = new Promise<void>((resolve) => {
      serverSocket?.once("disconnect", () => {
        resolve();
      });
    });
    connection.close();
    await gone;
    expect(inTopic(app, `board:${board.p1}`)).toBe(0);
    reads.length = 0;
    const touch = h.storage.unitOfWork.touch;
    await write(app, () => Promise.resolve(touch?.("task", [board.t1])));
    expect(reads).toEqual([]);
  });
});

describe("definition", () => {
  const defineLoosely = qd.defineService as (contract: unknown, definition: unknown) => AnyService;

  it("checks a query's watch against the service's collections, for a contract defineContract never saw", () => {
    const forge = (watched: unknown, kind = "query") =>
      Object.freeze({
        ...taskContract,
        methods: Object.freeze({
          ...taskContract.methods,
          countOnBoard: Object.freeze({
            ...taskContract.methods.countOnBoard,
            kind,
            watch: watched,
          }),
        }),
      }) as AnyContract;
    const service = defineTaskService();
    const definition = {
      model: service.model,
      access: service.access,
      collections: Object.fromEntries(
        [...service.collections].map(([name, collection]) => [
          name,
          collection.anchor === undefined ? { scopeAccess: "self" } : { anchor: collection.anchor },
        ]),
      ),
      methods: Object.fromEntries(
        Object.entries(service.methods).map(([name, method]) => [
          name,
          { access: method.access, handler: method.handler },
        ]),
      ),
    };
    const refuses = (contract: AnyContract, message: string) =>
      expect(() => defineLoosely(contract, definition)).toThrow(message);
    refuses(
      forge({ collection: "nope", scope: () => "p" }),
      `defineService("taskService"): method "countOnBoard" watches "nope", which is not a collection of taskService`,
    );
    refuses(
      forge({ collection: "board" }),
      'method "countOnBoard": watch needs a scope function, which finds the scope from the input',
    );
    refuses(
      forge({ collection: "board", scope: () => "p" }, "mutation"),
      'method "countOnBoard" is a mutation; only a query can watch',
    );
    expect(() => defineLoosely(taskContract, definition)).not.toThrow();
  });

  it("refuses a query that watches its service's topic when the service keeps it closed", () => {
    expect(() =>
      defineLoosely(scoresContract, {
        writes: ["label"],
        methods: { best: { access: "authenticated", handler: () => 0 } },
      }),
    ).toThrow(
      'defineService("scoresService"): method "best" watches the service\'s topic, which is closed without watchAccess',
    );
  });

  it("takes watchAccess as public, authenticated or a service grant, and none by default", () => {
    expect(defineTaskService().watchAccess).toBeUndefined();
    expect(defineTaskService({ watchAccess: "authenticated" }).watchAccess).toBe("authenticated");
    expect(defineTaskService({ watchAccess: "public" }).watchAccess).toBe("public");
    expect(defineTaskService({ watchAccess: { service: "Read" } }).watchAccess).toEqual({
      service: "Read",
    });
    for (const watchAccess of [{ entry: "Read" }, { service: "Owner" }, "anyone", custom()]) {
      expect(() => defineTaskService({ watchAccess } as unknown as TaskServiceOptions)).toThrow(
        'watchAccess must be "public", "authenticated" or { service: level }',
      );
    }
  });
});

/** A custom access form, which watchAccess does not take. */
function custom() {
  return { kind: "custom", check: () => true };
}
