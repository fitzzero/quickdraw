// The admin kit's writes and live methods (RFC 0003 section 12.4) through a
// real server against PGlite and real sockets. Writes go through the tracked
// client, so an admin update sends the same frames as any other update of
// the row (the kit sends none itself); `id`, the timestamps and hidden
// fields are never written; `adminSubscribers` counts the sockets in a row's
// tier rooms and `adminReemit` sends the row to them again.

import { describe, expect, it } from "vitest";
import type { RecordedFrame } from "../../../testing/index";
import { colSub } from "../../collections/__tests__/fixture";
import { sub } from "../../emit/__tests__/live";
import { adminApp, as, ENTITY_KEYS, serviceAdmin } from "./__tests__/fixture";

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
