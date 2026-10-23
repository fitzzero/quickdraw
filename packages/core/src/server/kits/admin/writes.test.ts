// The admin kit's writes and live methods (RFC 0003 section 12.4) through a
// real server against PGlite and real sockets. Writes go through the tracked
// client, so an admin update sends the same frames as any other update of
// the row (the kit sends none itself); `id`, the timestamps and hidden
// fields are never written; `adminSubscribers` counts the sockets in a row's
// tier rooms and `adminReemit` sends the row to them again. `prepare` runs
// before each write, in its transaction: the columns it returns are written
// over the caller's data, and its tracked writes (the rows a database
// cascade would delete unseen) reach the lists open on them.

import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../../../test/prisma/setup";
import type { EntityOf } from "../../../contract/infer";
import { defineContract } from "../../../index";
import { QuickdrawError } from "../../../protocol/errors";
import {
  createTestApp,
  emitWithAck,
  type RecordedFrame,
  type TestApp,
} from "../../../testing/index";
import { projectMembers } from "../../access/__tests__/board";
import { colSub } from "../../collections/__tests__/fixture";
import { qd, sub } from "../../emit/__tests__/live";
import { captureLogger, deferred } from "../../__tests__/fixtures";
import {
  admin as adminKit,
  anyOf,
  inherit,
  jsonAcl,
  type AdminOnCommitted,
  type AdminOnWrite,
  type AdminPrepare,
  type AdminPrepareCall,
} from "../../index";
import { adminApp, as, ENTITY_KEYS, serviceAdmin, taskContract } from "./__tests__/fixture";

const kit = adminApp();

type App = Awaited<ReturnType<typeof kit.start>>["app"];

/** A socket of `userId` subscribed to T1 and to P1's board scope. */
async function watcher(app: App, userId: string) {
  const board = kit.board();
  const connection = await app.connect(as(userId));
  await sub(connection, "taskService", [board.t1]);
  await colSub(connection, "board", board.p1);
  return connection;
}

/** The entity and collection frames `userId`'s sockets got, oldest first. */
function liveFrames(app: App, userId: string): Pick<RecordedFrame, "event" | "data">[] {
  return app
    .frames((frame) => frame.userId === userId && ["qd:e", "qd:c"].includes(frame.event))
    .map(({ event, data }) => ({ event, data }));
}

/** Frames with their revisions and titles blanked: what two writes of a title have in common. */
function shapesOf(frames: readonly Pick<RecordedFrame, "event" | "data">[]): string {
  return JSON.stringify(frames)
    .replace(/"rev":\d+/g, '"rev":0')
    .replace(/"title":"[^"]*"/g, '"title":""');
}

/** The service administrator's caller, untyped for the inputs the contract refuses. */
function loose(app: App) {
  return app.as(serviceAdmin(kit.board().ed)).taskService as unknown as {
    adminCreate(input: unknown): Promise<unknown>;
    adminUpdate(input: unknown): Promise<unknown>;
  };
}

describe("adminUpdate", () => {
  it("sends the same frames as an ordinary update of the row", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    await watcher(app, board.cy);
    app.frames.clear();
    await app.as(as(board.bo)).taskService.update({ id: board.t1, title: "By a member" });
    await app.frames.waitFor({ event: "qd:c", userId: board.cy });
    const ordinary = liveFrames(app, board.cy);
    app.frames.clear();
    const updated = await app
      .as(serviceAdmin(board.ed))
      .taskService.adminUpdate({ id: board.t1, data: { title: "By an admin" } });
    expect(updated).toMatchObject({ id: board.t1, title: "By an admin" });
    await app.frames.waitFor({ event: "qd:c", userId: board.cy });
    const viaAdmin = liveFrames(app, board.cy);
    expect(viaAdmin).toEqual([
      {
        event: "qd:e",
        data: {
          t: "p",
          s: "taskService",
          id: board.t1,
          rev: expect.any(Number),
          d: { title: "By an admin" },
        },
      },
      {
        event: "qd:c",
        data: {
          s: "taskService",
          c: "board",
          scope: board.p1,
          rev: expect.any(Number),
          deltas: [{ t: "patched", id: board.t1, d: { title: "By an admin" } }],
        },
      },
    ]);
    expect(shapesOf(viaAdmin)).toBe(shapesOf(ordinary));
  });

  it("writes the given fields of every type, and returns the whole row", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const row = await app.as(serviceAdmin(board.ed)).taskService.adminUpdate({
      id: board.t1,
      data: {
        status: "done",
        pinned: true,
        ordinal: 7,
        details: { size: "L", tags: ["a", "b"] },
        notes: "Seen by Admin only",
      },
    });
    expect(Object.keys(row)).toEqual(ENTITY_KEYS);
    expect(row).toMatchObject({
      status: "done",
      pinned: true,
      ordinal: 7,
      details: { size: "L", tags: ["a", "b"] },
      notes: "Seen by Admin only",
    });
    const stored = await kit.harness().prisma.task.findUniqueOrThrow({ where: { id: board.t1 } });
    expect(stored).toMatchObject({
      status: "done",
      pinned: true,
      details: { size: "L", tags: ["a", "b"] },
    });
  });

  it("never writes id, createdAt or updatedAt, and checks each value with the entity schema", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const update = loose(app).adminUpdate;
    const refused = async (data: unknown, path: readonly string[], message?: string) => {
      await expect(update({ id: board.t1, data })).rejects.toMatchObject({
        code: "VALIDATION",
        data: {
          issues: [
            expect.objectContaining({ path, ...(message === undefined ? {} : { message }) }),
          ],
        },
      });
    };
    await refused({ id: "another" }, ["data", "id"], '"id" is not writable');
    await refused(
      { createdAt: "2020-01-01T00:00:00.000Z" },
      ["data", "createdAt"],
      '"createdAt" is not writable',
    );
    await refused({ updatedAt: "2020-01-01T00:00:00.000Z" }, ["data", "updatedAt"]);
    await refused({ parentTaskId: "t0" }, ["data", "parentTaskId"]);
    await refused({ status: "nope" }, ["data", "status"]);
    await refused({ title: "" }, ["data", "title"]);
    await refused({ pinned: "yes" }, ["data", "pinned"]);
    await refused({ ordinal: 1.5 }, ["data", "ordinal"]);
    const stored = await kit.harness().prisma.task.findUniqueOrThrow({ where: { id: board.t1 } });
    expect(stored).toMatchObject({ id: board.t1, title: "T1", status: "open", pinned: false });
  });

  it("reads instead of writing when it changes nothing, and answers a missing row with NOT_FOUND", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const admin = app.as(serviceAdmin(board.ed)).taskService;
    const before = await kit.harness().prisma.task.findUniqueOrThrow({ where: { id: board.t1 } });
    expect(await admin.adminUpdate({ id: board.t1, data: {} })).toMatchObject({ title: "T1" });
    const after = await kit.harness().prisma.task.findUniqueOrThrow({ where: { id: board.t1 } });
    expect(after.updatedAt).toEqual(before.updatedAt);
    await expect(admin.adminUpdate({ id: "missing", data: { title: "x" } })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(admin.adminGet({ id: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("answers a value the database refuses with VALIDATION, and stores JSON null", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    // A whole number the entity schema takes, and an integer column cannot hold.
    await expect(
      loose(app).adminUpdate({ id: board.t1, data: { ordinal: 2 ** 40 } }),
    ).rejects.toMatchObject({ code: "VALIDATION", data: { issues: [{ path: ["data"] }] } });
    const admin = app.as(serviceAdmin(board.ed)).taskService;
    await admin.adminUpdate({ id: board.t1, data: { details: { a: 1 } } });
    expect(await admin.adminUpdate({ id: board.t1, data: { details: null } })).toMatchObject({
      details: null,
    });
  });
});

describe("adminCreate and adminDelete", () => {
  it("create a row from its data and delete it, and the board sees both", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    await watcher(app, board.cy);
    const admin = app.as(serviceAdmin(board.ed)).taskService;
    const created = await admin.adminCreate({
      data: { projectId: board.p1, title: "Made", status: "doing", pinned: true, details: [1, 2] },
    });
    expect(created).toMatchObject({
      projectId: board.p1,
      title: "Made",
      status: "doing",
      pinned: true,
      details: [1, 2],
      ordinal: 0,
    });
    const added = await app.frames.waitFor({ event: "qd:c", userId: board.cy });
    expect(added.data.deltas).toEqual([
      expect.objectContaining({ t: "added", item: expect.objectContaining({ id: created.id }) }),
    ]);
    app.frames.clear();
    expect(await admin.adminDelete({ id: created.id })).toBeNull();
    const removed = await app.frames.waitFor({ event: "qd:c", userId: board.cy });
    expect(removed.data.deltas).toEqual([{ t: "removed", id: created.id }]);
    await expect(admin.adminDelete({ id: created.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("refuses an id or a timestamp, and answers a row the database cannot make with VALIDATION", async () => {
    const { app } = await kit.start();
    const create = loose(app).adminCreate;
    await expect(
      create({ data: { id: "mine", projectId: kit.board().p1, title: "Mine" } }),
    ).rejects.toMatchObject({ code: "VALIDATION", data: { issues: [{ path: ["data", "id"] }] } });
    await expect(create({ data: { title: "Nowhere" } })).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["data"] }] },
    });
    expect(await kit.harness().prisma.task.count()).toBe(2);
  });
});

describe("editable (finding R1.4)", () => {
  it("writes only the fields it names; adminMeta and both writes say the rest are not editable", async () => {
    const { app } = await kit.start({ editable: ["title", "status"] });
    const board = kit.board();
    const administrator = app.as(serviceAdmin(board.ed)).taskService;
    const editable = Object.fromEntries(
      (await administrator.adminMeta()).fields.map((field) => [field.name, field.editable]),
    );
    expect(editable).toEqual({
      id: false,
      createdAt: false,
      updatedAt: false,
      projectId: false,
      title: true,
      status: true,
      ordinal: false,
      pinned: false,
      details: false,
      assigneeId: false,
      notes: false,
    });
    await expect(
      administrator.adminUpdate({ id: board.t1, data: { title: "Kept", ordinal: 5 } }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["data", "ordinal"], message: '"ordinal" is not editable' }] },
    });
    await expect(
      administrator.adminCreate({ data: { projectId: board.p1, title: "New" } }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["data", "projectId"], message: '"projectId" is not editable' }] },
    });
    await expect(
      loose(app).adminUpdate({ id: board.t1, data: { updatedAt: new Date().toISOString() } }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    expect(
      await administrator.adminUpdate({ id: board.t1, data: { title: "Renamed", status: "done" } }),
    ).toMatchObject({ id: board.t1, title: "Renamed", status: "done", ordinal: 0 });
    expect(
      await kit.harness().prisma.task.findUniqueOrThrow({ where: { id: board.t1 } }),
    ).toMatchObject({ title: "Renamed", status: "done", ordinal: 0 });
  });
});

describe("adminSubscribers and adminReemit", () => {
  it("count the sockets in each of the row's tier rooms", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    await watcher(app, board.cy);
    await watcher(app, board.ada);
    const admin = app.as(serviceAdmin(board.ed)).taskService;
    expect(await admin.adminSubscribers({ id: board.t1 })).toEqual({
      id: board.t1,
      count: 2,
      levels: { Read: 1, Moderate: 0, Admin: 1 },
      complete: true,
    });
    expect(await admin.adminSubscribers({ id: board.t2 })).toEqual({
      id: board.t2,
      count: 0,
      levels: { Read: 0, Moderate: 0, Admin: 0 },
      complete: true,
    });
  });

  it("re-sends the row as it is now to its subscribers, each at its tier", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    // A change the tracked client did not see: no frame went out for it.
    await kit.harness().prisma.task.update({
      where: { id: board.t1 },
      data: { title: "Changed behind the server", notes: "Admin only" },
    });
    await watcher(app, board.cy);
    await watcher(app, board.ada);
    app.frames.clear();
    const admin = app.as(serviceAdmin(board.ed)).taskService;
    expect(await admin.adminReemit({ id: board.t1 })).toMatchObject({ count: 2 });
    const reader = await app.frames.waitFor({ event: "qd:e", userId: board.cy });
    expect(reader.data).toMatchObject({
      t: "u",
      id: board.t1,
      d: { title: "Changed behind the server" },
    });
    expect(reader.data.t === "u" ? reader.data.d : {}).not.toHaveProperty("notes");
    const owner = await app.frames.waitFor({ event: "qd:e", userId: board.ada });
    expect(owner.data).toMatchObject({ t: "u", d: { notes: "Admin only" } });
    await expect(admin.adminReemit({ id: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("onWrite", () => {
  it("hears each write with the row before and after, every field, in one transaction with it", async () => {
    const heard: { method: string; id: string; before?: unknown; after: unknown }[] = [];
    const { app } = await kit.start({
      onWrite: async (write, ctx, db) => {
        heard.push(write);
        expect(ctx.principal?.userId).toBe(kit.board().ed);
        // The hook's own writes go through the transaction's client and commit with the edit.
        if (write.method === "adminCreate") {
          await db.task.update({ where: { id: write.id }, data: { pinned: true } });
        }
      },
    });
    const board = kit.board();
    const edits = app.as(serviceAdmin(board.ed)).taskService;
    const created = await edits.adminCreate({
      data: {
        projectId: board.p1,
        title: "New",
        status: "open",
        ordinal: 5,
        pinned: false,
        details: {},
      },
    });
    await edits.adminUpdate({ id: created.id, data: { title: "Renamed" } });
    await edits.adminDelete({ id: created.id });
    expect(heard.map(({ method, id }) => [method, id])).toEqual([
      ["adminCreate", created.id],
      ["adminUpdate", created.id],
      ["adminDelete", created.id],
    ]);
    const [create, update, remove] = heard;
    expect(create).not.toHaveProperty("before");
    expect(create?.after).toMatchObject({ id: created.id, title: "New", pinned: false });
    // Every field, notes (an Admin tier) and dates included, as the entity's schema has them.
    expect(Object.keys(create?.after ?? {}).sort()).toEqual([...ENTITY_KEYS].sort());
    expect(update?.before).toMatchObject({ title: "New", pinned: true });
    expect(update?.after).toMatchObject({ title: "Renamed" });
    expect(remove).toMatchObject({ before: { title: "Renamed" }, after: null });
  });

  it("undoes the write and fails the call when it throws", async () => {
    const { app } = await kit.start({
      onWrite: () => {
        throw new QuickdrawError("CONFLICT", "Not now");
      },
    });
    const board = kit.board();
    await expect(
      app
        .as(serviceAdmin(board.ed))
        .taskService.adminUpdate({ id: board.t1, data: { title: "Never" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    const row = await kit.harness().prisma.task.findUniqueOrThrow({ where: { id: board.t1 } });
    expect(row.title).toBe("T1");
  });

  it("is refused when it is not a function", () => {
    expect(() =>
      adminKit.handlers(taskContract, { onWrite: "later" as unknown as AdminOnWrite }),
    ).toThrow("admin.handlers: onWrite must be a function of (write, ctx, db)");
  });
});

describe("onCommitted (finding F6.5)", () => {
  it("hears each write once it committed, in a unit of its own, without holding the reply", async () => {
    const heard: { method: string; id: string; before?: unknown; after: unknown }[] = [];
    const gate = deferred<void>();
    const { app } = await kit.start({
      onCommitted: async (write, ctx) => {
        // The edit is durable when it runs: another client reads it.
        const stored = await kit.harness().prisma.task.findUnique({ where: { id: write.id } });
        heard.push({ ...write, after: write.after === null ? null : stored?.title });
        expect(ctx.principal?.userId).toBe(kit.board().ed);
        if (write.method === "adminUpdate") {
          await gate.promise;
          // Its tracked writes flush on their own, as a detached qd.run's do.
          await kit.harness().db.task.update({ where: { id: write.id }, data: { pinned: true } });
        }
      },
    });
    const board = kit.board();
    const edits = app.as(serviceAdmin(board.ed));
    const created = await edits.taskService.adminCreate({
      data: { projectId: board.p1, title: "New", status: "open", ordinal: 5, pinned: false },
    });
    await vi.waitFor(() => {
      expect(heard).toHaveLength(1);
    });
    const connection = await watcher(app, board.cy);
    await sub(connection, "taskService", [created.id]);
    app.frames.clear();
    // The reply does not wait for the hook, which is still held at the gate.
    expect(
      await edits.taskService.adminUpdate({ id: created.id, data: { title: "Renamed" } }),
    ).toMatchObject({ title: "Renamed" });
    await vi.waitFor(() => {
      expect(heard).toHaveLength(2);
    });
    gate.resolve();
    await app.frames.waitFor(
      (frame) =>
        frame.event === "qd:e" &&
        frame.userId === board.cy &&
        JSON.stringify(frame.data).includes('"pinned":true'),
    );
    await edits.taskService.adminDelete({ id: created.id });
    await vi.waitFor(() => {
      expect(heard).toHaveLength(3);
    });
    expect(heard).toEqual([
      { method: "adminCreate", id: created.id, after: "New" },
      {
        method: "adminUpdate",
        id: created.id,
        before: expect.objectContaining({ title: "New" }),
        after: "Renamed",
      },
      {
        method: "adminDelete",
        id: created.id,
        before: expect.objectContaining({ title: "Renamed" }),
        after: null,
      },
    ]);
  });

  it("is logged when it throws, the write standing, and runs for no write that rolled back", async () => {
    const logger = captureLogger();
    let committed = 0;
    const { app } = await kit.start({
      logger,
      onWrite: (write) => {
        if (write.after !== null && (write.after as { title?: string }).title === "Refused") {
          throw new QuickdrawError("CONFLICT", "Not this one");
        }
      },
      onCommitted: () => {
        committed += 1;
        throw new Error("the game is not running");
      },
    });
    const board = kit.board();
    const edits = app.as(serviceAdmin(board.ed)).taskService;
    expect(await edits.adminUpdate({ id: board.t1, data: { title: "Kept" } })).toMatchObject({
      title: "Kept",
    });
    await vi.waitFor(() => {
      expect(logger.at("error").map((entry) => entry.message)).toContain(
        "The admin kit's onCommitted failed; the write stands",
      );
    });
    await expect(
      edits.adminUpdate({ id: board.t1, data: { title: "Refused" } }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(committed).toBe(1);
    const row = await kit.harness().prisma.task.findUniqueOrThrow({ where: { id: board.t1 } });
    expect(row.title).toBe("Kept");
  });

  it("is refused when it is not a function", () => {
    expect(() =>
      adminKit.handlers(taskContract, { onCommitted: 1 as unknown as AdminOnCommitted }),
    ).toThrow("admin.handlers: onCommitted must be a function of (write, ctx)");
  });
});

type TaskRow = EntityOf<typeof taskContract>;

/** A column the server computes from what the caller sent: a short content hash. */
function digest(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

describe("prepare", () => {
  it("adminCreate writes the columns it returns over the caller's data, one the caller may not write included", async () => {
    const calls: AdminPrepareCall<TaskRow>[] = [];
    const { app } = await kit.start({
      editable: ["projectId", "title", "status"],
      prepare: (call) => {
        calls.push(call);
        expect(Object.isFrozen(call)).toBe(true);
        if (call.method !== "adminCreate") {
          return undefined;
        }
        expect(Object.isFrozen(call.data)).toBe(true);
        // notes is not editable, and status the caller's: the server sets both; undefined keeps a value
        return { notes: digest(call.data.title ?? ""), status: "doing", title: undefined };
      },
    });
    const board = kit.board();
    const admin = app.as(serviceAdmin(board.ed)).taskService;
    const created = await admin.adminCreate({
      data: { projectId: board.p1, title: "Made", status: "open" },
    });
    expect(calls).toEqual([
      { method: "adminCreate", data: { projectId: board.p1, title: "Made", status: "open" } },
    ]);
    expect(created).toMatchObject({ title: "Made", status: "doing", notes: digest("Made") });
    expect(
      await kit.harness().prisma.task.findUniqueOrThrow({ where: { id: created.id } }),
    ).toMatchObject({ title: "Made", status: "doing", notes: digest("Made") });
    // The caller still may not send it.
    await expect(
      loose(app).adminCreate({ data: { projectId: board.p1, title: "Mine", notes: "x" } }),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["data", "notes"], message: '"notes" is not editable' }] },
    });
    expect(calls).toHaveLength(1);
  });

  it("adminUpdate hears the row before it, and writes its columns, a hidden field's included", async () => {
    const calls: AdminPrepareCall<TaskRow>[] = [];
    const { app } = await kit.start({
      hiddenFields: ["notes"],
      prepare: (call) => {
        calls.push(call);
        return call.method === "adminUpdate"
          ? { notes: `${call.before.title} -> ${call.data.title ?? call.before.title}` }
          : undefined;
      },
    });
    const board = kit.board();
    const admin = app.as(serviceAdmin(board.ed)).taskService;
    const updated = await admin.adminUpdate({ id: board.t1, data: { title: "Renamed" } });
    expect(updated).toMatchObject({ id: board.t1, title: "Renamed" });
    // A hidden field is written, never returned.
    expect(updated).not.toHaveProperty("notes");
    expect(calls).toEqual([
      {
        method: "adminUpdate",
        id: board.t1,
        data: { title: "Renamed" },
        before: expect.objectContaining({ id: board.t1, title: "T1", notes: null }),
      },
    ]);
    // The row before is every field, as onWrite hears it.
    const [call] = calls;
    expect(Object.keys(call?.method === "adminUpdate" ? call.before : {}).sort()).toEqual(
      [...ENTITY_KEYS].sort(),
    );
    expect(
      await kit.harness().prisma.task.findUniqueOrThrow({ where: { id: board.t1 } }),
    ).toMatchObject({ title: "Renamed", notes: "T1 -> Renamed" });
    // An update that changes nothing writes nothing and runs no hook; a missing row is NOT_FOUND first.
    expect(await admin.adminUpdate({ id: board.t1, data: {} })).toMatchObject({ title: "Renamed" });
    await expect(admin.adminUpdate({ id: "missing", data: { title: "x" } })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(calls).toHaveLength(1);
  });

  it("refuses an id, a timestamp or a nested write it returns, and anything but column values", async () => {
    let returned: unknown;
    const { app } = await kit.start({ prepare: () => returned as never });
    const board = kit.board();
    const update = () =>
      app
        .as(serviceAdmin(board.ed))
        .taskService.adminUpdate({ id: board.t1, data: { title: "Renamed" } });
    const refused = async (value: unknown, path: readonly string[]) => {
      returned = value;
      await expect(update()).rejects.toMatchObject({
        code: "VALIDATION",
        message: "The admin kit's prepare for taskService returned data the kit does not write",
        data: { issues: [expect.objectContaining({ path })] },
      });
    };
    await refused({ id: "another" }, ["data", "id"]);
    await refused({ createdAt: new Date() }, ["data", "createdAt"]);
    await refused({ updatedAt: new Date() }, ["data", "updatedAt"]);
    await refused({ project: { connect: { id: board.p2 } } }, ["data", "project"]);
    for (const value of ["not columns", [{ title: "x" }], null]) {
      returned = value;
      await expect(update()).rejects.toMatchObject({ code: "INTERNAL" });
    }
    const { prisma } = kit.harness();
    expect(await prisma.task.findUniqueOrThrow({ where: { id: board.t1 } })).toMatchObject({
      id: board.t1,
      title: "T1",
      projectId: board.p1,
    });
    // A key given undefined sets nothing.
    returned = { id: undefined, notes: "Kept" };
    expect(await update()).toMatchObject({ id: board.t1, title: "Renamed", notes: "Kept" });
  });

  it("is refused when it is not a function", () => {
    expect(() =>
      adminKit.handlers(taskContract, { prepare: "later" as unknown as AdminPrepare }),
    ).toThrow("admin.handlers: prepare must be a function of (call, ctx, db)");
  });
});

const projectRow = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });

/** Projects an admin deletes, under the live-data tests' project policy. */
const adminProjects = defineContract("projectService", {
  entity: projectRow,
  methods: { ...adminKit.contract({ entity: projectRow, expose: ["adminDelete"] }) },
});

/** Each user's own list of the tasks assigned to them: a self scope, which no project anchors. */
const assignedTasks = defineContract("taskService", {
  entity: z.object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    assigneeId: z.string().nullable(),
  }),
  collections: { mine: { scope: "assigneeId", item: "entity", order: [["id", "asc"]] } },
});

type ProjectPrepare = AdminPrepare<z.output<typeof projectRow>, PrismaClient>;

/**
 * An app whose project admins delete projects, with `prepare` when given;
 * T1 is assigned to cy, whose own list holds it. Deleting P1 deletes T1 by
 * the database's cascade, which no tracked write sees.
 */
async function cascadeApp(prepare?: ProjectPrepare) {
  const projectService = qd.defineService(adminProjects, {
    model: "project",
    access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
    methods: { ...adminKit.handlers(adminProjects, prepare === undefined ? {} : { prepare }) },
  });
  const taskService = qd.defineService(assignedTasks, {
    model: "task",
    access: inherit({ from: adminProjects, via: "projectId" }),
    collections: { mine: { scopeAccess: "self" } },
    methods: {},
  });
  const board = kit.board();
  const { prisma, db } = kit.harness();
  await prisma.task.update({ where: { id: board.t1 }, data: { assigneeId: board.cy } });
  const app = await createTestApp({ services: [projectService, taskService], db });
  kit.track(app as unknown as TestApp);
  const connection = await app.connect(as(board.cy));
  expect(
    await emitWithAck(connection.socket, "qd:col:sub", {
      s: "taskService",
      c: "mine",
      scope: board.cy,
    }),
  ).toMatchObject({ ok: true, items: [{ id: board.t1 }] });
  app.frames.clear();
  return {
    remove: (id: string) =>
      app.as(as(board.ed, { projectService: "Admin" })).projectService.adminDelete({ id }),
    /** The list frames cy got, once every frame sent before now has arrived. */
    listFrames: async () => {
      await emitWithAck(connection.socket, "qd:col:unsub", { s: "none", c: "none", scope: "none" });
      return app
        .frames((frame) => frame.userId === board.cy && frame.event === "qd:c")
        .map(({ data }) => data);
    },
  };
}

describe("prepare before adminDelete", () => {
  it("is needed: a database cascade alone leaves an open list of the rows it deleted stale", async () => {
    const board = kit.board();
    const { remove, listFrames } = await cascadeApp();
    expect(await remove(board.p1)).toBeNull();
    expect(await kit.harness().prisma.task.count({ where: { id: board.t1 } })).toBe(0);
    expect(await listFrames()).toEqual([]);
  });

  it("records the dependents it deletes through db, so the list gets their removal", async () => {
    const board = kit.board();
    const calls: AdminPrepareCall<z.output<typeof projectRow>>[] = [];
    const { remove, listFrames } = await cascadeApp(async (call, _ctx, db) => {
      calls.push(call);
      if (call.method === "adminDelete") {
        await db.task.deleteMany({ where: { projectId: call.id } });
      }
      // What it returns before a delete is ignored, an id included.
      return { id: "ignored" };
    });
    expect(await remove(board.p1)).toBeNull();
    expect(calls).toEqual([
      {
        method: "adminDelete",
        id: board.p1,
        before: { id: board.p1, name: "P1", ownerId: board.ada },
      },
    ]);
    expect(await listFrames()).toEqual([
      {
        s: "taskService",
        c: "mine",
        scope: board.cy,
        rev: expect.any(Number),
        deltas: [{ t: "removed", id: board.t1 }],
      },
    ]);
    const { prisma } = kit.harness();
    expect(await prisma.project.count({ where: { id: board.p1 } })).toBe(0);
  });

  it("undoes its writes and the delete, and tells no list, when it throws", async () => {
    const board = kit.board();
    const { remove, listFrames } = await cascadeApp(async (call, _ctx, db) => {
      if (call.method === "adminDelete") {
        await db.task.deleteMany({ where: { projectId: call.id } });
      }
      throw new QuickdrawError("CONFLICT", "Not now");
    });
    await expect(remove(board.p1)).rejects.toMatchObject({ code: "CONFLICT" });
    const { prisma } = kit.harness();
    expect(await prisma.project.count({ where: { id: board.p1 } })).toBe(1);
    expect(await prisma.task.count({ where: { id: board.t1 } })).toBe(1);
    expect(await listFrames()).toEqual([]);
  });
});
