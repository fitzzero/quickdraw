// Projections and entity subscriptions (RFC 0003 sections 4.3, 5.3, 6 and 9)
// through a real server against PGlite, asserting the exact replies and
// frames real socket clients receive, and what the framework reads.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { entityRoom } from "../../index";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, type TestApp } from "../../testing/index";
import { deferred } from "../__tests__/fixtures";
import { as, seedBoard, type Board } from "../access/__tests__/board";
import type { Principal } from "../index";
import {
  cardService,
  defineTaskService,
  projectService,
  receive,
  recordingStorage,
  sub,
  TASK_KEYS,
  type Gate,
} from "./__tests__/live";

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

/** The board's services on a test app: projects, tasks (with `options`) and cards. */
async function start(
  options: {
    readonly versionColumn?: "updatedAt";
    readonly gate?: Gate;
    readonly changeLog?: false;
  } = {},
) {
  const recorded = recordingStorage(h.storage);
  const { changeLog, ...task } = options;
  const app = await createTestApp({
    services: [projectService, defineTaskService(task), cardService],
    db: h.db,
    storage: recorded.storage,
    ...(changeLog === undefined ? {} : { changeLog }),
  });
  apps.push(app as unknown as TestApp);
  return { app, reads: recorded.reads };
}

type App = Awaited<ReturnType<typeof start>>["app"];

async function connect(app: App, principal: Principal) {
  const connection = await app.connect(principal);
  return { connection, frames: receive(connection) };
}

/** The tier rooms of a row that hold sockets on the server. */
function roomsOf(app: App, service: string, id: string): string[] {
  const levels = ["Read", "Moderate", "Admin"] as const;
  return levels
    .map((level) => entityRoom(service, id, level))
    .filter((room) => (app.server.io.sockets.adapter.rooms.get(room)?.size ?? 0) > 0);
}

describe("projections in method results", () => {
  it("sends only the projection's keys, with dates as ISO strings", async () => {
    const { app } = await start();
    const task = await app.as(as(board.ada)).taskService.get({ id: board.t1 });
    expect(Object.keys(task)).toEqual(TASK_KEYS);
    expect(task.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(task).not.toHaveProperty("createdAt");
  });

  it("strips a field above the caller's level on the row", async () => {
    const { app } = await start();
    await h.prisma.task.update({ where: { id: board.t1 }, data: { notes: "secret" } });
    expect(await app.as(as(board.ada)).taskService.get({ id: board.t1 })).toMatchObject({
      notes: "secret",
    });
    expect(await app.as(as(board.cy)).taskService.get({ id: board.t1 })).not.toHaveProperty(
      "notes",
    );
    const admin = as(board.ed, { taskService: "Admin" });
    expect(await app.as(admin).taskService.get({ id: board.t1 })).toMatchObject({
      notes: "secret",
    });
  });

  it("strips each caller's copy after a share: all run, never inside it", async () => {
    const opened = deferred();
    const gate: Gate = { wait: opened.promise, runs: 0 };
    const { app } = await start({ gate });
    await h.prisma.task.update({ where: { id: board.t1 }, data: { notes: "secret" } });
    const admin = app.as(as(board.ada)).taskService.getShared({ id: board.t1 });
    const reader = app.as(as(board.cy)).taskService.getShared({ id: board.t1 });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    opened.resolve();
    const [adminCopy, readerCopy] = await Promise.all([admin, reader]);
    expect(gate.runs).toBe(1);
    expect(adminCopy.notes).toBe("secret");
    expect(readerCopy).not.toHaveProperty("notes");
    expect(Object.keys(readerCopy)).toEqual(TASK_KEYS.filter((key) => key !== "notes"));
  });

  it("projects a mapped projection from the row its select reads", async () => {
    const { app } = await start();
    expect(await app.as(as(board.cy)).cardService.get({ id: board.t1 })).toEqual({
      id: board.t1,
      title: "T1",
      label: "open: T1",
    });
  });
});

describe("qd:sub", () => {
  it("reads the row with a select of the projection's keys only", async () => {
    const { app, reads } = await start();
    const { connection } = await connect(app, as(board.ada));
    reads.length = 0;
    const reply = await sub(connection, "taskService", [board.t1]);
    expect(reply).toMatchObject({ ok: true, r: [{ ok: true, d: { id: board.t1, title: "T1" } }] });
    const fetch = reads.at(-1);
    expect(fetch?.model).toBe("task");
    expect(fetch?.args).toEqual({
      where: { id: { in: [board.t1] } },
      select: Object.fromEntries(TASK_KEYS.map((key) => [key, true])),
    });
  });

  it("authorizes, reads only the allowed rows, then joins: no room for a row it cannot read or that is missing", async () => {
    const { app, reads } = await start();
    const { connection } = await connect(app, as(board.cy));
    reads.length = 0;
    const reply = await sub(connection, "taskService", [board.t1, board.t2, "missing", board.t1]);
    expect(reply).toEqual({
      ok: true,
      r: [
        { ok: true, d: expect.objectContaining({ id: board.t1 }), rev: expect.any(Number) },
        { ok: false, e: { code: "FORBIDDEN", message: "Insufficient permissions" } },
        { ok: false, e: { code: "FORBIDDEN", message: "Insufficient permissions" } },
        { ok: true, d: expect.objectContaining({ id: board.t1 }), rev: expect.any(Number) },
      ],
    });
    // The access reads come first; the one row read asks for the allowed id only.
    const fetches = reads.filter(
      (read) => read.args.select !== undefined && "title" in (read.args.select as object),
    );
    expect(fetches).toEqual([
      { model: "task", args: expect.objectContaining({ where: { id: { in: [board.t1] } } }) },
    ]);
    expect(reads.indexOf(fetches[0] as (typeof reads)[number])).toBe(reads.length - 1);
    expect(roomsOf(app, "taskService", board.t1)).toEqual([
      entityRoom("taskService", board.t1, "Read"),
    ]);
    expect(roomsOf(app, "taskService", board.t2)).toEqual([]);
    expect(roomsOf(app, "taskService", "missing")).toEqual([]);
  });

  it("answers a missing row NOT_FOUND and joins no room, even for a service Admin", async () => {
    const { app } = await start();
    const { connection } = await connect(app, as(board.ed, { taskService: "Admin" }));
    expect(await sub(connection, "taskService", ["missing", board.t1])).toEqual({
      ok: true,
      r: [
        { ok: false, e: { code: "NOT_FOUND", message: "No such row" } },
        { ok: true, d: expect.objectContaining({ id: board.t1 }), rev: expect.any(Number) },
      ],
    });
    expect(roomsOf(app, "taskService", "missing")).toEqual([]);
    expect(roomsOf(app, "taskService", board.t1)).toEqual([
      entityRoom("taskService", board.t1, "Admin"),
    ]);
  });

  it("sends each subscriber the row for its tier, with dates as ISO strings", async () => {
    const { app } = await start();
    await h.prisma.task.update({ where: { id: board.t1 }, data: { notes: "secret" } });
    const admin = await connect(app, as(board.ada));
    const reader = await connect(app, as(board.cy));
    const forAdmin = (await sub(admin.connection, "taskService", [board.t1])) as {
      r: [{ d: Record<string, unknown>; rev: number }];
    };
    const forReader = (await sub(reader.connection, "taskService", [board.t1])) as {
      r: [{ d: Record<string, unknown>; rev: number }];
    };
    expect(Object.keys(forAdmin.r[0].d)).toEqual(TASK_KEYS);
    expect(forAdmin.r[0].d.notes).toBe("secret");
    expect(forAdmin.r[0].d.updatedAt).toEqual(expect.stringMatching(/Z$/));
    expect(Object.keys(forReader.r[0].d)).toEqual(TASK_KEYS.filter((key) => key !== "notes"));
    // A read claims the last revision rather than taking one: no flush ran in between.
    expect(forReader.r[0].rev).toBe(forAdmin.r[0].rev);
  });

  it("refuses a batch of more than 500 ids, a malformed frame, an anonymous socket and an unknown service", async () => {
    const { app } = await start();
    const { connection } = await connect(app, as(board.ada));
    const ids = Array.from({ length: 501 }, (_, index) => `t${index}`);
    expect(await sub(connection, "taskService", ids)).toEqual({
      ok: false,
      e: {
        code: "VALIDATION",
        message: "A qd:sub frame names at most 500 ids",
        data: { issues: [{ path: ["ids"], message: "A qd:sub frame names at most 500 ids" }] },
      },
    });
    expect(await sub(connection, "taskService", ids.slice(0, 500))).toMatchObject({ ok: true });
    expect(await sub(connection, "taskService", [board.t1], [1, 2])).toMatchObject({
      ok: false,
      e: { code: "VALIDATION", data: { issues: [{ path: ["revs"] }] } },
    });
    expect(await sub(connection, "nothingService", [board.t1])).toMatchObject({
      ok: false,
      e: { code: "NOT_FOUND" },
    });
    const anonymous = await app.connect(null);
    expect(await sub(anonymous, "taskService", [board.t1])).toMatchObject({
      ok: false,
      e: { code: "UNAUTHENTICATED" },
    });
  });
});

describe("frames after a flush", () => {
  it("sends a raw db.task.update as a patch of the changed fields only", async () => {
    const { app } = await start();
    const { connection, frames } = await connect(app, as(board.ada));
    await sub(connection, "taskService", [board.t1]);
    await app.as(as(board.ada)).taskService.rename({ id: board.t1, title: "Renamed" });
    await frames.settle();
    expect(frames.entity).toEqual([
      { t: "p", s: "taskService", id: board.t1, rev: expect.any(Number), d: { title: "Renamed" } },
    ]);
  });

  it("adds the version column to a patch, since tracked writes do not report it", async () => {
    const { app } = await start({ versionColumn: "updatedAt" });
    const { connection, frames } = await connect(app, as(board.ada));
    await sub(connection, "taskService", [board.t1]);
    await app.as(as(board.ada)).taskService.rename({ id: board.t1, title: "Renamed" });
    await frames.settle();
    const updated = await h.prisma.task.findUniqueOrThrow({ where: { id: board.t1 } });
    expect(frames.entity).toEqual([
      {
        t: "p",
        s: "taskService",
        id: board.t1,
        rev: expect.any(Number),
        d: { title: "Renamed", updatedAt: updated.updatedAt.toISOString() },
      },
    ]);
  });

  it("sends ten updates in one call as one frame", async () => {
    const { app } = await start();
    const { connection, frames } = await connect(app, as(board.ada));
    await sub(connection, "taskService", [board.t1]);
    await app.as(as(board.ada)).taskService.renameTenTimes({ id: board.t1 });
    await frames.settle();
    expect(frames.entity).toEqual([
      expect.objectContaining({ t: "p", id: board.t1, d: { title: "Round 10" } }),
    ]);
  });

  it("sends a row created again as u, never a patch, and a delete as r", async () => {
    const { app } = await start();
    const { connection, frames } = await connect(app, as(board.ada));
    await sub(connection, "taskService", [board.t1]);
    await app.as(as(board.ada)).taskService.recreate({ id: board.t1 });
    await app.as(as(board.ada)).taskService.touch({ id: board.t1 });
    await app.as(as(board.ada)).taskService.remove({ id: board.t1 });
    await frames.settle();
    const [created, touched, removed] = frames.entity;
    expect(created).toMatchObject({ t: "u", id: board.t1, d: { title: "Recreated" } });
    expect(Object.keys(created?.t === "u" ? (created.d as object) : {})).toEqual(TASK_KEYS);
    expect(touched).toMatchObject({ t: "u", id: board.t1 });
    expect(removed).toEqual({ t: "r", s: "taskService", id: board.t1, rev: expect.any(Number) });
    expect(frames.entity).toHaveLength(3);
    expect(
      (removed?.rev ?? 0) > (touched?.rev ?? 0) && (touched?.rev ?? 0) > (created?.rev ?? 0),
    ).toBe(true);
  });

  it("sends a change to a mapped projection as u, and the same write as p to a plain one", async () => {
    const { app } = await start();
    const { connection, frames } = await connect(app, as(board.cy));
    await sub(connection, "taskService", [board.t1]);
    await sub(connection, "cardService", [board.t1]);
    await app.as(as(board.ada)).taskService.setStatus({ id: board.t1, status: "done" });
    await frames.settle();
    expect(frames.entity).toEqual(
      expect.arrayContaining([
        { t: "p", s: "taskService", id: board.t1, rev: expect.any(Number), d: { status: "done" } },
        {
          t: "u",
          s: "cardService",
          id: board.t1,
          rev: expect.any(Number),
          d: { id: board.t1, title: "T1", label: "done: T1" },
        },
      ]),
    );
    expect(frames.entity).toHaveLength(2);
  });

  it("sends the parent row again when a child declares affects", async () => {
    const { app } = await start();
    const { connection, frames } = await connect(app, as(board.ada));
    await sub(connection, "taskService", [board.t1]);
    const child = await app.as(as(board.ada)).taskService.addChild({ parentTaskId: board.t1 });
    await frames.settle();
    expect(frames.entity).toEqual([
      expect.objectContaining({ t: "u", s: "taskService", id: board.t1 }),
    ]);
    frames.clear();
    await sub(connection, "taskService", [child]);
    await app.as(as(board.ada)).taskService.rename({ id: child, title: "Renamed child" });
    await frames.settle();
    expect(frames.entity).toEqual([
      expect.objectContaining({ t: "p", id: child, d: { title: "Renamed child" } }),
      expect.objectContaining({ t: "u", id: board.t1 }),
    ]);
  });

  it("strips frames per tier: a field above a subscriber's level never reaches it", async () => {
    const { app } = await start();
    const admin = await connect(app, as(board.ada));
    const reader = await connect(app, as(board.cy));
    await sub(admin.connection, "taskService", [board.t1]);
    await sub(reader.connection, "taskService", [board.t1]);
    await app.as(as(board.ada)).taskService.setNotes({ id: board.t1, notes: "secret" });
    await app.as(as(board.ada)).taskService.touch({ id: board.t1 });
    await Promise.all([admin.frames.settle(), reader.frames.settle()]);
    expect(admin.frames.entity).toEqual([
      expect.objectContaining({ t: "p", d: { notes: "secret" } }),
      expect.objectContaining({ t: "u", d: expect.objectContaining({ notes: "secret" }) }),
    ]);
    // The patch held only notes, so the reader gets nothing for it.
    expect(reader.frames.entity).toEqual([expect.objectContaining({ t: "u" })]);
    expect(reader.frames.entity[0]).not.toHaveProperty("d.notes");
  });

  it("stops sending after qd:unsub", async () => {
    const { app } = await start();
    const { connection, frames } = await connect(app, as(board.ada));
    await sub(connection, "taskService", [board.t1]);
    expect(
      await connection.socket.emitWithAck("qd:unsub", { s: "taskService", ids: [board.t1] }),
    ).toEqual({ ok: true });
    await app.as(as(board.ada)).taskService.rename({ id: board.t1, title: "Unseen" });
    await frames.settle();
    expect(frames.entity).toEqual([]);
    expect(roomsOf(app, "taskService", board.t1)).toEqual([]);
  });
});

describe("statements", () => {
  it("reads nothing for a flush without subscribers, and once per service with them", async () => {
    const { app, reads } = await start();
    reads.length = 0;
    await app.as(as(board.ada)).taskService.renameTenTimes({ id: board.t1 });
    expect(reads).toEqual([]);
    const { connection } = await connect(app, as(board.ada));
    await sub(connection, "taskService", [board.t1, board.t2]);
    await sub(connection, "cardService", [board.t1]);
    reads.length = 0;
    await app.as(as(board.ada)).taskService.renameTenTimes({ id: board.t1 });
    expect(reads.map((read) => read.model)).toEqual(["task", "task"]);
    reads.length = 0;
    await app.as(as(board.ada)).taskService.remove({ id: board.t2 });
    expect(reads).toEqual([]);
  });

  it("counts the statements of a subscribe batch", async () => {
    const { app, reads } = await start({ versionColumn: "updatedAt" });
    const { connection } = await connect(app, as(board.cy));
    reads.length = 0;
    const first = (await sub(connection, "taskService", [board.t1, board.t2])) as {
      r: [{ rev: number }];
    };
    // Task rows (projectId), project rows (acl, owner), memberships, then the one row read.
    expect(reads.map((read) => read.model)).toEqual(["task", "project", "projectMember", "task"]);
    reads.length = 0;
    await sub(connection, "taskService", [board.t1], [first.r[0].rev]);
    // The same access reads, then one narrow read of the version column, and no row read.
    expect(reads.map((read) => read.model)).toEqual(["task", "project", "projectMember", "task"]);
    expect(reads.at(-1)?.args.select).toEqual({ id: true, updatedAt: true });
  });
});

describe("not modified", () => {
  it("answers a held revision from the change log, until a flush touches the row", async () => {
    const { app } = await start();
    const { connection } = await connect(app, as(board.ada));
    const first = (await sub(connection, "taskService", [board.t1])) as { r: [{ rev: number }] };
    const held = first.r[0].rev;
    expect(await sub(connection, "taskService", [board.t1], [held])).toEqual({
      ok: true,
      r: [{ ok: true, nm: true, rev: expect.any(Number) }],
    });
    expect(await sub(connection, "taskService", [board.t1], [held - 60_000])).toMatchObject({
      r: [{ ok: true, d: { id: board.t1 } }],
    });
    await app.as(as(board.ada)).taskService.rename({ id: board.t1, title: "Changed" });
    expect(await sub(connection, "taskService", [board.t1], [held])).toMatchObject({
      r: [{ ok: true, d: { title: "Changed" } }],
    });
  });

  it("answers from the version column when the service declares one", async () => {
    const { app } = await start({ versionColumn: "updatedAt", changeLog: false });
    const { connection } = await connect(app, as(board.ada));
    const row = await h.prisma.task.findUniqueOrThrow({ where: { id: board.t1 } });
    const at = row.updatedAt.getTime();
    expect(await sub(connection, "taskService", [board.t1], [at])).toMatchObject({
      r: [{ ok: true, nm: true }],
    });
    expect(await sub(connection, "taskService", [board.t1], [at - 1])).toMatchObject({
      r: [{ ok: true, d: { id: board.t1 } }],
    });
  });

  it("answers a query returning one projection row nm while the row's version is current", async () => {
    const { app } = await start();
    const call = (v?: number) =>
      app.server.dispatcher.call({
        service: "taskService",
        method: "get",
        input: { id: board.t1 },
        principal: as(board.ada),
        transport: "internal",
        ...(v === undefined ? {} : { v }),
      });
    const first = await call();
    expect(first).toMatchObject({ ok: true, data: { id: board.t1 }, version: expect.any(Number) });
    const version = first.ok && first.notModified !== true ? (first.version as number) : 0;
    expect(await call(version)).toEqual({ ok: true, notModified: true, version });
    await app.as(as(board.ada)).taskService.rename({ id: board.t1, title: "Changed" });
    expect(await call(version)).toMatchObject({ ok: true, data: { title: "Changed" } });
  });

  it("gives no version without a change log or version column", async () => {
    const { app } = await start({ changeLog: false });
    const result = await app.server.dispatcher.call({
      service: "taskService",
      method: "get",
      input: { id: board.t1 },
      principal: as(board.ada),
      transport: "internal",
    });
    expect(result).toEqual({ ok: true, data: expect.objectContaining({ id: board.t1 }) });
  });
});
