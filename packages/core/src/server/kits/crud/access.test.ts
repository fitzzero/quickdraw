// The read/write kit's access (RFC 0003 sections 4 and 12.1), through a real
// server against PGlite: the access matrix of every kit method for the
// board's owner, member, reader and stranger, then the rows the methods on
// many rows keep for each of them. Verify these first: the kit replaces
// hand-written methods, so its access behavior is the thing to get right.

import { describe, expect, it } from "vitest";
import { defineContract } from "../../../index";
import { describeAccessMatrix } from "../../../testing/index";
import { projectContract, projectService, qd } from "../../emit/__tests__/live";
import { createTestApp, type TestApp } from "../../../testing/index";
import { crud, custom, inherit } from "../../index";
import { rowLevel } from "./access";
import { addTasks, as, kitApp, taskEntity } from "./__tests__/fixture";

const kit = kitApp();

function principals() {
  const board = kit.board();
  return {
    owner: as(board.ada),
    member: as(board.bo),
    reader: as(board.cy),
    stranger: as(board.ed),
  };
}

describe("the access matrix", () => {
  it("runs every kit method as the owner, a member, a reader, a stranger and anonymously", async () => {
    const { app, service } = await kit.start();
    const board = kit.board();
    const [other = ""] = await addTasks(kit.harness().prisma, board.p1, [5]);
    const report = await describeAccessMatrix(app, {
      service,
      principals: principals(),
      cases: [
        { method: "get", input: { id: board.t1 }, allow: ["owner", "member", "reader"] },
        {
          method: "getMany",
          input: { ids: [board.t1, board.t2] },
          allow: ["owner", "member", "reader", "stranger"],
        },
        { method: "list", input: {}, allow: ["owner", "member", "reader", "stranger"] },
        {
          method: "create",
          input: { projectId: board.p1, title: "Made" },
          allow: ["owner", "member"],
        },
        { method: "update", input: { id: board.t1, title: "Renamed" }, allow: ["owner", "member"] },
        { method: "reorder", input: { id: board.t1, afterId: other }, allow: ["owner", "member"] },
        {
          method: "bulkUpdate",
          input: { ids: [board.t1, board.t2], data: { status: "done" } },
          allow: ["owner", "member", "reader", "stranger"],
        },
      ],
    });
    expect(report.cells).toHaveLength(7 * 5);
    expect(report.cells.filter((cell) => cell.principal === "anonymous")).toSatisfy((cells) =>
      (cells as { actual: string }[]).every((cell) => cell.actual === "UNAUTHENTICATED"),
    );
  });

  it("makes each cell's input afresh with a factory, so the order of principals does not matter", async () => {
    const { app, service } = await kit.start();
    const board = kit.board();
    const made: string[] = [];
    const report = await describeAccessMatrix(app, {
      service,
      // The allowed principals come first: each cell deletes a row of its own.
      principals: principals(),
      cases: [
        {
          method: "delete",
          input: async ({ name, principal }) => {
            const [id = ""] = await addTasks(kit.harness().prisma, board.p1, [made.length]);
            made.push(`${name}:${principal?.userId ?? "none"}`);
            return { id };
          },
          allow: ["owner", "member"],
        },
      ],
    });
    expect(report.cells.map((cell) => [cell.principal, cell.actual])).toEqual([
      ["owner", "allow"],
      ["member", "allow"],
      ["reader", "FORBIDDEN"],
      ["stranger", "FORBIDDEN"],
      ["anonymous", "UNAUTHENTICATED"],
    ]);
    expect(made).toEqual([
      `owner:${board.ada}`,
      `member:${board.bo}`,
      `reader:${board.cy}`,
      `stranger:${board.ed}`,
      "anonymous:none",
    ]);
  });

  it("deletes for the owner and a member only, one row each", async () => {
    const { app, service } = await kit.start();
    const board = kit.board();
    const [first = "", second = ""] = await addTasks(kit.harness().prisma, board.p1, [1, 2]);
    const { owner, member, reader, stranger } = principals();
    // A deleted row is gone for whoever comes next, so the allowed principal goes last.
    await describeAccessMatrix(app, {
      service,
      principals: { reader, stranger, member },
      cases: [{ method: "delete", input: { id: first }, allow: ["member"] }],
    });
    await describeAccessMatrix(app, {
      service,
      principals: { reader, stranger, owner },
      cases: [
        { method: "delete", input: { id: second }, allow: ["owner"] },
        {
          method: "bulkDelete",
          input: { ids: [board.t1, board.t2] },
          allow: ["reader", "stranger", "owner"],
        },
      ],
    });
    const left = await kit.harness().prisma.task.findMany({ select: { id: true } });
    // The stranger owns P2, so its bulk delete took T2; the owner's took T1.
    expect(left).toEqual([]);
  });
});

describe("rows on many-row methods", () => {
  it("lists only the rows each principal can read", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    await addTasks(kit.harness().prisma, board.p2, [1, 2]);
    const idsOf = async (principal: ReturnType<typeof as>) =>
      (await app.as(principal).taskService.list({ limit: 200 })).items.map(
        (item) => item.projectId,
      );
    expect(await idsOf(as(board.ada))).toEqual([board.p1]);
    expect(await idsOf(as(board.cy))).toEqual([board.p1]);
    expect(await idsOf(as(board.di))).toEqual([board.p1]);
    expect(await idsOf(as(board.ed))).toEqual([board.p2, board.p2, board.p2]);
    // A filter cannot reach past the access filter.
    expect(
      (await app.as(as(board.cy)).taskService.list({ filter: { projectId: board.p2 } })).items,
    ).toEqual([]);
    // A service-wide Admin grant reads every row; a lower grant does not.
    expect(await idsOf(as(board.cy, { taskService: "Admin" }))).toHaveLength(4);
    expect(await idsOf(as(board.cy, { taskService: "Moderate" }))).toEqual([board.p1]);
    await expect(app.as(null).taskService.list()).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("leaves out of getMany the ids a principal cannot read and ids with no row, in the order asked", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const [mine = ""] = await addTasks(kit.harness().prisma, board.p1, [3]);
    const ids = [board.t2, mine, "missing", board.t1, mine];
    const got = async (principal: ReturnType<typeof as>) =>
      (await app.as(principal).taskService.getMany({ ids })).map((row) => row.id);
    expect(await got(as(board.cy))).toEqual([mine, board.t1]);
    expect(await got(as(board.ed))).toEqual([board.t2]);
    expect(await got(as(board.ed, { taskService: "Admin" }))).toEqual([board.t2, mine, board.t1]);
    expect(await app.as(as(board.cy)).taskService.getMany({ ids: [] })).toEqual([]);
    // Field tiers apply per row, as for any projection output: the owner has Admin on T1.
    const member = await app.as(as(board.bo)).taskService.getMany({ ids: [board.t1] });
    expect(member[0]).not.toHaveProperty("notes");
    const owner = await app.as(as(board.ada)).taskService.getMany({ ids: [board.t1] });
    expect(owner[0]).toHaveProperty("notes", null);
  });

  it("bulk-writes only the rows a principal may write, and counts them", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    const prisma = kit.harness().prisma;
    const ids = [board.t1, board.t2, "missing"];
    const update = (principal: ReturnType<typeof as>) =>
      app.as(principal).taskService.bulkUpdate({ ids, data: { status: "done" } });
    // Read is below the write level (Moderate): nothing changes.
    expect(await update(as(board.cy))).toEqual({ count: 0 });
    expect(await update(as(board.bo))).toEqual({ count: 1 });
    const statuses = await prisma.task.findMany({ select: { id: true, status: true } });
    expect(Object.fromEntries(statuses.map((row) => [row.id, row.status]))).toEqual({
      [board.t1]: "done",
      [board.t2]: "open",
    });
    expect(await app.as(as(board.bo)).taskService.bulkDelete({ ids })).toEqual({ count: 1 });
    expect(await prisma.task.findMany({ select: { id: true } })).toEqual([{ id: board.t2 }]);
    expect(
      await app.as(as(board.cy, { taskService: "Admin" })).taskService.bulkDelete({ ids }),
    ).toEqual({ count: 1 });
  });
});

describe("the row level", () => {
  it("is the form's entry or scope level, else the method's", () => {
    expect(rowLevel({ entry: "Admin", id: "ids" }, "Moderate")).toBe("Admin");
    expect(rowLevel({ scope: "Read", of: projectContract, id: "projectId" }, "Moderate")).toBe(
      "Read",
    );
    expect(rowLevel({ service: "Admin" }, "Read")).toBe("Read");
    expect(rowLevel("authenticated", "Moderate")).toBe("Moderate");
    expect(
      rowLevel(
        custom(() => true),
        "Read",
      ),
    ).toBe("Read");
  });
});

describe("forms without row checks", () => {
  const notes = defineContract("noteService", {
    entity: taskEntity,
    fields: { notes: "Admin" },
    methods: {
      ...crud.contract({
        entity: taskEntity,
        getMany: true,
        list: { filter: ["projectId"] },
        bulkDelete: true,
      }),
    },
  });

  async function serve(service: ReturnType<typeof qd.defineService>): Promise<TestApp> {
    const app = await createTestApp({ services: [projectService, service], db: kit.harness().db });
    kit.track(app as unknown as TestApp);
    return app as unknown as TestApp;
  }

  it("lists every row of a public method, to anyone", async () => {
    const app = await serve(
      qd.defineService(notes, {
        model: "task",
        access: inherit({ from: projectContract, via: "projectId" }),
        methods: {
          ...crud.handlers(notes, {
            access: { getMany: "public", list: "public", bulkDelete: "public" },
          }),
        },
      }),
    );
    const board = kit.board();
    const caller = app.as(null) as unknown as {
      noteService: {
        list(input?: object): Promise<{ items: { id: string; notes?: unknown }[] }>;
        getMany(input: object): Promise<{ id: string }[]>;
        bulkDelete(input: object): Promise<{ count: number }>;
      };
    };
    const page = await caller.noteService.list();
    expect(page.items.map((item) => item.id).sort()).toEqual([board.t1, board.t2].sort());
    // Rows no policy checked carry no tiered field.
    expect(page.items[0]).not.toHaveProperty("notes");
    expect(
      (await caller.noteService.getMany({ ids: [board.t1, board.t2] })).map((row) => row.id),
    ).toEqual([board.t1, board.t2]);
    // Reads are public; a write still needs a level on each row, which no one anonymous has.
    expect(await caller.noteService.bulkDelete({ ids: [board.t1, board.t2] })).toEqual({
      count: 0,
    });
    const signedIn = app.as(as(board.bo)) as unknown as typeof caller;
    expect(await signedIn.noteService.bulkDelete({ ids: [board.t1, board.t2] })).toEqual({
      count: 1,
    });
  });

  it("is the whole check on a service without a policy, which takes only public or { service }", async () => {
    const unpoliced = (form: "authenticated" | { readonly service: "Read" }) =>
      qd.defineService(notes, {
        model: "task",
        methods: {
          ...crud.handlers(notes, {
            access: { getMany: form, list: form, bulkDelete: form },
          }),
        },
      });
    // Every row is reached: the form must say so outright.
    expect(() => unpoliced("authenticated")).toThrow(
      /method "getMany": getMany reaches every row of noteService, which declares no access policy/,
    );
    expect(() =>
      qd.defineService(notes, {
        model: "task",
        methods: {
          ...crud.handlers(notes, {
            access: {
              getMany: "public",
              list: { service: "Read" },
              bulkDelete: custom(() => true),
            },
          }),
        },
      }),
    ).toThrow(/method "bulkDelete": bulkDelete reaches every row/);
    const app = await serve(unpoliced({ service: "Read" }));
    const board = kit.board();
    type NoteCaller = {
      noteService: {
        list(input?: object): Promise<{ items: { id: string }[] }>;
        bulkDelete(input: object): Promise<{ count: number }>;
      };
    };
    const granted = app.as(as(board.cy, { noteService: "Read" })) as unknown as NoteCaller;
    expect((await granted.noteService.list()).items).toHaveLength(2);
    expect(await granted.noteService.bulkDelete({ ids: [board.t1, board.t2] })).toEqual({
      count: 2,
    });
    const ungranted = app.as(as(board.cy)) as unknown as NoteCaller;
    await expect(ungranted.noteService.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("a service-wide grant the form names", () => {
  const graded = defineContract("taskService", {
    entity: taskEntity,
    fields: { notes: "Moderate" },
    methods: {
      ...crud.contract({ entity: taskEntity, getMany: true, list: { sort: ["title"] } }),
    },
  });

  it("is a row level of its level on every row: list and getMany are unfiltered, stripped at the grant", async () => {
    const service = qd.defineService(graded, {
      model: "task",
      access: inherit({ from: projectContract, via: "projectId" }),
      methods: {
        ...crud.handlers(graded, {
          access: { getMany: { service: "Read" }, list: { service: "Read" } },
        }),
      },
    });
    const app = await createTestApp({ services: [projectService, service], db: kit.harness().db });
    kit.track(app as unknown as TestApp);
    const board = kit.board();
    const prisma = kit.harness().prisma;
    await prisma.task.updateMany({ data: { notes: "graded" } });
    // Gus holds no level on either project; his grant reaches both.
    const gus = (await prisma.user.create({ data: { email: "gus@example.com", name: "Gus" } })).id;
    const reader = app.as(as(gus, { taskService: "Read" })).taskService;
    const page = await reader.list({});
    expect(page.items.map((item) => item.id).sort()).toEqual([board.t1, board.t2].sort());
    expect(page.items.every((item) => !("notes" in item))).toBe(true);
    expect((await reader.getMany({ ids: [board.t1, board.t2] })).map((row) => row.id)).toEqual([
      board.t1,
      board.t2,
    ]);
    // A Moderate grant is a Moderate row level: the Moderate-only notes show.
    const moderator = app.as(as(gus, { taskService: "Moderate" })).taskService;
    expect((await moderator.list({})).items.map((item) => item.notes)).toEqual([
      "graded",
      "graded",
    ]);
    // Without the grant the form refuses.
    await expect(app.as(as(gus)).taskService.list({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("a write on one row", () => {
  const writes = defineContract("taskService", {
    entity: taskEntity,
    methods: {
      ...crud.contract({
        entity: taskEntity,
        update: { input: taskEntity.pick({ title: true }).partial() },
        delete: true,
        reorder: { column: "ordinal", within: "projectId" },
      }),
    },
  });

  async function serveWrites(form: "authenticated" | { readonly service: "Moderate" }) {
    const service = qd.defineService(writes, {
      model: "task",
      access: inherit({ from: projectContract, via: "projectId" }),
      methods: {
        ...crud.handlers(writes, { access: { update: form, delete: form, reorder: form } }),
      },
    });
    const app = await createTestApp({ services: [projectService, service], db: kit.harness().db });
    kit.track(app as unknown as TestApp);
    return app;
  }

  it("needs the row level on the row whatever the form says: update: authenticated edits no row", async () => {
    const app = await serveWrites("authenticated");
    const board = kit.board();
    const [other = ""] = await addTasks(kit.harness().prisma, board.p1, [5]);
    // Cy reads P1; Ed has nothing on it. Neither moderates T1.
    for (const userId of [board.cy, board.ed]) {
      const caller = app.as(as(userId)).taskService;
      for (const call of [
        caller.update({ id: board.t1, title: "Mine now" }),
        caller.reorder({ id: board.t1, afterId: other }),
        caller.delete({ id: board.t1 }),
      ]) {
        await expect(call).rejects.toMatchObject({ code: "FORBIDDEN" });
      }
    }
    // Bo moderates P1.
    const bo = app.as(as(board.bo)).taskService;
    expect(await bo.update({ id: board.t1, title: "Moderated" })).toMatchObject({
      title: "Moderated",
    });
    expect(await bo.reorder({ id: board.t1, afterId: other })).toMatchObject({ id: board.t1 });
    expect(await bo.delete({ id: board.t1 })).toBeNull();
  });

  it("counts a service-wide grant the form names as that row level on every row", async () => {
    const app = await serveWrites({ service: "Moderate" });
    const board = kit.board();
    // Ed holds nothing on P1, but a Moderate grant.
    const ed = app.as(as(board.ed, { taskService: "Moderate" })).taskService;
    expect(await ed.update({ id: board.t1, title: "Granted" })).toMatchObject({ title: "Granted" });
    expect(await ed.delete({ id: board.t1 })).toBeNull();
  });
});
