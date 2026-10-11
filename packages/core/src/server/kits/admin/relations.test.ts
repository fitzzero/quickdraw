// The admin kit writes column values only (the 5.1 audit's ADMIN-1): it
// validates `data` against the entity schema but wrote the raw object, so an
// entity that shows a relation (its projection selects it with a nested
// select, the documented pattern) let a write carry a Prisma nested write:
// `{ project: { update: { ownerId } } }` took over the task's project, and
// `{ assignee: { update: { serviceAccess } } }` rewrote the caller's own
// grants. A relation key or a nested-write value is now `VALIDATION`, under
// the default form and a lowered one alike; `adminMeta` shows relation
// fields as read-only, and an `editable` list naming one fails when the
// service is defined.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -
//   T1 in P1, T2 in P2

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { admin as adminContract, defineContract } from "../../../index";
import { createTestApp, type TestApp } from "../../../testing/index";
import type { Principal } from "../../types";
import { projectContract, projectService, qd } from "../../emit/__tests__/live";
import { admin, inherit } from "../../index";
import { adminApp, as, serviceAdmin } from "./__tests__/fixture";

const kit = adminApp();

const relTask = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  assigneeId: z.string().nullable(),
  project: z.object({ name: z.string() }).partial(),
  assignee: z.object({ name: z.string() }).partial().nullable(),
});

const relContract = defineContract("taskService", {
  entity: relTask,
  methods: { ...adminContract.contract({ entity: relTask }) },
});

/** The task service whose entity shows its project and assignee, under the kit's default forms or a lowered update. */
function defineRelTasks(lowered: boolean, editable?: readonly string[]) {
  return qd.defineService(relContract, {
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    project: {
      entity: {
        select: {
          id: true,
          projectId: true,
          title: true,
          assigneeId: true,
          project: { select: { name: true } },
          assignee: { select: { name: true } },
        },
      },
    },
    methods: {
      ...admin.handlers(relContract, {
        ...(lowered ? { access: { adminUpdate: { entry: "Moderate" } } } : {}),
        ...(editable === undefined ? {} : { editable }),
      } as never),
    },
  });
}

interface RelCalls {
  adminCreate(input: unknown): Promise<unknown>;
  adminUpdate(input: unknown): Promise<unknown>;
  adminMeta(): Promise<{
    readonly fields: readonly { readonly name: string; readonly editable: boolean }[];
  }>;
}

/** The app, and bo as the form needs him: a service-wide Admin, or a Moderate member under the lowered form. */
async function start(lowered: boolean) {
  const board = kit.board();
  const app = await createTestApp({
    services: [projectService, defineRelTasks(lowered)],
    db: kit.harness().db,
  });
  kit.track(app as unknown as TestApp);
  const bo: Principal = lowered ? as(board.bo) : serviceAdmin(board.bo);
  return (app.as(bo) as unknown as { readonly taskService: RelCalls }).taskService;
}

const refused = { code: "VALIDATION" };

describe("an admin write that holds a relation or a nested write", () => {
  for (const lowered of [false, true]) {
    const label = lowered ? "under a lowered form" : "as a service-wide Admin";

    it(`is refused ${label}: no project takeover, no move by connect (ADMIN-1)`, async () => {
      const board = kit.board();
      const { prisma } = kit.harness();
      const bo = await start(lowered);
      await expect(
        bo.adminUpdate({
          id: board.t1,
          data: { project: { update: { ownerId: board.bo, acl: [] } } },
        }),
      ).rejects.toMatchObject(refused);
      expect((await prisma.project.findUniqueOrThrow({ where: { id: board.p1 } })).ownerId).toBe(
        board.ada,
      );
      await expect(
        bo.adminUpdate({ id: board.t1, data: { project: { connect: { id: board.p2 } } } }),
      ).rejects.toMatchObject(refused);
      expect((await prisma.task.findUniqueOrThrow({ where: { id: board.t1 } })).projectId).toBe(
        board.p1,
      );
      if (!lowered) {
        // The lowered variant lowers adminUpdate alone: adminCreate keeps the Admin grant.
        await expect(
          bo.adminCreate({
            data: { title: "planted", project: { connect: { id: board.p1 } } },
          }),
        ).rejects.toMatchObject(refused);
        expect(await prisma.task.count({ where: { title: "planted" } })).toBe(0);
      }
    });
  }

  it("shows relation fields as read-only in adminMeta", async () => {
    const bo = await start(false);
    const { fields } = await bo.adminMeta();
    const editable = Object.fromEntries(fields.map((field) => [field.name, field.editable]));
    expect(editable).toMatchObject({ project: false, assignee: false, title: true });
  });

  it("never rewrites the caller's own grants through a relation", async () => {
    const board = kit.board();
    const { prisma } = kit.harness();
    const bo = await start(true);
    expect(await bo.adminUpdate({ id: board.t1, data: { assigneeId: board.bo } })).toMatchObject({
      assigneeId: board.bo,
    });
    await expect(
      bo.adminUpdate({
        id: board.t1,
        data: {
          assignee: {
            update: { serviceAccess: { projectService: "Admin", taskService: "Admin" } },
          },
        },
      }),
    ).rejects.toMatchObject(refused);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: board.bo } })).serviceAccess,
    ).toBeNull();
  });

  it("refuses an editable list that names a relation when the service is defined", () => {
    expect(() => defineRelTasks(false, ["title", "project"])).toThrow(
      /"project" is a relation of taskService's model/,
    );
  });
});

describe("a JSON field written through the admin kit", () => {
  it("refuses a top-level relation operation, and stores one held a level deeper", async () => {
    const board = kit.board();
    const { app } = await kit.start();
    const ada = (app.as(serviceAdmin(board.ada)) as unknown as { readonly taskService: RelCalls })
      .taskService;
    await expect(
      ada.adminUpdate({ id: board.t1, data: { details: { connect: { id: "x" } } } }),
    ).rejects.toMatchObject(refused);
    expect(
      await ada.adminUpdate({
        id: board.t1,
        data: { details: { link: { connect: { id: "x" } } } },
      }),
    ).toMatchObject({ details: { link: { connect: { id: "x" } } } });
  });
});
