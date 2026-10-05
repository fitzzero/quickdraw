// The admin kit's `adminList` (RFC 0003 section 12.4) against PGlite: pages
// by number over every row of the service, with 4.1's arithmetic, and a
// filter and a sort restricted to the fields the contract declares. 4.1
// handed the caller's `where` and `orderBy` to the database as they came
// (4.1 `src/server/BaseService.ts:1367-1379`); every way a caller could
// try that now is `VALIDATION`, before the handler runs.

import { describe, expect, it } from "vitest";
import { admin as adminContract, defineContract } from "../../../index";
import { admin as adminKit, inherit, type CallRecord } from "../../index";
import { createTestApp, type TestApp } from "../../../testing/index";
import { projectContract, projectService, qd } from "../../emit/__tests__/live";
import {
  addTasks,
  adminApp,
  as,
  defineTaskService,
  serviceAdmin,
  taskEntity,
} from "./__tests__/fixture";

const kit = adminApp();

type App = Awaited<ReturnType<typeof kit.start>>["app"];

/** The service administrator's task service caller, untyped for the inputs the contract refuses. */
function loose(app: App) {
  return app.as(serviceAdmin(kit.board().ed)).taskService as unknown as {
    adminList(input: unknown): Promise<unknown>;
  };
}

describe("adminList", () => {
  it("pages every row by number, with the total and 4.1's page arithmetic", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    await addTasks(kit.harness().prisma, board.p1, ["A", "B", "C"]);
    const admin = app.as(serviceAdmin(board.ed)).taskService;
    const sort = { field: "title", direction: "asc" } as const;
    const first = await admin.adminList({ page: 1, pageSize: 2, sort });
    expect(first.items.map((item) => item.title)).toEqual(["A", "B"]);
    expect(first).toMatchObject({ total: 5, page: 1, pageSize: 2, totalPages: 3 });
    const last = await admin.adminList({ page: 3, pageSize: 2, sort });
    expect(last.items.map((item) => item.title)).toEqual(["T2"]);
    const past = await admin.adminList({ page: 4, pageSize: 2, sort });
    expect(past).toEqual({ items: [], total: 5, page: 4, pageSize: 2, totalPages: 3 });
    // Both projects' rows: no policy filters an admin list.
    expect(new Set(first.items.concat(last.items).map((item) => item.projectId)).size).toBe(2);
  });

  it("defaults to page 1 of 20 rows in the first declared sort field's order, and caps a page at 100", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    await addTasks(kit.harness().prisma, board.p1, ["A", "B"]);
    const admin = app.as(serviceAdmin(board.ed)).taskService;
    const page = await admin.adminList();
    expect(page).toMatchObject({ total: 4, page: 1, pageSize: 20, totalPages: 1 });
    // createdAt ascending: the board's two tasks were made first.
    expect(page.items.map((item) => item.title)).toEqual(["T1", "T2", "A", "B"]);
    expect((await admin.adminList({ pageSize: 500 })).pageSize).toBe(100);
    const descending = await admin.adminList({ sort: { field: "createdAt", direction: "desc" } });
    expect(descending.items.map((item) => item.title)).toEqual(["B", "A", "T2", "T1"]);
  });

  it("filters by equality on the declared fields", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    await addTasks(kit.harness().prisma, board.p1, ["Done"], { status: "done", pinned: true });
    const admin = app.as(serviceAdmin(board.ed)).taskService;
    const done = await admin.adminList({ filter: { status: "done" } });
    expect(done.items.map((item) => item.title)).toEqual(["Done"]);
    expect(done.total).toBe(1);
    const pinned = await admin.adminList({ filter: { pinned: true, projectId: board.p1 } });
    expect(pinned.items.map((item) => item.title)).toEqual(["Done"]);
    expect((await admin.adminList({ filter: { projectId: board.p2 } })).total).toBe(1);
  });

  it("refuses a filter or a sort on an undeclared field, an operator, and a where or orderBy", async () => {
    const { app } = await kit.start();
    const list = loose(app);
    const refused = async (input: unknown, path: readonly (string | number)[]) => {
      await expect(list.adminList(input)).rejects.toMatchObject({
        code: "VALIDATION",
        data: { issues: [expect.objectContaining({ path })] },
      });
    };
    await refused({ filter: { title: "T1" } }, ["filter", "title"]);
    await refused({ filter: { notes: null } }, ["filter", "notes"]);
    await refused({ filter: { status: { not: "open" } } }, ["filter", "status"]);
    await refused({ filter: { projectId: { in: ["p"] } } }, ["filter", "projectId"]);
    await refused({ sort: { field: "notes" } }, ["sort", "field"]);
    await refused({ sort: { field: "title", direction: "sideways" } }, ["sort", "direction"]);
    await refused({ where: { title: { contains: "T" } } }, ["where"]);
    await refused({ orderBy: { title: "asc" } }, ["orderBy"]);
    await refused({ page: 0 }, ["page"]);
    await refused({ page: 1.5 }, ["page"]);
    await refused({ pageSize: 0 }, ["pageSize"]);
  });

  it("answers in two statements, run together", async () => {
    const records: CallRecord[] = [];
    const app = await createTestApp({
      services: [projectService, defineTaskService()],
      db: kit.harness().db,
      onCall: (record) => records.push(record),
    });
    kit.track(app as unknown as TestApp);
    await app
      .as(serviceAdmin(kit.board().ed))
      .taskService.adminList({ filter: { status: "open" } });
    expect(records.map((record) => [record.method, record.sqlStatements])).toEqual([
      ["adminList", 2],
    ]);
  });

  it("returns whole rows to a service-wide Admin: every tier, dates as ISO strings, JSON as stored", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    await kit.harness().prisma.task.update({
      where: { id: board.t1 },
      data: { notes: "Admin only", details: { size: "L", tags: ["a"] } },
    });
    const page = await app
      .as(serviceAdmin(board.ed))
      .taskService.adminList({ filter: { projectId: board.p1 } });
    expect(page.items).toEqual([
      {
        id: board.t1,
        projectId: board.p1,
        title: "T1",
        status: "open",
        ordinal: 0,
        pinned: false,
        details: { size: "L", tags: ["a"] },
        assigneeId: null,
        notes: "Admin only",
        createdAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
        updatedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/),
      },
    ]);
    // A member reads the same row without the Admin-only field.
    const row = await app.as(as(board.bo)).taskService.get({ id: board.t1 });
    expect(row).not.toHaveProperty("notes");
  });

  it("sorts by id when its default sort field is above the caller's level, which may not sort on it either", async () => {
    const tiered = defineContract("taskService", {
      entity: taskEntity,
      fields: { notes: "Admin" },
      methods: { ...adminContract.contract({ entity: taskEntity, sort: ["notes", "title"] }) },
    });
    const service = qd.defineService(tiered, {
      model: "task",
      access: inherit({ from: projectContract, via: "projectId" }),
      methods: {
        ...adminKit.handlers(tiered, { access: { adminList: { service: "Moderate" } } }),
      },
    });
    const app = await createTestApp({ services: [projectService, service], db: kit.harness().db });
    kit.track(app as unknown as TestApp);
    const board = kit.board();
    const prisma = kit.harness().prisma;
    // In notes order T2 comes first; in id order T1 does.
    await prisma.task.update({ where: { id: board.t1 }, data: { notes: "zzz" } });
    await prisma.task.update({ where: { id: board.t2 }, data: { notes: "aaa" } });
    const byId = (await prisma.task.findMany({ orderBy: { id: "asc" }, select: { id: true } })).map(
      (row) => row.id,
    );
    const moderator = app.as(as(board.cy, { taskService: "Moderate" })).taskService;
    const page = await moderator.adminList();
    expect(page.items.map((item) => item.id)).toEqual(byId);
    expect(page.items[0]).not.toHaveProperty("notes");
    await expect(moderator.adminList({ sort: { field: "notes" } })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    // A service administrator sees notes, and lists in their order.
    const administrator = app.as(serviceAdmin(board.ed)).taskService;
    expect((await administrator.adminList()).items.map((item) => item.id)).toEqual([
      board.t2,
      board.t1,
    ]);
  });
});
