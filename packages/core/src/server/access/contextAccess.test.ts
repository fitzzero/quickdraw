// `ctx.access` (RFC 0003 section 4.3): `dispatcher.access` bound to the
// caller of one call, through a real server against PGlite, on the access
// tests' board. It counts levels as the forms do: `can` agrees with an
// `{ entry }` form for a member, a non-member and a service-wide `Admin`; a
// `custom` form checks a parent row with it, or a row its key names only
// sometimes; `where` filters exactly the rows `can` allows; an anonymous
// caller has no level anywhere; MCP calls and `ctx.services` calls ask as
// their own caller; and a context no dispatcher built refuses it.
//
//            owner   access list    members
//   P1       ada     di: Read       bo: Moderate, cy: Read
//   P2       ed      -              -
//   P3       bo      di: Moderate   -
//   T1 in P1, T2 in P2

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../../test/prisma/setup";
import { defineContract, listOf, mutation, query, type AccessLevel } from "../../index";
import { consoleLogger, type Logger } from "../../contract/logger";
import { QuickdrawError } from "../../protocol/errors";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { createTestApp, type TestApp } from "../../testing/index";
import { captureLogger } from "../__tests__/fixtures";
import { createContext, NEVER_ABORTED } from "../context";
import { createMcpRegistry } from "../mcp/index";
import { anyOf, custom, inherit, initQuickdraw, jsonAcl, type Principal } from "../index";
import { as, projectMembers, seedBoard, type Board } from "./__tests__/board";

const level = z.enum(["Read", "Moderate", "Admin"]);

/** What `probe` answers: `ctx.access` on the projects it names, as its caller. */
const answer = z.object({
  levels: z.record(z.string(), z.string().nullable()),
  can: z.array(z.boolean()),
  visible: z.array(z.string()),
});

const projects = defineContract("projectService", {
  entity: z.object({ id: z.string(), name: z.string() }),
  methods: {
    // the form decides: Moderate on the project
    moderate: query({ input: z.object({ id: z.string() }), output: z.literal(true) }),
    // ctx.access decides, for anyone, signed in or not
    probe: query({ input: z.object({ projectIds: z.array(z.string()), level }), output: answer }),
  },
});

const tasks = defineContract("taskService", {
  entity: z.object({ id: z.string(), projectId: z.string(), title: z.string() }),
  methods: {
    // a parent the input names: Moderate on the project, through ctx.access
    add: mutation({
      input: z.object({ projectId: z.string(), title: z.string() }),
      output: "entity",
    }),
    // a key that is optional: Read on the project when it names one, else the caller's own tasks
    assigned: query({
      input: z.object({ projectId: z.string().optional() }),
      output: listOf("entity"),
    }),
    // ctx.access through ctx.services: the inner call asks as the outer call's caller
    relay: query({ input: z.object({ projectIds: z.array(z.string()), level }), output: answer }),
    // ctx.access.can with whatever the caller sends, for the refusals
    ask: query({
      input: z.object({ service: z.string(), rowId: z.string(), level: z.string() }),
      output: z.boolean(),
    }),
  },
});

// The contracts typed: an inner call through ctx.services is typed as a client's.
const qd = initQuickdraw<{
  db: PrismaClient;
  principal: Principal;
  contracts: { readonly project: typeof projects; readonly task: typeof tasks };
}>();

const projectService = qd.defineService(projects, {
  model: "project",
  access: anyOf(jsonAcl("acl", { owner: "ownerId" }), projectMembers),
  methods: {
    moderate: { access: { entry: "Moderate" }, handler: () => true as const },
    probe: {
      access: "public",
      handler: async ({ input, ctx, db }) => {
        const levels = await ctx.access.levelsFor(projects, input.projectIds);
        const can = await Promise.all(
          input.projectIds.map(async (id) => await ctx.access.can(projects, id, input.level)),
        );
        // the service may be named by its name too
        const where = await ctx.access.where("projectService", input.level);
        const rows =
          where === "none"
            ? []
            : await db.project.findMany({
                where: where as never,
                select: { id: true },
                orderBy: { id: "asc" },
                take: 100,
              });
        return { levels: Object.fromEntries(levels), can, visible: rows.map((row) => row.id) };
      },
    },
  },
});

const taskService = qd.defineService(tasks, {
  model: "task",
  access: inherit({ from: projects, via: "projectId" }),
  methods: {
    add: {
      access: custom(
        async (ctx, input) => await ctx.access.can(projects, input.projectId, "Moderate"),
      ),
      handler: ({ input, db }) => db.task.create({ data: input }),
    },
    assigned: {
      access: custom(
        async (ctx, input) =>
          input.projectId === undefined ||
          (await ctx.access.can(projects, input.projectId, "Read")),
      ),
      handler: ({ input, ctx, db }) =>
        db.task.findMany({
          where: { assigneeId: ctx.principal.userId, projectId: input.projectId },
          orderBy: { id: "asc" },
          take: 100,
        }),
    },
    relay: {
      access: "authenticated",
      handler: async ({ input, ctx }) => await ctx.services.projectService.probe(input),
    },
    ask: {
      access: "public",
      handler: async ({ input, ctx }) =>
        await ctx.access.can(input.service, input.rowId, input.level as AccessLevel),
    },
  },
});

let h: Harness;
let board: Board & { readonly p3: string };
const apps: TestApp[] = [];

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.database.reset();
  const seeded = await seedBoard(h.prisma);
  const p3 = await h.prisma.project.create({
    data: { name: "P3", ownerId: seeded.bo, acl: [{ userId: seeded.di, level: "Moderate" }] },
  });
  board = { ...seeded, p3: p3.id };
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

async function start(logger?: Logger) {
  const app = await createTestApp({
    services: [projectService, taskService],
    db: h.db,
    ...(logger === undefined ? {} : { logger }),
  });
  apps.push(app as unknown as TestApp);
  return app;
}

/** The ids of rows, sorted: what a list holds, whatever its order. */
function sorted(ids: readonly string[]): string[] {
  return [...ids].sort();
}

/** Everyone on the board, a stranger, and a service-wide Admin of the projects who is on none. */
function callers(): readonly (readonly [string, Principal])[] {
  return [
    ["ada", as(board.ada)],
    ["bo", as(board.bo)],
    ["cy", as(board.cy)],
    ["di", as(board.di)],
    ["ed", as(board.ed)],
    ["a stranger", as("stranger")],
    ["a projects Admin", as(board.cy, { projectService: "Admin" })],
  ];
}

describe("ctx.access", () => {
  it("can agrees with an { entry } form, for a member, a non-member and a service-wide Admin", async () => {
    const app = await start();
    const ids = [board.p1, board.p2, board.p3, "missing"];
    for (const [who, principal] of callers()) {
      const caller = app.as(principal).projectService;
      const { can } = await caller.probe({ projectIds: ids, level: "Moderate" });
      const passes = await Promise.all(
        ids.map(
          async (id) =>
            (await caller.moderate({ id }).then(
              () => true,
              () => false,
            )) as boolean,
        ),
      );
      expect({ who, can }).toEqual({ who, can: passes });
    }
    // bo moderates P1 as a member and owns P3; a missing row has no level but for an Admin.
    const { can: bo } = await app
      .as(as(board.bo))
      .projectService.probe({ projectIds: ids, level: "Moderate" });
    expect(bo).toEqual([true, false, true, false]);
    const { can: admin } = await app
      .as(as(board.cy, { projectService: "Admin" }))
      .projectService.probe({ projectIds: ids, level: "Moderate" });
    expect(admin).toEqual([true, true, true, true]);
  });

  it("gives levelsFor as an { entry } check counts them", async () => {
    const app = await start();
    const { levels } = await app.as(as(board.di)).projectService.probe({
      projectIds: [board.p1, board.p2, board.p3, "missing"],
      level: "Read",
    });
    // di is on P1's access list at Read and P3's at Moderate, and has no level on P2, nor on a
    // row that is not found.
    expect(levels).toEqual({
      [board.p1]: "Read",
      [board.p2]: null,
      [board.p3]: "Moderate",
      missing: null,
    });
  });

  it("lets a custom form check the parent row the input names", async () => {
    const app = await start();
    const input = { projectId: board.p1, title: "Planned" };
    expect(await app.as(as(board.bo)).taskService.add(input)).toMatchObject(input);
    for (const principal of [as(board.ed), as(board.cy)]) {
      await expect(app.as(principal).taskService.add(input)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
    expect(await h.prisma.task.count({ where: { title: "Planned" } })).toBe(1);
  });

  it("checks a row only when its optional key is present", async () => {
    const app = await start();
    await h.prisma.task.updateMany({ data: { assigneeId: board.cy } });
    const cy = app.as(as(board.cy)).taskService;
    // Without the key the form passes, and the handler lists cy's own tasks.
    expect(sorted((await cy.assigned({})).map((task) => task.id))).toEqual(
      sorted([board.t1, board.t2]),
    );
    // With it, the form asks the policy about that project.
    expect(await cy.assigned({ projectId: board.p1 })).toEqual([
      expect.objectContaining({ id: board.t1 }),
    ]);
    await expect(cy.assigned({ projectId: board.p2 })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("gives an anonymous caller no level anywhere, without throwing", async () => {
    const app = await start();
    expect(
      await app.as(null).projectService.probe({ projectIds: [board.p1, board.p2], level: "Read" }),
    ).toEqual({ levels: {}, can: [false, false], visible: [] });
  });

  it("filters with where exactly the rows can allows, at every level", async () => {
    const app = await start();
    const ids = [board.p1, board.p2, board.p3];
    for (const [who, principal] of callers()) {
      for (const at of level.options) {
        const { can, visible } = await app
          .as(principal)
          .projectService.probe({ projectIds: ids, level: at });
        expect({ who, at, visible: sorted(visible) }).toEqual({
          who,
          at,
          visible: sorted(ids.filter((_, index) => can[index])),
        });
      }
    }
  });

  it("asks as the caller of an MCP call and of a ctx.services call", async () => {
    const app = await start();
    const input = { projectIds: [board.p1, board.p2], level: "Moderate" as const };
    expect(await app.as(as(board.bo)).taskService.relay(input)).toMatchObject({
      can: [true, false],
    });
    expect(await app.as(as(board.ed)).taskService.relay(input)).toMatchObject({
      can: [false, true],
    });
    const registry = createMcpRegistry({
      services: [projectService, taskService],
      dispatcher: app.server.dispatcher,
      principal: () => as(board.ed),
    });
    const request = { transport: "stdio", sessionId: "s1" } as const;
    expect(await registry.callMethod("projectService", "probe", input, { request })).toMatchObject({
      ok: true,
      data: { can: [false, true] },
    });
    expect(
      await registry.callMethod("projectService", "probe", input, {
        request,
        principal: as(board.bo),
      }),
    ).toMatchObject({ ok: true, data: { can: [true, false] } });
  });

  it("refuses a service without a policy, a row id that is none and a level that is none, signed in or not", async () => {
    const logger = captureLogger();
    const app = await start(logger);
    for (const principal of [as(board.bo), null]) {
      const { ask } = app.as(principal).taskService;
      for (const input of [
        { service: "noteService", rowId: board.p1, level: "Read" },
        { service: "projectService", rowId: "", level: "Read" },
        { service: "projectService", rowId: board.p1, level: "Owner" },
      ]) {
        await expect(ask(input)).rejects.toMatchObject({ code: "INTERNAL" });
      }
      // A row that is not found is no error: no level.
      expect(await ask({ service: "projectService", rowId: "missing", level: "Read" })).toBe(false);
    }
    const logged = JSON.stringify(logger.at("error"));
    expect(logged).toContain(
      "noteService is not a service of this dispatcher with an access policy",
    );
    expect(logged).toContain("ctx.access.can: id must be a row id");
    expect(logged).toContain("ctx.access.can: level must be an access level");
  });

  it("is unavailable in a context no dispatcher built", async () => {
    const ctx = createContext({
      principal: as("u1"),
      signal: NEVER_ABORTED,
      log: consoleLogger,
      requestId: "r1",
      transport: "internal",
    });
    await expect(async () => await ctx.access.can(projects, "p1", "Read")).rejects.toThrow(
      new QuickdrawError(
        "INTERNAL",
        "ctx.access.can needs a dispatcher: it reads the access policies of the dispatcher that runs the method",
      ),
    );
    // Inspecting the context never throws.
    expect(JSON.stringify(ctx.access)).toBe("{}");
  });
});
