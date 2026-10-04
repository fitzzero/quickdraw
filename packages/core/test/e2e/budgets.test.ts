// The fixture app's performance budgets (RFC 0003 section 13): what the
// common paths cost, in database statements and bytes, kept in
// `__budgets__/budgets.test.ts.json` beside this file. A change that makes
// one of them cost more fails here with the old and new numbers; run with
// QD_ALLOW_BUDGET_GROWTH=1 to accept it, and commit the file.
//
// The numbers hold on PGlite and PostgreSQL alike: statements are counted
// where the tracked client runs them, and bytes may move by 5% (ids and
// revisions keep their lengths). Each step measures the server's whole work:
// access checks, handlers, flushes and subscription reads.
//
// The cluster projects measure the same steps on two nodes behind Valkey
// (both nodes' statements and bytes) and keep them apart, in
// `__budgets__/budgets.cluster.ts.json`: a cluster node reads every touched
// row and scope, and sends changes whole (docs/deploying.md).

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineContract, via } from "../../src/index";
import { qd } from "../../src/server/emit/__tests__/live";
import { storageOf } from "../../src/server/storage";
import { emitWithAck, expectBudget } from "../../src/testing/index";
import { inCluster } from "../cluster/mode";
import { as, e2eApp } from "../fixtures/app";

const e2e = e2eApp();

/**
 * Each member's projects with their member count, through the membership
 * table: a `via` collection whose item reads the junction (`refreshEntry`),
 * the shape of a chat list with `memberCount`.
 */
const myProjectsContract = defineContract("myProjectsService", {
  entity: z.object({ id: z.string(), name: z.string() }),
  projections: {
    summary: z.object({ id: z.string(), name: z.string(), memberCount: z.number() }),
  },
  methods: {},
  collections: {
    mine: {
      scope: via({
        model: "projectMember",
        entry: "projectId",
        scope: "userId",
        refreshEntry: true,
      }),
      item: "summary",
      order: [["id", "asc"]],
    },
  },
});

const myProjectsService = qd.defineService(myProjectsContract, {
  model: "project",
  collections: { mine: { scopeAccess: "self" } },
  project: {
    summary: {
      select: { name: true, _count: { select: { members: true } } },
      map: (row: { id: string; name: string; _count: { members: number } }) => ({
        id: row.id,
        name: row.name,
        memberCount: row._count.members,
      }),
    },
  },
  methods: {},
});

/** A step's budget options: in the cluster projects, kept in the cluster's own budget file. */
function step(name: string): { readonly name: string; readonly file?: string } {
  return inCluster()
    ? { name, file: fileURLToPath(new URL("./budgets.cluster.ts", import.meta.url)) }
    : { name };
}

/** P1's tasks: "Task 1" to "Task 60", in order, written untracked; their ids in that order. */
async function seedTasks(projectId: string, count: number): Promise<string[]> {
  const prisma = e2e.prisma();
  await prisma.task.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      projectId,
      title: `Task ${index + 1}`,
      ordinal: (index + 1) * 1024,
    })),
  });
  const rows = await prisma.task.findMany({
    where: { projectId, title: { startsWith: "Task " } },
    orderBy: { ordinal: "asc" },
    select: { id: true },
  });
  return rows.map((row) => row.id);
}

/**
 * Starts the app with the one-off reads a process makes once behind it (the
 * storage adapter asks once whether an order column may hold null), so a
 * budget does not depend on which test ran first.
 */
async function start(options?: Parameters<typeof e2e.start>[0]) {
  const started = await e2e.start(options);
  await started.write(async (db) => {
    await storageOf(db)?.nullable?.("task", "ordinal");
  });
  return started;
}

describe("the fixture app's budgets", () => {
  it("subscribes to 60 tasks", async () => {
    const { app } = await start();
    const board = e2e.board();
    const ids = await seedTasks(board.p1, 60);
    const { socket } = await app.connect(as(board.ada));
    let reply: { readonly ok: boolean; readonly results?: readonly unknown[] } | undefined;
    const { measured } = await expectBudget(async () => {
      reply = await emitWithAck(socket, "qd:sub", { s: "taskService", ids });
    }, step("subscribe to 60 tasks"));
    expect(reply?.ok).toBe(true);
    expect(measured.calls).toEqual([]);
  });

  it("sends a collection's first snapshot", async () => {
    const { app } = await start();
    const board = e2e.board();
    await seedTasks(board.p1, 60);
    const { socket } = await app.connect(as(board.ada));
    let reply: { readonly ok: boolean; readonly total?: number } | undefined;
    await expectBudget(async () => {
      reply = await emitWithAck(socket, "qd:col:sub", {
        s: "taskService",
        c: "board",
        scope: board.p1,
      });
    }, step("first collection snapshot"));
    expect(reply).toMatchObject({ ok: true, total: 61 });
  });

  it("updates a task one client subscribes to", async () => {
    const { app } = await start();
    const board = e2e.board();
    const { socket } = await app.connect(as(board.ada));
    await emitWithAck(socket, "qd:sub", { s: "taskService", ids: [board.t1] });
    app.frames.clear();
    const { measured } = await expectBudget(async () => {
      await app.as(as(board.bo)).taskService.rename({ id: board.t1, title: "Renamed" });
      await app.frames.waitFor({ event: "qd:e", userId: board.ada });
    }, step("one update with one subscriber"));
    expect(measured.calls.map((call) => call.call)).toEqual(["taskService.rename"]);
  });

  it("sends a refreshEntry via item again when its junction changes", async () => {
    const { app, write } = await start({ services: [myProjectsService] });
    const board = e2e.board();
    const { socket } = await app.connect(as(board.bo));
    const page = await emitWithAck(socket, "qd:col:sub", {
      s: "myProjectsService",
      c: "mine",
      scope: board.bo,
    });
    expect(page).toMatchObject({ ok: true, items: [{ id: board.p1, memberCount: 2 }] });
    app.frames.clear();
    // A new member: their own scope gets `added` (nobody subscribes to it), and the member
    // count goes out again to bo's: one read of the entry's item more than a plain via collection.
    await expectBudget(async () => {
      await write((db) =>
        db.projectMember.create({ data: { projectId: board.p1, userId: board.ed, role: "Read" } }),
      );
      await app.frames.waitFor({ event: "qd:c", userId: board.bo });
    }, step("junction write refreshing a via item"));
    expect(app.frames({ event: "qd:c" }).map(({ userId, data }) => ({ userId, data }))).toEqual([
      {
        userId: board.bo,
        data: expect.objectContaining({
          deltas: [{ t: "updated", item: { id: board.p1, name: "P1", memberCount: 3 } }],
        }),
      },
    ]);
  });

  it("lists a page of tasks with the read/write kit", async () => {
    const { app } = await start();
    const board = e2e.board();
    await seedTasks(board.p1, 60);
    let page: { readonly items: readonly unknown[] } | undefined;
    await expectBudget(async () => {
      page = await app
        .as(as(board.ada))
        .taskService.list({ filter: { projectId: board.p1 }, limit: 20 });
    }, step("kit list"));
    expect(page?.items).toHaveLength(20);
  });

  it("searches task titles with the search kit", async () => {
    const { app } = await start();
    const board = e2e.board();
    await seedTasks(board.p1, 60);
    let found: { readonly items: readonly unknown[] } | undefined;
    await expectBudget(async () => {
      found = await app.as(as(board.ada)).taskService.search({ q: "Task 1" });
    }, step("kit search"));
    // "Task 1" and "Task 10" to "Task 19".
    expect(found?.items).toHaveLength(11);
  });
});
