// The access engine through the method pipeline (RFC 0003 sections 4.1 and
// 9): every access form, decided for every principal by the real dispatcher
// of a test app, over real sockets and in process, against PGlite. The
// matrix is run by `describeAccessMatrix` from `./testing`.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { createHarness, type Harness } from "../../prisma/__tests__/harness";
import { defineContract, query } from "../../index";
import { createTestApp, describeAccessMatrix } from "../../testing/index";
import { captureLogger, deferred } from "../__tests__/fixtures";
import {
  createDispatcher,
  inherit,
  resolver,
  type AnyService,
  type StorageAdapter,
} from "../index";
import {
  as,
  defineTaskService,
  findTask,
  projectContract,
  projectService,
  qd,
  seedBoard,
  taskService,
  type Board,
} from "./__tests__/board";

let h: Harness;
let board: Board;

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.database.reset();
  board = await seedBoard(h.prisma);
});

/** The matrix's principals: who they are on task T1, in project P1. */
function principals() {
  return {
    owner: as(board.ada),
    member: as(board.bo),
    reader: as(board.cy),
    shared: as(board.di),
    stranger: as(board.ed),
    serviceReader: as(board.ed, { taskService: "Read" }),
    serviceReaderWithRow: as(board.cy, { taskService: "Read" }),
    serviceModerator: as(board.ed, { taskService: "Moderate" }),
    serviceAdmin: as(board.ed, { taskService: "Admin" }),
  };
}

const EVERYONE = [
  "owner",
  "member",
  "reader",
  "shared",
  "stranger",
  "serviceReader",
  "serviceReaderWithRow",
  "serviceModerator",
  "serviceAdmin",
] as const;

describe("the access matrix", () => {
  it.each(["socket", "caller"] as const)(
    "decides every form for every principal (%s)",
    async (via) => {
      const app = await createTestApp({ services: [projectService, taskService], db: h.db });
      try {
        const { cells } = await describeAccessMatrix(app, {
          service: taskService,
          principals: principals(),
          via,
          cases: [
            {
              label: "{ service: Moderate, entry: Read }",
              method: "moderate",
              input: { id: board.t1, title: "x" },
              allow: [
                "owner",
                "member",
                "reader",
                "shared",
                "serviceReaderWithRow",
                "serviceModerator",
                "serviceAdmin",
              ],
            },
            {
              label: "{ entry: Read }",
              method: "get",
              input: { id: board.t1 },
              allow: [
                "owner",
                "member",
                "reader",
                "shared",
                "serviceReaderWithRow",
                "serviceAdmin",
              ],
            },
            {
              label: "{ entry: Moderate }",
              method: "rename",
              input: { id: board.t1, title: "renamed" },
              allow: ["owner", "member", "serviceAdmin"],
            },
            {
              label: "{ entry: Read, id: ids }",
              method: "getMany",
              input: { ids: [board.t1, board.t2] },
              allow: ["serviceAdmin"],
            },
            {
              label: "{ scope: Moderate, of: project }",
              method: "create",
              input: { projectId: board.p1, title: "new" },
              allow: ["owner", "member", "serviceAdmin"],
            },
            {
              label: '"public"',
              method: "ping",
              input: undefined,
              allow: [...EVERYONE, "anonymous"],
            },
            { label: '"authenticated"', method: "whoami", input: undefined, allow: EVERYONE },
            {
              label: "a task that does not exist",
              method: "get",
              input: { id: "no-such-task" },
              expect: { serviceAdmin: "NOT_FOUND" },
            },
            {
              label: "a project id given as a task id",
              method: "get",
              input: { id: board.p1 },
              expect: { serviceAdmin: "NOT_FOUND" },
            },
          ],
        });
        expect(cells).toHaveLength(9 * 10);
      } finally {
        await app.close();
      }
    },
  );

  it("honors a service Admin grant only while the service keeps adminBypass on", async () => {
    const strict = defineTaskService({ adminBypass: false });
    const app = await createTestApp({ services: [projectService, strict], db: h.db });
    try {
      await describeAccessMatrix(app, {
        service: strict,
        principals: { serviceAdmin: as(board.ed, { taskService: "Admin" }), owner: as(board.ada) },
        cases: [
          { method: "get", input: { id: board.t1 }, allow: ["owner"] },
          // A form that names service still counts the grant: Admin is at least Moderate.
          {
            method: "moderate",
            input: { id: board.t1, title: "x" },
            allow: ["owner", "serviceAdmin"],
          },
          { method: "create", input: { projectId: board.p1, title: "n" }, allow: ["owner"] },
        ],
      });
    } finally {
      await app.close();
    }
  });

  it("adds an anonymous caller, and refuses a service the app does not serve", async () => {
    const app = await createTestApp({ services: [projectService, taskService], db: h.db });
    try {
      const { cells } = await describeAccessMatrix(app, {
        service: taskService,
        principals: { owner: as(board.ada) },
        cases: [{ method: "whoami", input: undefined, allow: ["owner"] }],
      });
      expect(cells).toEqual([
        { case: "whoami", principal: "owner", expected: "allow", actual: "allow", pass: true },
        {
          case: "whoami",
          principal: "anonymous",
          expected: "deny",
          actual: "UNAUTHENTICATED",
          pass: true,
        },
      ]);
      await expect(
        describeAccessMatrix(app, { service: defineTaskService(), principals: {}, cases: [] }),
      ).rejects.toThrow("describeAccessMatrix: the app does not serve taskService");
    } finally {
      await app.close();
    }
  });

  it("reports every cell that differs from the table", async () => {
    const app = await createTestApp({ services: [projectService, taskService], db: h.db });
    try {
      const run = describeAccessMatrix(app, {
        service: taskService,
        principals: { stranger: as(board.ed), nobody: null },
        cases: [
          { method: "get", input: { id: board.t1 }, allow: ["stranger"] },
          { method: "ping", input: undefined, expect: { stranger: "allow", nobody: "deny" } },
        ],
      });
      await expect(run).rejects.toThrow(
        [
          "describeAccessMatrix(taskService): 2 of 4 cells differ",
          "  get as stranger: expected allow, got FORBIDDEN",
          "  ping as nobody: expected deny, got allow",
        ].join("\n"),
      );
    } finally {
      await app.close();
    }
  });
});

describe("authorization before sharing", () => {
  const sharing = defineContract("sharedTasks", {
    methods: { get: query({ input: z.object({ id: z.string() }), output: z.string() }) },
  });

  it("authorizes each caller before it joins a shared run", async () => {
    const gate = deferred();
    let runs = 0;
    const shared = qd.defineService(sharing, {
      model: "task",
      access: inherit({ from: projectContract, via: "projectId" }),
      methods: {
        get: {
          access: { entry: "Read" },
          share: "all",
          handler: async ({ input, db }) => {
            runs += 1;
            await gate.promise;
            return (await findTask(db, input.id)).title;
          },
        },
      },
    });
    const dispatcher = qd.createDispatcher({ services: [projectService, shared], db: h.db });
    const first = dispatcher.caller(as(board.ada)).sharedTasks.get({ id: board.t1 });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    expect(runs).toBe(1);
    // The run is still waiting on the gate: a joiner that may not read is refused now.
    await expect(
      dispatcher.caller(as(board.ed)).sharedTasks.get({ id: board.t1 }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const joiner = dispatcher.caller(as(board.bo)).sharedTasks.get({ id: board.t1 });
    gate.resolve();
    await expect(Promise.all([first, joiner])).resolves.toEqual(["T1", "T1"]);
    expect(runs).toBe(1);
  });
});

describe("failures", () => {
  it("fails the call with INTERNAL when a lookup throws, and logs the cause", async () => {
    const logger = captureLogger();
    const failing = qd.defineService(
      defineContract("failing", {
        methods: { get: query({ input: z.object({ id: z.string() }), output: z.string() }) },
      }),
      {
        model: "task",
        access: resolver({
          levelsFor: () => {
            throw new Error("the lookup failed");
          },
        }),
        methods: { get: { access: { entry: "Read" }, handler: () => "never" } },
      },
    );
    const dispatcher = qd.createDispatcher({ services: [failing], db: h.db, logger });
    await expect(
      dispatcher.caller(as(board.ada)).failing.get({ id: board.t1 }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(logger.at("error")[0]?.meta?.error).toMatchObject({
      code: "INTERNAL",
      cause: { message: "the lookup failed" },
    });
  });

  it("fails closed when the storage adapter cannot read", async () => {
    const broken: StorageAdapter = {
      ...h.storage,
      findMany: () => Promise.reject(new Error("connection lost")),
    };
    const dispatcher = qd.createDispatcher({
      services: [projectService, taskService],
      db: h.db,
      storage: broken,
      logger: captureLogger(),
    });
    await expect(
      dispatcher.caller(as(board.ada)).taskService.get({ id: board.t1 }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    await expect(dispatcher.caller(as(board.ada)).taskService.ping()).resolves.toBe("pong");
  });
});

describe("statements", () => {
  it("authorizes 60 ids with one statement per table, as for one", async () => {
    const projects = [board.p1, board.p2];
    await h.prisma.task.createMany({
      data: Array.from({ length: 58 }, (_, index) => ({
        projectId: projects[index % 2] ?? board.p1,
        title: `t${index}`,
      })),
    });
    const ids = (await h.prisma.task.findMany({ select: { id: true } })).map((row) => row.id);
    expect(ids).toHaveLength(60);
    const dispatcher = qd.createDispatcher({ services: [projectService, taskService], db: h.db });
    const admin = dispatcher.caller(as(board.ed, { taskService: "Admin" })).taskService;
    const owner = dispatcher.caller(as(board.ada)).taskService;
    const countOf = async (call: () => Promise<unknown>) =>
      (await h.storage.countStatements(async () => await call().catch(() => undefined))).statements;
    // The handler's own read, with the access check bypassed by the Admin grant.
    expect(await countOf(() => admin.getMany({ ids }))).toBe(1);
    // Task rows, project rows (access list and owner), project members: three
    // tables, one statement each, however many ids; the handler then reads once.
    expect(await countOf(() => owner.getMany({ ids: [board.t1] }))).toBe(4);
    await expect(owner.getMany({ ids })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await countOf(() => owner.getMany({ ids }))).toBe(3);
  });
});

describe("createDispatcher", () => {
  const plain = (name: string) => defineContract(name, { methods: {} });

  it("refuses a policy or a scope form it could not evaluate", () => {
    const unguarded = qd.defineService(projectContract, {
      methods: { get: { access: "authenticated", handler: () => ({ id: "p", name: "P" }) } },
    });
    const a = plain("a");
    const b = plain("b");
    const fromB = qd.defineService(a, {
      model: "task",
      access: inherit({ from: b, via: "projectId" }),
      methods: {},
    });
    const fromA = qd.defineService(b, {
      model: "task",
      access: inherit({ from: a, via: "parentTaskId" }),
      methods: {},
    });
    const creator = qd.defineService(
      defineContract("creator", {
        methods: {
          create: query({ input: z.object({ projectId: z.string() }), output: z.null() }),
        },
      }),
      {
        model: "task",
        methods: {
          create: {
            access: { scope: "Moderate", of: projectContract, id: "projectId" },
            handler: () => null,
          },
        },
      },
    );
    const refusals: [readonly AnyService[], string][] = [
      [
        [taskService],
        "taskService's access policy inherits from projectService, which this dispatcher does not serve",
      ],
      [[unguarded, taskService], "inherits from projectService, which declares no access policy"],
      [[fromB, fromA], "the access policies of a -> b -> a inherit in a cycle"],
      [
        [creator],
        "creator.create uses scope access of projectService, which this dispatcher does not serve",
      ],
    ];
    const { db } = h;
    for (const [services, message] of refusals) {
      expect(() => createDispatcher({ services, db }), message).toThrow(message);
    }
    expect(() => qd.createDispatcher({ services: [projectService], db: h.prisma })).toThrow(
      "projectService's access policy reads the database, so the dispatcher needs a storage adapter",
    );
    expect(() =>
      qd.createDispatcher({ services: [projectService], db: h.db, access: { cacheMs: -1 } }),
    ).toThrow("access.cacheMs must be a number of milliseconds");
    expect(() =>
      qd.createDispatcher({ services: [projectService], db: h.db, access: "on" as never }),
    ).toThrow("access must be an access engine or { cacheMs }");
    expect(() =>
      qd.createDispatcher({ services: [creator, projectService], db: h.db }),
    ).not.toThrow();
  });
});
