// Kit writes hold column values only (the 5.1 audit's CRUD-5 and DATA-2): a
// key that is a relation of the model (one a projection selects with a
// nested select), or a value that is a Prisma nested write, is refused with
// `VALIDATION` in every environment and for every caller, a service-wide
// Admin included. Nested writes are not tracked and passed the name-only
// column guard: `{ project: { update: { ownerId } } }` made a Moderate member
// the project's owner, and `{ subtasks: { connect } }` re-parented another
// tenant's task. A schema that keeps undeclared keys (`z.looseObject`, and
// ArkType by default) let them through.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -
//   T1 in P1, T2 in P2

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { crud as contractCrud, defineContract } from "../../../index";
import { createTestApp, type TestApp } from "../../../testing/index";
import { projectMembers } from "../../access/__tests__/board";
import { projectContract, projectService, qd } from "../../emit/__tests__/live";
import { anyOf, crud, inherit, jsonAcl } from "../../index";
import { as, ENTITY_KEYS, kitApp, taskEntity } from "./__tests__/fixture";

const kit = kitApp();

const tasks = defineContract("taskService", {
  entity: taskEntity,
  methods: {
    ...contractCrud.contract({
      entity: taskEntity,
      create: { input: z.looseObject({ projectId: z.string(), title: z.string() }) },
      update: { input: z.looseObject({ title: z.string() }).partial() },
      bulkUpdate: { input: z.looseObject({ title: z.string() }).partial() },
    }),
  },
});

type Prepare = (input: Record<string, unknown>) => Record<string, unknown>;

/** The task service, whose entity projection selects the task's project: a relation. */
function defineTasks(prepare?: Prepare) {
  return qd.defineService(tasks, {
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    project: {
      entity: {
        select: {
          ...Object.fromEntries(ENTITY_KEYS.map((key) => [key, true])),
          project: { select: { name: true } },
        },
      },
    },
    methods: {
      ...crud.handlers(tasks, {
        access: {
          create: { scope: "Moderate", of: projectContract, id: "projectId" },
          update: { entry: "Moderate" },
          bulkUpdate: "authenticated",
        },
        ...(prepare === undefined ? {} : { prepare }),
      } as never),
    },
  });
}

async function start(prepare?: Prepare) {
  const app = await createTestApp({
    services: [projectService, defineTasks(prepare)],
    db: kit.harness().db,
  });
  kit.track(app as unknown as TestApp);
  return app;
}

const refused = (path: readonly string[]) => ({
  code: "VALIDATION",
  data: { issues: [expect.objectContaining({ path })] },
});

describe("a kit write that holds a relation or a nested write", () => {
  it("is refused on update, for a Moderate member and a service-wide Admin alike (CRUD-5)", async () => {
    const board = kit.board();
    const { prisma } = kit.harness();
    const app = await start();
    const takeover = { id: board.t1, project: { update: { ownerId: board.bo } } } as never;
    await expect(app.as(as(board.bo)).taskService.update(takeover)).rejects.toMatchObject(
      refused(["project"]),
    );
    await expect(
      app.as(as(board.cy, { taskService: "Admin" })).taskService.update(takeover),
    ).rejects.toMatchObject(refused(["project"]));
    expect((await prisma.project.findUniqueOrThrow({ where: { id: board.p1 } })).ownerId).toBe(
      board.ada,
    );
  });

  it("is refused on create: a connect re-parents nothing", async () => {
    const board = kit.board();
    const { prisma } = kit.harness();
    const app = await start();
    await expect(
      app.as(as(board.ed)).taskService.create({
        projectId: board.p2,
        title: "mine",
        subtasks: { connect: [{ id: board.t1 }] },
      } as never),
    ).rejects.toMatchObject(refused(["subtasks"]));
    expect((await prisma.task.findUniqueOrThrow({ where: { id: board.t1 } })).parentTaskId).toBe(
      null,
    );
    expect(await prisma.task.count({ where: { title: "mine" } })).toBe(0);
  });

  it("refuses a relation key holding values, and a set that would disconnect every child", async () => {
    const board = kit.board();
    const { prisma } = kit.harness();
    const child = await prisma.task.create({
      data: { projectId: board.p1, title: "child", parentTaskId: board.t1 },
    });
    const app = await start();
    const bo = app.as(as(board.bo));
    await expect(
      bo.taskService.update({ id: board.t1, project: { name: "x" } } as never),
    ).rejects.toMatchObject(refused(["project"]));
    await expect(
      bo.taskService.update({ id: board.t1, subtasks: { set: [] } } as never),
    ).rejects.toMatchObject(refused(["subtasks"]));
    expect((await prisma.task.findUniqueOrThrow({ where: { id: child.id } })).parentTaskId).toBe(
      board.t1,
    );
  });

  it("is refused on bulkUpdate, its issue under data", async () => {
    const board = kit.board();
    const app = await start();
    await expect(
      app.as(as(board.bo)).taskService.bulkUpdate({
        ids: [board.t1],
        data: { project: { update: { name: "x" } } },
      } as never),
    ).rejects.toMatchObject(refused(["data", "project"]));
  });

  it("is INTERNAL when prepare returns one: the caller's input passed", async () => {
    const board = kit.board();
    const { prisma } = kit.harness();
    const app = await start((input) => ({ ...input, labels: { create: [] } }));
    await expect(
      app.as(as(board.bo)).taskService.create({ projectId: board.p1, title: "labelled" }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(await prisma.task.count({ where: { title: "labelled" } })).toBe(0);
  });
});

describe("a relation-form owner change (DATA-2)", () => {
  const projectRow = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });
  const projects = defineContract("projectService", {
    entity: projectRow,
    methods: {
      ...contractCrud.contract({
        entity: projectRow,
        update: {
          input: z
            .object({
              name: z.string(),
              ownerId: z.string(),
              owner: z.object({ connect: z.object({ id: z.string() }) }),
            })
            .partial(),
        },
      }),
    },
  });

  it("is refused, and the owner column stays read-only", async () => {
    const board = kit.board();
    const { prisma } = kit.harness();
    const service = qd.defineService(projects, {
      model: "project",
      access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
      methods: { ...crud.handlers(projects, { access: { update: { entry: "Moderate" } } }) },
    });
    const app = await createTestApp({ services: [service], db: kit.harness().db });
    kit.track(app as unknown as TestApp);
    const bo = app.as(as(board.bo));
    await expect(
      bo.projectService.update({ id: board.p1, owner: { connect: { id: board.bo } } }),
    ).rejects.toMatchObject(refused(["owner"]));
    await expect(
      bo.projectService.update({ id: board.p1, ownerId: board.bo }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: board.p1 } })).ownerId).toBe(
      board.ada,
    );
  });
});
