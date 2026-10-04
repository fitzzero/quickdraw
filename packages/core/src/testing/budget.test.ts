// `expectBudget` (RFC 0003 section 13, `budget.ts`): a test step's statements
// and bytes, compared with the budget file beside the test. These tests keep
// their budget file in a temporary directory; `test/e2e/budgets.test.ts`
// keeps the fixture app's next to it, committed.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../test/prisma/setup";
import { defineContract, query } from "../index";
import { createHarness, type Harness } from "../prisma/__tests__/harness";
import {
  as,
  projectService,
  seedBoard,
  taskService,
  type Board,
} from "../server/access/__tests__/board";
import { captureLogger } from "../server/__tests__/fixtures";
import { initQuickdraw, type Principal } from "../server/index";
import { byCall, growthAllowed, underCi } from "./budget";
import {
  budgetFileOf,
  createTestApp,
  emitWithAck,
  expectBudget,
  type Budget,
  type TestApp,
} from "./index";

const qd = initQuickdraw<{ db: PrismaClient; principal: Principal }>();
const scope = z.object({ projectId: z.string() });

const contract = defineContract("stepService", {
  methods: {
    page: query({ input: scope, output: z.number() }),
    text: query({ input: z.object({ size: z.number() }), output: z.string() }),
    shared: query({ input: scope, output: z.number() }),
  },
});

/** Makes `page` run one more statement, as a changed handler would. */
let extraStatement = false;
/** Opens the `shared` run waiting for it, once one is. */
let release: (() => void) | undefined;

const service = qd.defineService(contract, {
  methods: {
    page: {
      access: "authenticated",
      handler: async ({ input, db }) => {
        const rows = await db.task.findMany({ where: { projectId: input.projectId }, take: 10 });
        if (extraStatement) {
          await db.task.count({ where: { projectId: input.projectId } });
        }
        return rows.length;
      },
    },
    text: { access: "authenticated", handler: ({ input }) => "x".repeat(input.size) },
    shared: {
      access: "authenticated",
      share: "all",
      handler: async ({ input, db }) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return await db.task.count({ where: { projectId: input.projectId } });
      },
    },
  },
});

const ada: Principal = { userId: "ada" };

let h: Harness;
let board: Board;
let dir: string;
let file: string;
const apps: TestApp[] = [];

beforeAll(async () => {
  h = await createHarness();
  dir = mkdtempSync(join(tmpdir(), "qd-budget-"));
}, 60_000);

afterAll(async () => {
  await h.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async (context) => {
  await h.database.reset();
  board = await seedBoard(h.prisma);
  extraStatement = false;
  file = join(dir, `${context.task.id}.test.ts`);
  // As a local run: CI changes what a lower budget does.
  vi.stubEnv("CI", "");
  vi.stubEnv("QD_ALLOW_BUDGET_GROWTH", undefined);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

async function start() {
  const app = await createTestApp({
    services: [projectService, taskService, service],
    db: h.db,
    logger: captureLogger(),
  });
  apps.push(app as unknown as TestApp);
  return app;
}

function stored(name: string): Budget | undefined {
  const parsed = JSON.parse(readFileSync(budgetFileOf(file), "utf8")) as {
    readonly budgets: Readonly<Record<string, Budget>>;
  };
  return parsed.budgets[name];
}

/** The size `app.as(...)` reports for a reply: its JSON. */
function replyBytes(data: unknown): number {
  return Buffer.byteLength(JSON.stringify({ ok: true, d: data }));
}

describe("expectBudget", () => {
  it("writes a missing entry beside the test, then passes while the step costs the same", async () => {
    const app = await start();
    const step = () => app.as(ada).stepService.page({ projectId: board.p1 });
    const first = await expectBudget(step, { name: "page", file });
    const expected: Budget = {
      statements: 1,
      bytes: replyBytes(1),
      calls: [{ call: "stepService.page", statements: 1, bytes: replyBytes(1) }],
    };
    expect(first).toEqual({
      name: "page",
      path: budgetFileOf(file),
      measured: expected,
      change: "written",
    });
    expect(budgetFileOf(file)).toBe(join(dir, "__budgets__", `${file.split("/").at(-1)}.json`));
    expect(stored("page")).toEqual(expected);
    expect((await expectBudget(step, { name: "page", file })).change).toBe("unchanged");
  });

  it("fails with both numbers when the handler runs one more statement, and keeps the budget", async () => {
    const app = await start();
    const step = () => app.as(ada).stepService.page({ projectId: board.p1 });
    await expectBudget(step, { name: "page", file });
    extraStatement = true;
    const error: unknown = await expectBudget(step, { name: "page", file }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'expectBudget("page"): the step costs more than its budget',
    );
    expect((error as Error).message).toContain("  statements: was 1, now 2\n");
    expect((error as Error).message).toContain(
      "  stepService.page (call 1) statements: was 1, now 2\n",
    );
    expect((error as Error).message).toContain(
      'set QD_ALLOW_BUDGET_GROWTH=1 (or QD_ALLOW_BUDGET_GROWTH="page") to accept the new budget',
    );
    expect(stored("page")?.statements).toBe(1);
  });

  it("accepts the growth and rewrites the budget with QD_ALLOW_BUDGET_GROWTH=1", async () => {
    const app = await start();
    const step = () => app.as(ada).stepService.page({ projectId: board.p1 });
    await expectBudget(step, { name: "page", file });
    extraStatement = true;
    vi.stubEnv("QD_ALLOW_BUDGET_GROWTH", "1");
    expect((await expectBudget(step, { name: "page", file })).change).toBe("grown");
    vi.stubEnv("QD_ALLOW_BUDGET_GROWTH", undefined);
    expect(stored("page")).toMatchObject({ statements: 2, calls: [{ statements: 2 }] });
    expect((await expectBudget(step, { name: "page", file })).change).toBe("unchanged");
  });

  it("accepts growth only for the budgets QD_ALLOW_BUDGET_GROWTH names", async () => {
    const app = await start();
    const step = () => app.as(ada).stepService.page({ projectId: board.p1 });
    await expectBudget(step, { name: "page", file });
    extraStatement = true;
    vi.stubEnv("QD_ALLOW_BUDGET_GROWTH", "list as owner");
    await expect(expectBudget(step, { name: "page", file })).rejects.toThrow(
      "the step costs more than its budget",
    );
    vi.stubEnv("QD_ALLOW_BUDGET_GROWTH", "list as owner, page");
    expect((await expectBudget(step, { name: "page", file })).change).toBe("grown");
    expect(growthAllowed("page", "1")).toBe(true);
    expect(growthAllowed("page", " 1 ")).toBe(true);
    expect(growthAllowed("1", "page,1")).toBe(true);
    expect(growthAllowed("page", "pages,list")).toBe(false);
    expect(growthAllowed("page", "")).toBe(false);
  });

  it("fails a lower step under CI, writing nothing, so removed work is noticed", async () => {
    const app = await start();
    const step = () => app.as(ada).stepService.page({ projectId: board.p1 });
    extraStatement = true;
    await expectBudget(step, { name: "page", file });
    extraStatement = false;
    vi.stubEnv("CI", "true");
    const error: unknown = await expectBudget(step, { name: "page", file }).catch(
      (reason: unknown) => reason,
    );
    expect((error as Error).message).toContain(
      'expectBudget("page"): budget changed; rerun locally to accept',
    );
    expect((error as Error).message).toContain("  statements: was 2, now 1\n");
    expect(stored("page")).toMatchObject({ statements: 2 });
    expect([underCi("1"), underCi("true"), underCi("false"), underCi("")]).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  it("lowers the budget when the step gets cheaper", async () => {
    const app = await start();
    const step = () => app.as(ada).stepService.page({ projectId: board.p1 });
    extraStatement = true;
    await expectBudget(step, { name: "page", file });
    extraStatement = false;
    expect((await expectBudget(step, { name: "page", file })).change).toBe("lowered");
    expect(stored("page")).toMatchObject({ statements: 1, calls: [{ statements: 1 }] });
  });

  it("lets bytes move by 5% either way without a change, and fails past it", async () => {
    const app = await start();
    const step = (size: number) => () => app.as(ada).stepService.text({ size });
    await expectBudget(step(1000), { name: "text", file });
    expect((await expectBudget(step(1040), { name: "text", file })).change).toBe("unchanged");
    expect((await expectBudget(step(960), { name: "text", file })).change).toBe("unchanged");
    expect(stored("text")?.bytes).toBe(replyBytes("x".repeat(1000)));
    await expect(expectBudget(step(1100), { name: "text", file })).rejects.toThrow(
      `  bytes: was ${replyBytes("x".repeat(1000))}, now ${replyBytes("x".repeat(1100))} (+9.8%; bytes may move by 5%)`,
    );
    expect((await expectBudget(step(800), { name: "text", file })).change).toBe("lowered");
    expect(stored("text")?.bytes).toBe(replyBytes("x".repeat(800)));
  });

  it("fails when the step's calls change", async () => {
    const app = await start();
    await expectBudget(() => app.as(ada).stepService.text({ size: 1 }), { name: "calls", file });
    await expect(
      expectBudget(
        async () => {
          await app.as(ada).stepService.text({ size: 1 });
          await app.as(ada).stepService.page({ projectId: board.p1 });
        },
        { name: "calls", file },
      ),
    ).rejects.toThrow("  calls: was stepService.text; now stepService.page, stepService.text");
  });

  it("counts a shared run once, on the call that started it", async () => {
    const app = await start();
    const result = await expectBudget(
      async () => {
        const caller = app.as(ada).stepService;
        const calls = [
          caller.shared({ projectId: board.p1 }),
          caller.shared({ projectId: board.p1 }),
        ];
        await vi.waitFor(() => {
          expect(release).toBeDefined();
        });
        await new Promise((resolve) => {
          setImmediate(resolve);
        });
        release?.();
        release = undefined;
        await Promise.all(calls);
      },
      { name: "shared", file },
    );
    expect(result.measured).toEqual({
      statements: 1,
      bytes: 2 * replyBytes(1),
      calls: [
        { call: "stepService.shared", statements: 0, bytes: replyBytes(1) },
        { call: "stepService.shared", statements: 1, bytes: replyBytes(1) },
      ],
    });
  });

  it("counts access checks in the step's statements, not in the call's", async () => {
    const app = await start();
    const result = await expectBudget(
      () => app.as(as(board.ada)).taskService.get({ id: board.t1 }),
      {
        name: "access",
        file,
      },
    );
    expect(result.measured.calls).toEqual([
      { call: "taskService.get", statements: 1, bytes: expect.any(Number) },
    ]);
    expect(result.measured.statements).toBeGreaterThan(1);
  });

  it("measures what the server wrote to sockets: a subscription's reply, a failed call", async () => {
    const app = await start();
    const { socket } = await app.connect(as(board.ada));
    const subscribed = await expectBudget(
      () => emitWithAck(socket, "qd:sub", { s: "taskService", ids: [board.t1, board.t2] }),
      { name: "subscribe", file },
    );
    expect(subscribed.measured.calls).toEqual([]);
    expect(subscribed.measured.statements).toBeGreaterThan(0);
    expect(subscribed.measured.bytes).toBeGreaterThan(0);
    const refused = await expectBudget(
      () =>
        app
          .as(null)
          .stepService.page({ projectId: board.p1 })
          .catch(() => undefined),
      { name: "refused", file },
    );
    expect(refused.measured.calls).toEqual([
      {
        call: "stepService.page",
        statements: 0,
        bytes: expect.any(Number),
        outcome: "UNAUTHENTICATED",
      },
    ]);
  });

  it("measures one step at a time, and only while a test app runs", async () => {
    await expect(expectBudget(() => undefined, { name: "none", file })).rejects.toThrow(
      "expectBudget: no test app is running",
    );
    const app = await start();
    let finish: () => void = () => undefined;
    const first = expectBudget(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      { name: "first", file },
    );
    await expect(
      expectBudget(() => app.as(ada).stepService.text({ size: 1 }), { name: "second", file }),
    ).rejects.toThrow("expectBudget: another budget is being measured");
    finish();
    expect((await first).change).toBe("written");
    await expect(expectBudget(() => undefined, { name: " " })).rejects.toThrow(
      "name must be a non-empty string",
    );
  });

  it("orders a step's calls by code unit, the same in every locale", () => {
    const call = (name: string) => ({ call: name, statements: 0, bytes: 0 });
    const calls = [call("b.get"), call("B.get"), call("a.get"), call("é.get"), call("e.get")];
    expect([...calls].sort(byCall).map((each) => each.call)).toEqual([
      "B.get",
      "a.get",
      "b.get",
      "e.get",
      "é.get",
    ]);
  });

  it("refuses a file or an entry that is not a budget, and an inherited name", async () => {
    const app = await start();
    const step = () => app.as(ada).stepService.text({ size: 1 });
    mkdirSync(join(dir, "__budgets__"), { recursive: true });
    writeFileSync(budgetFileOf(file), JSON.stringify({ budgets: {} }));
    await expect(expectBudget(step, { name: "x", file })).rejects.toThrow(
      `expectBudget: ${budgetFileOf(file)} is not a budget file`,
    );
    writeFileSync(
      budgetFileOf(file),
      JSON.stringify({ version: 1, budgets: { x: { statements: "two", bytes: 1, calls: [] } } }),
    );
    await expect(expectBudget(step, { name: "x", file })).rejects.toThrow(
      `expectBudget("x"): its entry in ${budgetFileOf(file)} is not a budget; delete it to measure it again`,
    );
    expect((await expectBudget(step, { name: "__proto__", file })).change).toBe("written");
    expect(Object.keys(JSON.parse(readFileSync(budgetFileOf(file), "utf8")).budgets)).toEqual([
      "__proto__",
      "x",
    ]);
  });
});

describe("expectBudget's step names", () => {
  // Both tests use one budget file, as two tests of one test file do.
  let shared = "";
  beforeAll(() => {
    shared = join(dir, "shared.test.ts");
  });

  it("lets a test measure its step again (a retry)", async () => {
    const app = await start();
    const step = () => app.as(ada).stepService.text({ size: 1 });
    expect((await expectBudget(step, { name: "text", file: shared })).change).toBe("written");
    expect((await expectBudget(step, { name: "text", file: shared })).change).toBe("unchanged");
  });

  it("refuses a step name another test of the same file used", async () => {
    const app = await start();
    const step = () => app.as(ada).stepService.text({ size: 2 });
    const error: unknown = await expectBudget(step, { name: "text", file: shared }).catch(
      (reason: unknown) => reason,
    );
    expect(error).toBeInstanceOf(TypeError);
    expect((error as Error).message).toMatch(
      /expectBudget: two tests of .*shared\.test\.ts\.json name a step "text" \("expectBudget's step names > lets a test measure its step again \(a retry\)" and "expectBudget's step names > refuses a step name another test of the same file used"\); give each step its own name/,
    );
  });
});
