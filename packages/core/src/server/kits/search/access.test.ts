// The search kit's access (RFC 0003 sections 4.3 and 12.2), through a real
// server against PGlite: the access matrix of its methods for the board's
// owner, member, reader and stranger, a scope form checked on the scope's
// anchor, then the rows each principal finds. Verify these first: a search
// must never show a row `get` would refuse.

import { describe, expect, it } from "vitest";
import { describeAccessMatrix, createTestApp, type TestApp } from "../../../testing/index";
import { labelContract, labelService } from "../../collections/__tests__/fixture";
import { projectContract, projectService, qd } from "../../emit/__tests__/live";
import { inherit, search } from "../../index";
import { addTasks, as, idsOf, searchApp, searchContract } from "./__tests__/fixture";

const kit = searchApp();

function principals() {
  const board = kit.board();
  return {
    owner: as(board.ada),
    member: as(board.bo),
    reader: as(board.cy),
    stranger: as(board.ed),
  };
}

/** Serves the project, label and task services, the task service built from `methods`. */
async function serve(methods: Readonly<Record<string, unknown>>) {
  const service = qd.defineService(searchContract, {
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    collections: { board: { anchor: projectContract }, byLabel: { anchor: labelContract } },
    methods: methods as never,
  });
  const app = await createTestApp({
    services: [projectService, labelService, service],
    db: kit.harness().db,
  });
  kit.track(app as unknown as TestApp);
  return { app, service };
}

describe("the access matrix", () => {
  it("lets every signed-in principal search, and refuses an anonymous one", async () => {
    const { app, service } = await kit.start();
    const board = kit.board();
    const everyone = ["owner", "member", "reader", "stranger"] as const;
    const report = await describeAccessMatrix(app, {
      service,
      principals: principals(),
      cases: [
        { method: "search", input: { q: "T1" }, allow: [...everyone] },
        {
          method: "search",
          label: "search in P1",
          input: { q: "T1", scope: board.p1 },
          allow: [...everyone],
        },
        { method: "searchByLabel", input: { q: "T", scope: "no-label" }, allow: [...everyone] },
      ],
    });
    expect(report.cells).toHaveLength(3 * 5);
    expect(report.cells.filter((cell) => cell.principal === "anonymous")).toSatisfy((cells) =>
      (cells as { actual: string }[]).every((cell) => cell.actual === "UNAUTHENTICATED"),
    );
  });

  it("checks a scope form on the scope's anchor, method by method", async () => {
    const board = kit.board();
    const { app, service } = await serve({
      ...search.handlers(searchContract, {
        method: "search",
        access: { scope: "Read", of: projectContract, id: (input) => input.scope ?? "" },
      }),
      ...search.handlers(searchContract, { method: "searchByLabel", access: "authenticated" }),
    });
    await describeAccessMatrix(app, {
      service,
      principals: principals(),
      cases: [
        {
          method: "search",
          label: "search in P1",
          input: { q: "T1", scope: board.p1 },
          allow: ["owner", "member", "reader"],
        },
        {
          method: "search",
          label: "search in P2",
          input: { q: "T2", scope: board.p2 },
          allow: ["stranger"],
        },
        // No scope: no row to check the level on.
        { method: "search", label: "search anywhere", input: { q: "T1" }, allow: [] },
        {
          method: "searchByLabel",
          input: { q: "T", scope: "no-label" },
          allow: ["owner", "member", "reader", "stranger"],
        },
      ],
    });
  });
});

describe("the rows found", () => {
  it("are only those each principal can read", async () => {
    const { app } = await kit.start();
    const board = kit.board();
    await addTasks(kit.harness().prisma, board.p2, [1, 2], { title: "Shared word" });
    await addTasks(kit.harness().prisma, board.p1, [3], { title: "Shared word" });
    const projectsOf = async (principal: ReturnType<typeof as>) =>
      (await app.as(principal).taskService.search({ q: "shared", limit: 100 })).items.map(
        (item) => item.projectId,
      );
    expect(await projectsOf(as(board.ada))).toEqual([board.p1]);
    expect(await projectsOf(as(board.bo))).toEqual([board.p1]);
    expect(await projectsOf(as(board.cy))).toEqual([board.p1]);
    expect(await projectsOf(as(board.di))).toEqual([board.p1]);
    expect(await projectsOf(as(board.ed))).toEqual([board.p2, board.p2]);
    // A service-wide Admin grant reads every row; a lower grant does not.
    expect(await projectsOf(as(board.cy, { taskService: "Admin" }))).toHaveLength(3);
    expect(await projectsOf(as(board.cy, { taskService: "Moderate" }))).toEqual([board.p1]);
    await expect(app.as(null).taskService.search({ q: "shared" })).rejects.toMatchObject({
      code: "UNAUTHENTICATED",
    });
  });

  it("of a public search are every row, read and matched without the tiered fields", async () => {
    const board = kit.board();
    const { app } = await serve({
      ...search.handlers(searchContract, { access: "public" }),
    });
    const prisma = kit.harness().prisma;
    const [secret = ""] = await addTasks(prisma, board.p2, [1], { title: "Visible title" });
    await prisma.task.update({ where: { id: secret }, data: { notes: "classified plan" } });
    const anonymous = app.as(null).taskService;
    expect(idsOf(await anonymous.search({ q: "visible" }))).toEqual([secret]);
    // `notes` is Admin-only, so no public search looks in it.
    expect(idsOf(await anonymous.search({ q: "classified" }))).toEqual([]);
  });
});
