// The read/write kit's writes (RFC 0003 section 12.1) through a real server
// against PGlite and real sockets: each write goes through the tracked
// client, so its frames come from the flush (the kit sends none itself):
// `create` gives `added`, `update` a patch, `delete` `removed`, and a bulk
// write past the scope's threshold one `reset`. Missing rows and unique
// violations are `NOT_FOUND` and `CONFLICT`.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../../../test/prisma/setup";
import { defineContract, QuickdrawError } from "../../../index";
import { createTestApp, type TestApp } from "../../../testing/index";
import { projectMembers } from "../../access/__tests__/board";
import { colSub, receiveScopes } from "../../collections/__tests__/fixture";
import { projectContract, projectService, qd, receive, sub } from "../../emit/__tests__/live";
import { anyOf, crud, inherit, jsonAcl } from "../../index";
import { requireRow } from "../guards";
import { addTasks, as, ENTITY_KEYS, kitApp, taskContract, taskEntity } from "./__tests__/fixture";
import { ORDINAL_STEP } from "./ordinal";

const kit = kitApp();

type App = Awaited<ReturnType<typeof kit.start>>["app"];

/** A socket of `userId` in the board scope of P1 and in T1's entity room. */
async function watcher(app: App, userId: string) {
  const board = kit.board();
  const connection = await app.connect(as(userId));
  const scopes = receiveScopes(connection);
  const entities = receive(connection);
  await colSub(connection, "board", board.p1);
  await sub(connection, "taskService", [board.t1]);
  return { connection, scopes, entities };
}

describe("writes and their frames", () => {
  it("creates with prepare, and the board gets the new row as added", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    await addTasks(kit.harness().prisma, board.p1, [3000]);
    const { scopes } = await watcher(app, board.cy);
    const created = await app.as(as(board.bo)).taskService.create({
      projectId: board.p1,
      title: "Made",
    });
    // prepare assigned the creator and put the row last.
    expect(created).toMatchObject({
      projectId: board.p1,
      title: "Made",
      assigneeId: board.bo,
      ordinal: 3000 + ORDINAL_STEP,
    });
    expect(Object.keys(created)).toEqual(ENTITY_KEYS.filter((key) => key !== "notes"));
    await scopes.settle();
    expect(scopes.frames.map((frame) => frame.deltas)).toEqual([
      [
        {
          t: "added",
          item: {
            id: created.id,
            projectId: board.p1,
            title: "Made",
            status: "open",
            ordinal: 3000 + ORDINAL_STEP,
          },
          index: [created.id, expect.any(Number), "open", 3000 + ORDINAL_STEP],
        },
      ],
    ]);
  });

  it("updates with a patch to the row's subscribers and the board", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const { scopes, entities } = await watcher(app, board.cy);
    const updated = await app
      .as(as(board.bo))
      .taskService.update({ id: board.t1, title: "Renamed", status: "doing" });
    expect(updated).toMatchObject({ id: board.t1, title: "Renamed", status: "doing" });
    await scopes.settle();
    await entities.settle();
    expect(entities.entity).toEqual([
      {
        t: "p",
        s: "taskService",
        id: board.t1,
        rev: expect.any(Number),
        d: { title: "Renamed", status: "doing" },
      },
    ]);
    expect(scopes.frames.flatMap((frame) => frame.deltas)).toEqual([
      { t: "patched", id: board.t1, d: { title: "Renamed", status: "doing" } },
    ]);
  });

  it("deletes, and the row's subscribers and the board see it removed", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const { scopes, entities } = await watcher(app, board.cy);
    expect(await app.as(as(board.bo)).taskService.delete({ id: board.t1 })).toBeNull();
    await scopes.settle();
    await entities.settle();
    expect(entities.entity).toEqual([
      { t: "r", s: "taskService", id: board.t1, rev: expect.any(Number) },
    ]);
    expect(scopes.frames.flatMap((frame) => frame.deltas)).toEqual([
      { t: "removed", id: board.t1 },
    ]);
    expect(await kit.harness().prisma.task.count({ where: { id: board.t1 } })).toBe(0);
  });

  it("reads instead of writing an update that changes nothing", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const { scopes, entities } = await watcher(app, board.cy);
    const before = await kit.harness().prisma.task.findUniqueOrThrow({ where: { id: board.t1 } });
    expect(await app.as(as(board.bo)).taskService.update({ id: board.t1 })).toMatchObject({
      id: board.t1,
      title: "T1",
    });
    await scopes.settle();
    await entities.settle();
    expect(entities.entity).toEqual([]);
    expect(scopes.frames).toEqual([]);
    const after = await kit.harness().prisma.task.findUniqueOrThrow({ where: { id: board.t1 } });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("sends a bulk write's rows as deltas, and one reset past the scope's threshold", async () => {
    const small = await kit.start();
    const board = kit.board();
    const ids = await addTasks(kit.harness().prisma, board.p1, [1, 2]);
    const { scopes } = await watcher(small.app, board.cy);
    expect(
      await small.app.as(as(board.bo)).taskService.bulkUpdate({ ids, data: { status: "done" } }),
    ).toEqual({ count: 2 });
    await scopes.settle();
    expect(scopes.frames.flatMap((frame) => frame.deltas)).toEqual(
      ids.map((id) => ({ t: "patched", id, d: { status: "done" } })),
    );
    const strict = await kit.start({ bulkThreshold: 1 });
    const reset = await watcher(strict.app, board.cy);
    expect(
      await strict.app.as(as(board.bo)).taskService.bulkUpdate({ ids, data: { status: "open" } }),
    ).toEqual({ count: 2 });
    expect(await strict.app.as(as(board.bo)).taskService.bulkDelete({ ids })).toEqual({ count: 2 });
    await reset.scopes.settle();
    expect(reset.scopes.frames.map((frame) => frame.deltas)).toEqual([
      [{ t: "reset" }],
      [{ t: "reset" }],
    ]);
  });
});

describe("refusals", () => {
  it("answers a missing row with NOT_FOUND, and FORBIDDEN where the entry check refuses first", async () => {
    const { app } = await kit.start();
    const admin = app.as(as(kit.board().ed, { taskService: "Admin" })).taskService;
    await expect(admin.update({ id: "missing", title: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(admin.delete({ id: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(admin.get({ id: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      app.as(as(kit.board().bo)).taskService.update({ id: "missing", title: "x" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("answers a unique violation with CONFLICT", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    await expect(
      app.as(as(board.ada)).taskService.create({ id: board.t1, projectId: board.p1, title: "Dup" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("checks an update's patch with the app's schema, and adds id", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const owner = app.as(as(board.ada)).taskService as unknown as {
      update(input: unknown): Promise<unknown>;
      bulkUpdate(input: unknown): Promise<unknown>;
    };
    await expect(owner.update({ id: board.t1, title: "" })).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["title"] }] },
    });
    await expect(owner.update({ title: "No id" })).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["id"] }] },
    });
    await expect(
      owner.bulkUpdate({ ids: Array.from({ length: 201 }, (_, index) => `t${index}`), data: {} }),
    ).rejects.toMatchObject({ code: "VALIDATION", data: { issues: [{ path: ["ids"] }] } });
  });
});

describe("development checks", () => {
  it("check the app's prepare, which the kit's quiet handler calls", async () => {
    const service = qd.defineService(taskContract, {
      model: "task",
      access: inherit({ from: projectContract, via: "projectId" }),
      collections: { board: { anchor: projectContract } },
      methods: {
        ...crud.handlers(taskContract, {
          access: {
            get: { entry: "Read" },
            getMany: "authenticated",
            list: "authenticated",
            create: { scope: "Moderate", of: projectContract, id: "projectId" },
            update: { entry: "Moderate" },
            delete: { entry: "Moderate" },
            reorder: { entry: "Moderate" },
            bulkUpdate: "authenticated",
            bulkDelete: "authenticated",
          },
          // Reads every task of the project to number the new one: an unbounded read.
          prepare: async (input, _ctx, db) => ({
            ...input,
            ordinal: (
              await (db as PrismaClient).task.findMany({ where: { projectId: input.projectId } })
            ).length,
          }),
        }),
      },
    });
    const app = await createTestApp({
      services: [projectService, service],
      db: kit.harness().db,
      strictWarnings: true,
    });
    kit.track(app as unknown as TestApp);
    const board = kit.board();
    const error: unknown = await app
      .as(as(board.bo))
      .taskService.create({ projectId: board.p1, title: "Numbered" })
      .catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      code: "INTERNAL",
      cause: { warning: { kind: "unbounded-read", service: "taskService", method: "create" } },
    });
    // The kit's own reads stay quiet: a list reads by the caller's access, unchecked.
    expect(
      await app.as(as(board.bo)).taskService.list({ filter: { projectId: board.p1 } }),
    ).toMatchObject({ items: expect.any(Array) });
  });
});

describe("columns that decide access", () => {
  it("move a row only into a parent the caller has the method's row level on", async () => {
    const patch = z.object({ title: z.string(), projectId: z.string() }).partial();
    const movable = defineContract("taskService", {
      entity: taskEntity,
      methods: {
        ...crud.contract({
          entity: taskEntity,
          update: { input: patch },
          bulkUpdate: { input: patch },
        }),
      },
    });
    const service = qd.defineService(movable, {
      model: "task",
      access: inherit({ from: projectContract, via: "projectId" }),
      methods: {
        ...crud.handlers(movable, {
          access: { update: { entry: "Moderate" }, bulkUpdate: "authenticated" },
        }),
      },
    });
    const app = await createTestApp({ services: [projectService, service], db: kit.harness().db });
    kit.track(app as unknown as TestApp);
    const board = kit.board();
    const prisma = kit.harness().prisma;
    // Bo moderates P1 and P3, and has no level on P2 (Ed's).
    const p3 = await prisma.project.create({ data: { name: "P3", ownerId: board.ada } });
    await prisma.projectMember.create({
      data: { projectId: p3.id, userId: board.bo, role: "Moderate" },
    });
    const bo = app.as(as(board.bo)).taskService;
    await expect(bo.update({ id: board.t1, projectId: board.p2 })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        'Moving a row of taskService by "projectId" needs Moderate on the projectService row it moves into',
    });
    await expect(
      bo.bulkUpdate({ ids: [board.t1], data: { projectId: board.p2 } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await prisma.task.findUnique({ where: { id: board.t1 } }))?.projectId).toBe(board.p1);
    expect(await bo.update({ id: board.t1, projectId: p3.id })).toMatchObject({ projectId: p3.id });
    expect(await bo.bulkUpdate({ ids: [board.t1], data: { projectId: board.p1 } })).toEqual({
      count: 1,
    });
    // Ada holds Admin on P1's tasks and nothing on P2; a service-wide Admin moves anywhere.
    await expect(
      app.as(as(board.ada)).taskService.update({ id: board.t1, projectId: board.p2 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const administrator = app.as(as(board.cy, { taskService: "Admin" })).taskService;
    expect(await administrator.update({ id: board.t1, projectId: board.p2 })).toMatchObject({
      projectId: board.p2,
    });
  });

  it("leave an owner or access list column to a service-wide Admin", async () => {
    const projectEntity = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });
    const patch = z.object({ name: z.string(), ownerId: z.string() }).partial();
    const projects = defineContract("projectService", {
      entity: projectEntity,
      methods: {
        ...crud.contract({
          entity: projectEntity,
          update: { input: patch },
          bulkUpdate: { input: patch },
        }),
      },
    });
    const service = qd.defineService(projects, {
      model: "project",
      access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
      methods: {
        ...crud.handlers(projects, {
          access: { update: { entry: "Moderate" }, bulkUpdate: "authenticated" },
        }),
      },
    });
    const app = await createTestApp({ services: [service], db: kit.harness().db });
    kit.track(app as unknown as TestApp);
    const board = kit.board();
    // Ada owns P1: Admin on the row, but no service-wide grant.
    for (const userId of [board.bo, board.ada]) {
      const caller = app.as(as(userId)).projectService;
      await expect(caller.update({ id: board.p1, ownerId: board.bo })).rejects.toMatchObject({
        code: "FORBIDDEN",
        message:
          '"ownerId" decides who may reach rows of projectService: only a service-wide Admin may change it',
      });
      await expect(
        caller.bulkUpdate({ ids: [board.p1], data: { ownerId: board.bo } }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(
      await app.as(as(board.bo)).projectService.update({ id: board.p1, name: "N" }),
    ).toMatchObject({
      name: "N",
    });
    const administrator = app.as(as(board.ed, { projectService: "Admin" })).projectService;
    expect(await administrator.update({ id: board.p1, ownerId: board.bo })).toMatchObject({
      ownerId: board.bo,
    });
  });
});

describe("requireRow", () => {
  it("returns the row, or throws NOT_FOUND", () => {
    const row = { id: "t1" };
    expect(requireRow(row)).toBe(row);
    expect(() => requireRow(null, "No such task")).toThrow(
      new QuickdrawError("NOT_FOUND", "No such task"),
    );
    expect(() => requireRow(undefined)).toThrow(QuickdrawError);
  });
});
