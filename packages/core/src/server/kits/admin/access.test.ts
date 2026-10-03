// The admin kit's access (RFC 0003 sections 4 and 12.4), through a real
// server against PGlite and real sockets. Verify these first: every admin
// method runs under `{ service: "Admin" }`, so only a service-wide `Admin`
// grant passes. The owner of T1's project holds `Admin` on T1 itself and is
// refused all the same, as are a member, a stranger, a lower service grant
// and an anonymous caller. Then the forms an app gives in place of the
// default, and what they show.

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { admin as adminContract, defineContract } from "../../../index";
import { createTestApp, describeAccessMatrix, type TestApp } from "../../../testing/index";
import { projectMembers } from "../../access/__tests__/board";
import { projectContract, projectService, qd } from "../../emit/__tests__/live";
import { admin, anyOf, inherit, jsonAcl } from "../../index";
import { adminApp, as, serviceAdmin, taskEntity } from "./__tests__/fixture";

const kit = adminApp();

function principals() {
  const board = kit.board();
  return {
    owner: as(board.ada),
    member: as(board.bo),
    stranger: as(board.ed),
    moderator: as(board.cy, { taskService: "Moderate" }),
    serviceAdmin: serviceAdmin(board.di),
  };
}

describe("the access matrix", () => {
  it("refuses every admin method to all but a service-wide Admin, the row's owner included", async () => {
    const { app, service } = await kit.start();
    const { p1, t1 } = kit.board();
    // A write runs for real once, as the service administrator; the
    // delete comes last.
    const report = await describeAccessMatrix(app, {
      service,
      principals: principals(),
      via: "socket",
      cases: [
        { method: "adminList", input: {}, allow: ["serviceAdmin"] },
        { method: "adminGet", input: { id: t1 }, allow: ["serviceAdmin"] },
        { method: "adminMeta", input: undefined, allow: ["serviceAdmin"] },
        { method: "adminSubscribers", input: { id: t1 }, allow: ["serviceAdmin"] },
        { method: "adminReemit", input: { id: t1 }, allow: ["serviceAdmin"] },
        {
          method: "adminCreate",
          input: { data: { projectId: p1, title: "Made" } },
          allow: ["serviceAdmin"],
        },
        {
          method: "adminUpdate",
          input: { id: t1, data: { title: "Edited" } },
          allow: ["serviceAdmin"],
        },
        { method: "adminDelete", input: { id: t1 }, allow: ["serviceAdmin"] },
      ],
    });
    expect(report.cells).toHaveLength(8 * 6);
    const refusals = report.cells.filter((cell) => cell.principal !== "serviceAdmin");
    expect(new Set(refusals.map((cell) => cell.actual))).toEqual(
      new Set(["FORBIDDEN", "UNAUTHENTICATED"]),
    );
    expect(
      report.cells.filter((cell) => cell.principal === "anonymous").map((cell) => cell.actual),
    ).toEqual(Array.from({ length: 8 }, () => "UNAUTHENTICATED"));
    // Only the service administrator's writes happened.
    const titles = await kit.harness().prisma.task.findMany({
      where: { projectId: p1 },
      select: { title: true },
    });
    expect(titles.map((row) => row.title)).toEqual(["Made"]);
  });

  it("does not lean on adminBypass: a service-wide Admin passes without it, a row Admin still does not", async () => {
    const { app } = await kit.start({ adminBypass: false });
    const board = kit.board();
    const row = await app.as(serviceAdmin(board.ed)).taskService.adminGet({ id: board.t1 });
    // The grant reaches every tier: notes is Admin-only.
    expect(row).toMatchObject({ id: board.t1, notes: null });
    await expect(
      app.as(as(board.ada)).taskService.adminGet({ id: board.t1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(app.as(as(board.ada)).taskService.adminList({})).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});

describe("forms an app gives", () => {
  const strict = defineContract("strictService", {
    entity: taskEntity,
    fields: { notes: "Admin" },
    methods: {
      ...adminContract.contract({
        entity: taskEntity,
        filter: ["status", "notes"],
        sort: ["title", "notes"],
        expose: ["adminList", "adminGet", "adminUpdate", "adminMeta"],
      }),
    },
  });
  const strictService = qd.defineService(strict, {
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    methods: {
      ...admin.handlers(strict, {
        access: {
          adminList: { service: "Moderate" },
          adminUpdate: { service: "Moderate" },
          adminGet: { entry: "Admin" },
        },
      }),
    },
  });

  async function start() {
    const app = await createTestApp({
      services: [projectService, strictService],
      db: kit.harness().db,
    });
    kit.track(app as unknown as TestApp);
    return app;
  }

  it("replace the default of the methods they name, and only those", async () => {
    const app = await start();
    const board = kit.board();
    await describeAccessMatrix(app, {
      service: strictService,
      principals: {
        owner: as(board.ada),
        member: as(board.bo),
        stranger: as(board.ed),
        moderator: as(board.cy, { strictService: "Moderate" }),
        serviceAdmin: as(board.di, { strictService: "Admin" }),
      },
      cases: [
        { method: "adminList", input: {}, allow: ["moderator", "serviceAdmin"] },
        { method: "adminGet", input: { id: board.t1 }, allow: ["owner", "serviceAdmin"] },
        { method: "adminMeta", input: undefined, allow: ["serviceAdmin"] },
      ],
    });
  });

  it("show a caller only the fields its service-wide grant reaches, and refuse it the others", async () => {
    const app = await start();
    const board = kit.board();
    const moderator = app.as(as(board.cy, { strictService: "Moderate" })).strictService;
    const page = await moderator.adminList({});
    expect(page.items.length).toBeGreaterThan(0);
    expect(page.items.every((item) => !("notes" in item))).toBe(true);
    // The owner passes adminGet's row form, but holds no service grant.
    expect(await app.as(as(board.ada)).strictService.adminGet({ id: board.t1 })).not.toHaveProperty(
      "notes",
    );
    // A filter, a sort or a write on a field above the caller's level would tell what it holds.
    await expect(moderator.adminList({ filter: { notes: "secret" } })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(moderator.adminList({ sort: { field: "notes" } })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      moderator.adminUpdate({ id: board.t1, data: { notes: "x" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(
      await moderator.adminUpdate({ id: board.t1, data: { title: "Moderated" } }),
    ).toMatchObject({ title: "Moderated" });
    const administrator = app.as(as(board.ed, { strictService: "Admin" })).strictService;
    const all = await administrator.adminList({ filter: { notes: null } });
    expect(all.items[0]).toHaveProperty("notes");
  });
});

describe("a lowered form's writes", () => {
  it("leave the columns that decide access to a service-wide Admin: a member cannot make themselves the owner", async () => {
    const projectEntity = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });
    const projects = defineContract("projectService", {
      entity: projectEntity,
      methods: { ...adminContract.contract({ entity: projectEntity }) },
    });
    const lowered = qd.defineService(projects, {
      model: "project",
      access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
      methods: {
        ...admin.handlers(projects, {
          access: { adminUpdate: { entry: "Moderate" }, adminGet: { entry: "Read" } },
        }),
      },
    });
    const app = await createTestApp({ services: [lowered], db: kit.harness().db });
    kit.track(app as unknown as TestApp);
    const board = kit.board();
    const prisma = kit.harness().prisma;
    // Bo is a Moderate member of P1; Ada owns it.
    const bo = app.as(as(board.bo)).projectService;
    await expect(
      bo.adminUpdate({ id: board.p1, data: { ownerId: board.bo } }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        '"ownerId" decides who may reach rows of projectService: only a service-wide Admin may change it',
    });
    expect((await prisma.project.findUnique({ where: { id: board.p1 } }))?.ownerId).toBe(board.ada);
    // The owner holds Admin on the row, not a service-wide grant.
    await expect(
      app
        .as(as(board.ada))
        .projectService.adminUpdate({ id: board.p1, data: { ownerId: board.bo } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Other columns are the form's to write.
    expect(await bo.adminUpdate({ id: board.p1, data: { name: "Renamed" } })).toMatchObject({
      name: "Renamed",
    });
    const administrator = app.as(as(board.ed, { projectService: "Admin" })).projectService;
    expect(
      await administrator.adminUpdate({ id: board.p1, data: { ownerId: board.bo } }),
    ).toMatchObject({ ownerId: board.bo });
  });

  it("move a row only into a parent the caller has the row level on", async () => {
    const tasks = defineContract("taskService", {
      entity: taskEntity,
      methods: { ...adminContract.contract({ entity: taskEntity, expose: ["adminUpdate"] }) },
    });
    const lowered = qd.defineService(tasks, {
      model: "task",
      access: inherit({ from: projectContract, via: "projectId" }),
      methods: { ...admin.handlers(tasks, { access: { adminUpdate: { entry: "Moderate" } } }) },
    });
    const app = await createTestApp({ services: [projectService, lowered], db: kit.harness().db });
    kit.track(app as unknown as TestApp);
    const board = kit.board();
    // Bo moderates P1 and has no level on P2.
    await expect(
      app.as(as(board.bo)).taskService.adminUpdate({ id: board.t1, data: { projectId: board.p2 } }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        'Moving a row of taskService by "projectId" needs Moderate on the projectService row it moves into',
    });
    const moved = await app
      .as(serviceAdmin(board.bo))
      .taskService.adminUpdate({ id: board.t1, data: { projectId: board.p2 } });
    expect(moved).toMatchObject({ projectId: board.p2 });
  });
});
