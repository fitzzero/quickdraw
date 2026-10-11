// The read/write kit's `create` (the 5.1 audit's CRUD-1/ACCESS-3): it
// checks no row of its own, so it checks the anchors of the row it writes,
// after `prepare`, at the method's row level, and takes a column the policy
// reads only from `prepare`. Before, under `"authenticated"`, `"public"`, a
// service grant or `custom`, any caller wrote rows into another tenant's
// project, and a scope form left a second anchored column unchecked.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { crud as contractCrud, defineContract } from "../../../index";
import { createTestApp, type TestApp } from "../../../testing/index";
import { projectMembers } from "../../access/__tests__/board";
import type { AccessForm } from "../../access/types";
import { projectContract, projectService, qd } from "../../emit/__tests__/live";
import { anyOf, crud, custom, inherit, jsonAcl, owner } from "../../index";
import { as, kitApp, taskEntity } from "./__tests__/fixture";

const kit = kitApp();

const users = defineContract("userService", {
  entity: z.object({ id: z.string(), name: z.string() }),
  methods: {},
});

const userService = qd.defineService(users, { model: "user", access: owner("id"), methods: {} });

const tasks = defineContract("taskService", {
  entity: taskEntity,
  methods: {
    ...contractCrud.contract({
      entity: taskEntity,
      create: {
        input: z.object({
          projectId: z.string(),
          title: z.string(),
          assigneeId: z.string().nullable().optional(),
        }),
      },
    }),
  },
  collections: {
    board: { scope: "projectId", item: "entity", order: [["id", "asc"]] },
    assigned: { scope: "assigneeId", item: "entity", order: [["id", "asc"]] },
  },
});

type Prepare = (
  input: { readonly projectId: string; readonly title: string },
  ctx: { readonly principal: { readonly userId: string } },
) => Record<string, unknown>;

/** The task service with the kit's create under `form`, anchored on projects and on assignees. */
function defineTasks(form: AccessForm, prepare?: Prepare) {
  return qd.defineService(tasks, {
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    collections: { board: { anchor: projectContract }, assigned: { anchor: users } },
    methods: {
      ...crud.handlers(tasks, {
        access: { create: form },
        ...(prepare === undefined ? {} : { prepare }),
      } as never),
    },
  });
}

async function start(form: AccessForm, prepare?: Prepare) {
  const app = await createTestApp({
    services: [projectService, userService, defineTasks(form, prepare)],
    db: kit.harness().db,
  });
  kit.track(app as unknown as TestApp);
  return app;
}

/** How many tasks carry `title`. */
async function countTitled(title: string): Promise<number> {
  return await kit.harness().prisma.task.count({ where: { title } });
}

const intoProject = {
  code: "FORBIDDEN",
  message: /needs Moderate on the projectService row it names/,
};

describe("the read/write kit's create", () => {
  it("checks the project it writes into, whatever the form (CRUD-1)", async () => {
    const board = kit.board();
    const moderate = { taskService: "Moderate" } as const;
    const forms: [string, AccessForm, ReturnType<typeof as>, ReturnType<typeof as>][] = [
      ["authenticated", "authenticated", as(board.ed), as(board.bo)],
      ["custom", custom(() => true), as(board.ed), as(board.bo)],
      ["a service grant", { service: "Moderate" }, as(board.ed, moderate), as(board.bo, moderate)],
    ];
    for (const [label, form, ed, bo] of forms) {
      const app = await start(form);
      await expect(
        app.as(ed).taskService.create({ projectId: board.p1, title: "planted" }),
        label,
      ).rejects.toMatchObject(intoProject);
      expect(await countTitled("planted"), label).toBe(0);
      // A member with Moderate on P1 creates in it.
      expect(
        await app.as(bo).taskService.create({ projectId: board.p1, title: label }),
        label,
      ).toMatchObject({ projectId: board.p1, title: label });
    }
  });

  it("refuses an anonymous caller under a public form (ACCESS-3)", async () => {
    const board = kit.board();
    const app = await start("public");
    await expect(
      app.as(null).taskService.create({ projectId: board.p1, title: "planted" }),
    ).rejects.toMatchObject(intoProject);
    expect(await countTitled("planted")).toBe(0);
  });

  it("checks a second anchored column beside a scope form", async () => {
    const board = kit.board();
    const app = await start({ scope: "Moderate", of: projectContract, id: "projectId" });
    const ed = app.as(as(board.ed));
    await expect(
      ed.taskService.create({ projectId: board.p2, title: "phish", assigneeId: board.ada }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: /"assigneeId"/ });
    expect(await countTitled("phish")).toBe(0);
    expect(
      await ed.taskService.create({ projectId: board.p2, title: "mine", assigneeId: board.ed }),
    ).toMatchObject({ assigneeId: board.ed });
    expect(
      await ed.taskService.create({ projectId: board.p2, title: "nobody's", assigneeId: null }),
    ).toMatchObject({ assigneeId: null });
  });

  it("checks the anchors prepare writes, which may set them from the principal", async () => {
    const board = kit.board();
    const app = await start("authenticated", (input, ctx) => ({
      ...input,
      assigneeId: ctx.principal.userId,
    }));
    expect(
      await app.as(as(board.ed)).taskService.create({ projectId: board.p2, title: "mine" }),
    ).toMatchObject({ projectId: board.p2, assigneeId: board.ed });
  });

  it("passes a service-wide Admin", async () => {
    const board = kit.board();
    const app = await start({ scope: "Moderate", of: projectContract, id: "projectId" });
    expect(
      await app
        .as(as(board.cy, { taskService: "Admin" }))
        .taskService.create({ projectId: board.p2, title: "assigned", assigneeId: board.ada }),
    ).toMatchObject({ projectId: board.p2, assigneeId: board.ada });
  });
});

describe("the read/write kit's create on a service whose policy reads its own columns", () => {
  const projectRow = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });
  const projects = defineContract("projectService", {
    entity: projectRow,
    methods: {
      ...contractCrud.contract({
        entity: projectRow,
        create: { input: z.object({ name: z.string(), ownerId: z.string().optional() }) },
      }),
    },
  });
  const defineProjects = (prepare?: Prepare) =>
    qd.defineService(projects, {
      model: "project",
      access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
      methods: {
        ...crud.handlers(projects, {
          access: { create: "authenticated" },
          ...(prepare === undefined ? {} : { prepare }),
        } as never),
      },
    });

  it("takes a policy column only from prepare", async () => {
    const board = kit.board();
    const plain = await createTestApp({ services: [defineProjects()], db: kit.harness().db });
    kit.track(plain as unknown as TestApp);
    await expect(
      plain.as(as(board.bo)).projectService.create({ name: "Mine", ownerId: board.ada }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        '"ownerId" decides who may reach rows of projectService: only a service-wide Admin may send it; set it in the kit\'s prepare',
    });
    expect(await kit.harness().prisma.project.count({ where: { name: "Mine" } })).toBe(0);
    const prepared = await createTestApp({
      services: [defineProjects((input, ctx) => ({ ...input, ownerId: ctx.principal.userId }))],
      db: kit.harness().db,
    });
    kit.track(prepared as unknown as TestApp);
    expect(await prepared.as(as(board.bo)).projectService.create({ name: "Mine" })).toMatchObject({
      name: "Mine",
      ownerId: board.bo,
    });
  });
});
