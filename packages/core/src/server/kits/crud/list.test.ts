// The read/write kit's `list` and `get` (RFC 0003 section 12.1) through a
// real server against PGlite: keyset paging that stays put when rows are
// inserted, filters and sorts limited to the declared fields, the clamped
// page size, crafted cursors, field tiers on items, and the statements each
// costs.

import { describe, expect, it } from "vitest";
import { defineContract } from "../../../index";
import { createTestApp, type TestApp } from "../../../testing/index";
import { projectContract, projectService, qd } from "../../emit/__tests__/live";
import { crud, inherit } from "../../index";
import { cursorAfter } from "./page";
import { addTasks, as, CARD_KEYS, kitApp, taskEntity } from "./__tests__/fixture";

const kit = kitApp();

type Page = { items: { id: string; ordinal: number; title: string }[]; nextCursor: string | null };

describe("list paging", () => {
  it("pages through every row in order, and ends with a null cursor", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const added = await addTasks(kit.harness().prisma, board.p1, [1, 2, 3, 4]);
    const owner = app.as(as(board.ada)).taskService;
    const first = await owner.list({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([board.t1, added[0]]);
    expect(Object.keys(first.items[0] ?? {})).toEqual(CARD_KEYS);
    expect(first).not.toHaveProperty("totalCount");
    const second = await owner.list({ limit: 2, cursor: first.nextCursor ?? "" });
    expect(second.items.map((item) => item.id)).toEqual([added[1], added[2]]);
    const last = await owner.list({ limit: 2, cursor: second.nextCursor ?? "" });
    expect(last).toEqual({ items: [expect.objectContaining({ id: added[3] })], nextCursor: null });
  });

  it("keeps its place when rows are inserted before the cursor", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const prisma = kit.harness().prisma;
    const [one = "", two = "", three = ""] = await addTasks(prisma, board.p1, [10, 20, 30]);
    const owner = app.as(as(board.ada)).taskService;
    const first = await owner.list({ limit: 2 });
    expect(first.items.map((item) => item.id)).toEqual([board.t1, one]);
    // Rows before the cursor, and one after it.
    await addTasks(prisma, board.p1, [-5, 5, 15]);
    const second = (await owner.list({ limit: 3, cursor: first.nextCursor ?? "" })) as Page;
    expect(second.items.map((item) => item.ordinal)).toEqual([15, 20, 30]);
    expect(second.items.slice(1).map((item) => item.id)).toEqual([two, three]);
    expect(second.nextCursor).toBeNull();
  });

  it("filters and sorts by declared fields, and counts every match when asked", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const prisma = kit.harness().prisma;
    await addTasks(prisma, board.p1, [1, 2], { status: "done" });
    await addTasks(prisma, board.p1, [3], { status: "open", title: "Alpha" });
    const owner = app.as(as(board.ada)).taskService;
    const done = await owner.list({ filter: { status: "done" }, totalCount: true, limit: 1 });
    expect(done.items.map((item) => item.status)).toEqual(["done"]);
    expect(done.totalCount).toBe(2);
    const open = await owner.list({ filter: { status: "open", assigneeId: null } });
    expect(open.items.map((item) => item.title)).toEqual(["T1", "Alpha"]);
    const byTitle = await owner.list({ sort: { field: "title", direction: "desc" } });
    expect(byTitle.items.map((item) => item.title)).toEqual(["Task 2", "Task 1", "T1", "Alpha"]);
    const pages: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await owner.list({ sort: { field: "title" }, limit: 3, cursor });
      pages.push(...page.items.map((item) => item.title));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(pages).toEqual(["Alpha", "T1", "Task 1", "Task 2"]);
    expect((await owner.list({ filter: { status: "none" }, totalCount: true })).totalCount).toBe(0);
  });

  it("pages by a date column, whose cursor carries the date", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const prisma = kit.harness().prisma;
    const ids = await addTasks(prisma, board.p1, [1, 2, 3]);
    for (const [index, id] of [board.t1, ...ids].entries()) {
      await prisma.task.update({
        where: { id },
        data: { updatedAt: new Date(Date.UTC(2026, 0, index + 1)) },
      });
    }
    const owner = app.as(as(board.ada)).taskService;
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await owner.list({
        sort: { field: "updatedAt", direction: "desc" },
        limit: 1,
        cursor,
      });
      seen.push(...page.items.map((item) => item.id));
      cursor = page.nextCursor ?? undefined;
    } while (cursor !== undefined);
    expect(seen).toEqual([...ids].reverse().concat(board.t1));
  });

  it("refuses a filter or sort on an undeclared field, and a filter value that is not plain", async () => {
    const { app } = await kit.start();
    const owner = app.as(as(kit.board().ada)).taskService as unknown as {
      list(input: unknown): Promise<unknown>;
    };
    await expect(owner.list({ filter: { title: "T1" } })).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["filter", "title"] }] },
    });
    await expect(owner.list({ sort: { field: "notes" } })).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["sort", "field"] }] },
    });
    // An operator smuggled in as a value never reaches the database.
    await expect(owner.list({ filter: { status: { not: "open" } } })).rejects.toMatchObject({
      code: "VALIDATION",
      data: { issues: [{ path: ["filter", "status"] }] },
    });
    await expect(owner.list({ where: { id: "x" } })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(owner.list({ limit: 0 })).rejects.toMatchObject({ code: "VALIDATION" });
    // A value the column cannot hold is the caller's mistake too.
    await expect(owner.list({ filter: { status: 7 } })).rejects.toMatchObject({
      code: "VALIDATION",
    });
  });

  it("clamps a limit above 200 to 200", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    await kit.harness().prisma.task.createMany({
      data: Array.from({ length: 205 }, (_, index) => ({
        projectId: board.p1,
        title: `Bulk ${index}`,
        ordinal: index + 1,
      })),
    });
    const page = await app.as(as(board.ada)).taskService.list({ limit: 1000, totalCount: true });
    expect(page.items).toHaveLength(200);
    expect(page.totalCount).toBe(206);
    expect(page.nextCursor).not.toBeNull();
    expect((await app.as(as(board.ada)).taskService.list()).items).toHaveLength(50);
  });

  it("answers a crafted cursor with VALIDATION", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    await addTasks(kit.harness().prisma, board.p1, [1, 2]);
    const owner = app.as(as(board.ada)).taskService;
    const { nextCursor } = await owner.list({ limit: 1 });
    const crafted = [
      "not a cursor",
      Buffer.from("[1,2]").toString("base64url"),
      Buffer.from('["ordinal asc,id asc",{"x":1},"t"]').toString("base64url"),
      // A cursor of another order of the same list.
      (await owner.list({ limit: 1, sort: { field: "title" } })).nextCursor ?? "",
      // The right order, with a value the column cannot hold.
      cursorAfter(
        [
          ["ordinal", "asc"],
          ["id", "asc"],
        ],
        { ordinal: "first", id: board.t1 },
      ),
    ];
    for (const cursor of crafted) {
      await expect(owner.list({ limit: 1, cursor })).rejects.toMatchObject({
        code: "VALIDATION",
      });
    }
    expect((await owner.list({ limit: 1, cursor: nextCursor ?? "" })).items).toHaveLength(1);
  });
});

describe("list items", () => {
  const rows = defineContract("rowService", {
    entity: taskEntity,
    fields: { notes: "Admin" },
    methods: { ...crud.contract({ entity: taskEntity, get: true, list: { sort: ["ordinal"] } }) },
  });

  async function serve(): Promise<TestApp> {
    const service = qd.defineService(rows, {
      model: "task",
      access: inherit({ from: projectContract, via: "projectId" }),
      methods: {
        ...crud.handlers(rows, { access: { get: { entry: "Read" }, list: "authenticated" } }),
      },
    });
    const app = await createTestApp({ services: [projectService, service], db: kit.harness().db });
    kit.track(app as unknown as TestApp);
    return app as unknown as TestApp;
  }

  type RowCaller = {
    rowService: {
      list(input?: object): Promise<{ items: Record<string, unknown>[] }>;
      get(input: object): Promise<Record<string, unknown>>;
    };
  };

  it("are stripped at the level the page was read at; a service-wide Admin sees every field", async () => {
    const app = await serve();
    const board = kit.board();
    await kit.harness().prisma.task.update({ where: { id: board.t1 }, data: { notes: "secret" } });
    const owner = app.as(as(board.ada)) as unknown as RowCaller;
    const [item] = (await owner.rowService.list()).items;
    expect(Object.keys(item ?? {}).sort()).toEqual(
      Object.keys(taskEntity.shape)
        .filter((key) => key !== "notes")
        .sort(),
    );
    expect(item?.updatedAt).toEqual(expect.any(String));
    // The owner's own row read through get carries the tiered field.
    expect(await owner.rowService.get({ id: board.t1 })).toMatchObject({ notes: "secret" });
    const admin = app.as(as(board.cy, { rowService: "Admin" })) as unknown as RowCaller;
    expect((await admin.rowService.list()).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: board.t1, notes: "secret" })]),
    );
  });

  it("answers a missing row of get with NOT_FOUND", async () => {
    const app = await serve();
    const admin = app.as(as(kit.board().cy, { rowService: "Admin" })) as unknown as RowCaller;
    await expect(admin.rowService.get({ id: "missing" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });
});

describe("statements", () => {
  it("costs one statement for get and at most two for list", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const { storage } = kit.harness();
    await addTasks(kit.harness().prisma, board.p1, [1, 2, 3]);
    const count = async (call: () => Promise<unknown>) =>
      (await storage.countStatements(call)).statements;
    const admin = app.as(as(board.ed, { taskService: "Admin" })).taskService;
    const owner = app.as(as(board.ada)).taskService;
    // Warm up: the storage adapter asks once per process whether an order column may hold null.
    await admin.list();
    // A service-wide Admin grant needs no access read: the handler's own statements only.
    expect(await count(() => admin.get({ id: board.t1 }))).toBe(1);
    expect(await count(() => admin.list({ limit: 2 }))).toBe(1);
    expect(await count(() => admin.list({ limit: 2, totalCount: true }))).toBe(2);
    // The board's task policy inherits the project's: its list filter reads the
    // projects the owner may read (members, then the projects), then the page.
    expect(await count(() => owner.list({ limit: 2 }))).toBe(3);
    expect(await count(() => owner.list({ limit: 2, totalCount: true }))).toBe(4);
  });
});
