// The columns a kit write may not set (the 5.1 audit's CRUD-3 and CRUD-7).
// A column a policy reads stays read-only to all but a service-wide Admin,
// even when an anchored collection also scopes by it: such a column was
// only checked as an anchor move, so a member set themself as a task's
// owner (`owner("assigneeId")` beside an `assigned` collection anchored on
// users), or a project's `ownerId` (a `jsonAcl` owner beside an `owned`
// collection). A membership table's entry, user and role columns stay
// read-only on that table whichever policy reads them: crud on the table
// let a member raise their own role.
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
import { anyOf, crud, inherit, jsonAcl, members, owner, resolver } from "../../index";
import { as, kitApp, taskEntity } from "./__tests__/fixture";

const kit = kitApp();

/** The users, each the Admin of their own row: what `assigned` and `owned` are anchored on. */
const userContract = defineContract("userService", {
  entity: z.object({ id: z.string(), name: z.string() }),
  methods: {},
});

const userService = qd.defineService(userContract, {
  model: "user",
  access: owner("id"),
  methods: {},
});

/** Closes `app` after the test, and returns it. */
function tracked<A>(app: A): A {
  kit.track(app as unknown as TestApp);
  return app;
}

describe("an owner column an anchored collection scopes by (CRUD-3)", () => {
  const tasks = defineContract("taskService", {
    entity: taskEntity,
    methods: {
      ...contractCrud.contract({
        entity: taskEntity,
        get: true,
        update: {
          input: z.object({ title: z.string(), assigneeId: z.string().nullable() }).partial(),
        },
        delete: true,
      }),
    },
    collections: {
      board: { scope: "projectId", item: "entity", order: [["id", "asc"]] },
      assigned: { scope: "assigneeId", item: "entity", order: [["id", "asc"]] },
    },
  });

  const taskService = qd.defineService(tasks, {
    model: "task",
    access: anyOf(owner("assigneeId"), inherit({ from: projectContract, via: "projectId" })),
    collections: { board: { anchor: projectContract }, assigned: { anchor: userContract } },
    methods: {
      ...crud.handlers(tasks, {
        access: {
          get: { entry: "Read" },
          update: { entry: "Moderate" },
          delete: { entry: "Admin" },
        },
      }),
    },
  });

  it("stays read-only: a member cannot make themself the row's owner", async () => {
    const board = kit.board();
    const { prisma } = kit.harness();
    const app = tracked(
      await createTestApp({
        services: [projectService, userService, taskService],
        db: kit.harness().db,
      }),
    );
    const member = app.as(as(board.bo)).taskService;
    await expect(member.update({ id: board.t1, assigneeId: board.bo })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message:
        '"assigneeId" decides who may reach rows of taskService: only a service-wide Admin may change it',
    });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: board.t1 } })).assigneeId).toBe(
      null,
    );
    await expect(member.delete({ id: board.t1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await app
      .as(as(board.ed, { taskService: "Admin" }))
      .taskService.update({ id: board.t1, assigneeId: board.bo });
    expect((await prisma.task.findUniqueOrThrow({ where: { id: board.t1 } })).assigneeId).toBe(
      board.bo,
    );
  });

  it("keeps a jsonAcl owner read-only beside a collection anchored on users", async () => {
    const board = kit.board();
    const { prisma } = kit.harness();
    const projectRow = z.object({ id: z.string(), name: z.string(), ownerId: z.string() });
    const projects = defineContract("ownedProjectService", {
      entity: projectRow,
      methods: {
        ...contractCrud.contract({
          entity: projectRow,
          update: { input: z.object({ name: z.string(), ownerId: z.string() }).partial() },
        }),
      },
      collections: { owned: { scope: "ownerId", item: "entity", order: [["id", "asc"]] } },
    });
    const ownedProjectService = qd.defineService(projects, {
      model: "project",
      access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
      collections: { owned: { anchor: userContract } },
      methods: { ...crud.handlers(projects, { access: { update: { entry: "Moderate" } } }) },
    });
    await prisma.project.update({
      where: { id: board.p1 },
      data: { acl: [{ userId: board.di, level: "Moderate" }] },
    });
    const app = tracked(
      await createTestApp({
        services: [projectService, userService, ownedProjectService],
        db: kit.harness().db,
      }),
    );
    await expect(
      app.as(as(board.di)).ownedProjectService.update({ id: board.p1, ownerId: board.di }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await prisma.project.findUniqueOrThrow({ where: { id: board.p1 } })).ownerId).toBe(
      board.ada,
    );
  });
});

describe("a membership table's columns (CRUD-7)", () => {
  const memberRow = z.object({
    id: z.string(),
    projectId: z.string(),
    userId: z.string(),
    role: z.string(),
  });
  const memberships = defineContract("projectMemberService", {
    entity: memberRow,
    methods: {
      ...contractCrud.contract({
        entity: memberRow,
        create: {
          input: z.object({ projectId: z.string(), userId: z.string(), role: z.string() }),
        },
        update: { input: z.object({ role: z.string() }).partial() },
        bulkUpdate: { input: z.object({ role: z.string() }).partial() },
      }),
    },
  });
  const projectMemberService = qd.defineService(memberships, {
    model: "projectMember",
    access: inherit({ from: projectContract, via: "projectId" }),
    methods: {
      ...crud.handlers(memberships, {
        access: {
          create: { scope: "Moderate", of: projectContract, id: "projectId" },
          update: { entry: "Moderate" },
          bulkUpdate: "authenticated",
        },
      }),
    },
  });

  it("stay read-only to a member, who cannot raise their own role or add a member", async () => {
    const board = kit.board();
    const { prisma } = kit.harness();
    const own = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: board.p1, userId: board.bo } },
    });
    const app = tracked(
      await createTestApp({
        services: [projectService, projectMemberService],
        db: kit.harness().db,
      }),
    );
    const member = app.as(as(board.bo)).projectMemberService;
    await expect(member.update({ id: own.id, role: "Admin" })).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/membership/),
    });
    expect((await prisma.projectMember.findUniqueOrThrow({ where: { id: own.id } })).role).toBe(
      "Moderate",
    );
    await expect(
      member.create({ projectId: board.p1, userId: board.ed, role: "Admin" }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/membership/) });
    expect(await prisma.projectMember.count({ where: { userId: board.ed } })).toBe(0);
    await expect(
      member.bulkUpdate({ ids: [own.id], data: { role: "Admin" } }),
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/membership/) });
    expect((await prisma.projectMember.findUniqueOrThrow({ where: { id: own.id } })).role).toBe(
      "Moderate",
    );
  });

  it("are written by a service-wide Admin of the membership service", async () => {
    const board = kit.board();
    const { prisma } = kit.harness();
    const own = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: board.p1, userId: board.bo } },
    });
    const app = tracked(
      await createTestApp({
        services: [projectService, projectMemberService],
        db: kit.harness().db,
      }),
    );
    const admin = app.as(as(board.ed, { projectMemberService: "Admin" })).projectMemberService;
    await admin.update({ id: own.id, role: "Admin" });
    await admin.create({ projectId: board.p1, userId: board.ed, role: "Read" });
    expect(await prisma.projectMember.findMany({ where: { projectId: board.p1 } })).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ userId: board.bo, role: "Admin" }),
        expect.objectContaining({ userId: board.ed, role: "Read" }),
      ]),
    );
  });
});

describe("a membership any kind of policy reads (CRUD-7)", () => {
  const memberRow = z.object({
    id: z.string(),
    projectId: z.string(),
    userId: z.string(),
    role: z.string(),
  });
  const projectRow = z.object({ id: z.string(), name: z.string() });

  /** A project service whose policy reads the membership table as `policy` says, and crud on that table. */
  function servicesOver(policy: unknown) {
    const projects = defineContract("teamService", { entity: projectRow, methods: {} });
    const teamService = qd.defineService(projects, {
      model: "project",
      access: policy as never,
      methods: {},
    });
    const rows = defineContract("teamMemberService", {
      entity: memberRow,
      methods: {
        ...contractCrud.contract({
          entity: memberRow,
          update: { input: z.object({ role: z.string() }).partial() },
        }),
      },
    });
    const teamMemberService = qd.defineService(rows, {
      model: "projectMember",
      access: inherit({ from: projects, via: "projectId" }),
      methods: { ...crud.handlers(rows, { access: { update: { entry: "Moderate" } } }) },
    });
    return [teamService, teamMemberService] as const;
  }

  it.each([
    [
      "a resolver's declared memberships",
      resolver({
        levelsFor: async (principal, ids, tools) => {
          const read = {
            model: "projectMember",
            entry: "projectId",
            user: "userId",
            level: "role",
          };
          return await tools.memberships({ ...read, levels: undefined }, principal.userId, ids);
        },
        reads: {
          memberships: [
            { model: "projectMember", entry: "projectId", user: "userId", level: "role" },
          ],
        },
      }),
    ],
    [
      "a members policy that spells the model ProjectMember",
      members({ model: "ProjectMember", entry: "projectId", user: "userId", level: "role" }),
    ],
  ])("locks the role through %s", async (_name, policy) => {
    const board = kit.board();
    const { prisma } = kit.harness();
    const own = await prisma.projectMember.findUniqueOrThrow({
      where: { projectId_userId: { projectId: board.p1, userId: board.bo } },
    });
    const [teamService, teamMemberService] = servicesOver(policy);
    const app = tracked(
      await createTestApp({ services: [teamService, teamMemberService], db: kit.harness().db }),
    );
    await expect(
      app.as(as(board.bo)).teamMemberService.update({ id: own.id, role: "Admin" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringMatching(/"role" holds a membership in teamService's policy/),
    });
    expect((await prisma.projectMember.findUniqueOrThrow({ where: { id: own.id } })).role).toBe(
      "Moderate",
    );
  });
});
