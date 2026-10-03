// The search kit's access (RFC 0003 sections 4.3 and 12.2), through a real
// server against PGlite: the access matrix of its methods for the board's
// owner, member, reader and stranger, a scope form checked on the scope's
// anchor, the rows each principal finds, and a scope authorized as
// `qd:col:sub` authorizes it. Verify these first: a search must never show a
// row `get` would refuse, nor a scope the caller could not open.

import { describe, expect, it } from "vitest";
import {
  describeAccessMatrix,
  createTestApp,
  emitWithAck,
  type TestApp,
} from "../../../testing/index";
import { labelContract, labelService } from "../../collections/__tests__/fixture";
import { projectContract, projectService, qd } from "../../emit/__tests__/live";
import { custom, inherit, search } from "../../index";
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

/** A label of P1, with nothing on it. */
async function labelOfP1(): Promise<string> {
  const board = kit.board();
  const label = await kit
    .harness()
    .prisma.label.create({ data: { projectId: board.p1, name: "L" } });
  return label.id;
}

describe("the access matrix", () => {
  it("lets every signed-in principal search, in the scopes they may open, and refuses an anonymous one", async () => {
    const { app, service } = await kit.start();
    const board = kit.board();
    const label = await labelOfP1();
    const everyone = ["owner", "member", "reader", "stranger"] as const;
    const report = await describeAccessMatrix(app, {
      service,
      principals: principals(),
      cases: [
        { method: "search", input: { q: "T1" }, allow: [...everyone] },
        // A scope is authorized as qd:col:sub authorizes it: Read on its project.
        {
          method: "search",
          label: "search in P1",
          input: { q: "T1", scope: board.p1 },
          allow: ["owner", "member", "reader"],
        },
        {
          method: "searchByLabel",
          input: { q: "T", scope: label },
          allow: ["owner", "member", "reader"],
        },
        // A label that is not there gives no level.
        {
          method: "searchByLabel",
          label: "searchByLabel of no label",
          input: { q: "T", scope: "no-label" },
          allow: [],
        },
      ],
    });
    expect(report.cells).toHaveLength(4 * 5);
    expect(report.cells.filter((cell) => cell.principal === "anonymous")).toSatisfy((cells) =>
      (cells as { actual: string }[]).every((cell) => cell.actual === "UNAUTHENTICATED"),
    );
  });

  it("checks a scope form on the scope's anchor, method by method", async () => {
    const board = kit.board();
    const label = await labelOfP1();
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
          input: { q: "T", scope: label },
          allow: ["owner", "member", "reader"],
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

  it("of a { service } search are every row for a grant that meets it, a row level on each", async () => {
    const board = kit.board();
    const { app } = await serve({
      ...search.handlers(searchContract, { access: { service: "Read" } }),
    });
    await addTasks(kit.harness().prisma, board.p1, [3], { title: "Shared word" });
    await addTasks(kit.harness().prisma, board.p2, [3], { title: "Shared word" });
    // Ed holds nothing on P1; his Read grant reaches it.
    const ed = app.as(as(board.ed, { taskService: "Read" })).taskService;
    const found = await ed.search({ q: "shared" });
    expect(found.items.map((item) => item.projectId).sort()).toEqual([board.p1, board.p2].sort());
    await expect(app.as(as(board.ed)).taskService.search({ q: "shared" })).rejects.toMatchObject({
      code: "FORBIDDEN",
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

describe("a scoped search", () => {
  // The service reaches its rows through the board collection only: no row policy of its own.
  const unpoliced = (access: unknown) =>
    qd.defineService(searchContract, {
      model: "task",
      collections: { board: { anchor: projectContract }, byLabel: { anchor: labelContract } },
      methods: { ...search.handlers(searchContract, { access: access as "public" }) },
    });

  it("is authorized as qd:col:sub authorizes its scope, on a service without a row policy too", async () => {
    const board = kit.board();
    const app = await createTestApp({
      services: [projectService, labelService, unpoliced({ service: "Read" })],
      db: kit.harness().db,
    });
    kit.track(app as unknown as TestApp);
    // Ed owns P2 only: his grant lets him search, not open P1.
    const ed = as(board.ed, { taskService: "Read" });
    await expect(app.as(ed).taskService.search({ q: "T1", scope: board.p1 })).rejects.toMatchObject(
      { code: "FORBIDDEN" },
    );
    const socket = await app.connect(ed);
    const sub = await emitWithAck(socket.socket, "qd:col:sub", {
      s: "taskService",
      c: "board",
      scope: board.p1,
    });
    expect(sub).toMatchObject({ ok: false, e: { code: "FORBIDDEN" } });
    // Ada owns P1.
    const ada = app.as(as(board.ada, { taskService: "Read" })).taskService;
    expect(idsOf(await ada.search({ q: "T1", scope: board.p1 }))).toEqual([board.t1]);
    // Without a scope, a { service } search reaches every row: the form says so.
    const prisma = kit.harness().prisma;
    const shared = [
      ...(await addTasks(prisma, board.p1, [1], { title: "Shared word" })),
      ...(await addTasks(prisma, board.p2, [1], { title: "Shared word" })),
    ];
    expect(idsOf(await app.as(ed).taskService.search({ q: "shared" })).sort()).toEqual(
      shared.sort(),
    );
  });

  it("needs a principal, even in a public search", async () => {
    const board = kit.board();
    const { app } = await serve({ ...search.handlers(searchContract, { access: "public" }) });
    await expect(
      app.as(null).taskService.search({ q: "T1", scope: board.p1 }),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    expect(idsOf(await app.as(null).taskService.search({ q: "T1" }))).toEqual([board.t1]);
  });

  it("of a service without a row policy is refused when it is defined, unless its form is public or { service }", () => {
    const refused = /search reaches every row of taskService, which declares no access policy/;
    expect(() => unpoliced("authenticated")).toThrow(refused);
    expect(() => unpoliced(custom(() => true))).toThrow(refused);
    const scope = (input: { readonly scope?: string }): string => input.scope ?? "";
    expect(() => unpoliced({ scope: "Read", of: projectContract, id: scope })).toThrow(refused);
    expect(() => unpoliced("public")).not.toThrow();
    expect(() => unpoliced({ service: "Read" })).not.toThrow();
  });
});
