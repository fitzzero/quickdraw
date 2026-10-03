// Development warnings in a running app (RFC 0003 section 13, `devWarnings.ts`):
// the checks of each method call's statements on a tracked client, the
// oversized reply, the write tracker's warnings naming their call, and
// `createTestApp({ strictWarnings })` turning every one raised in its calls
// into a thrown error, for as long as the app runs.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../test/prisma/setup";
import { defineContract, mutation, query, QuickdrawError } from "../index";
import { createHarness, type Harness } from "../prisma/__tests__/harness";
import { captureLogger, type CapturingLogger } from "../server/__tests__/fixtures";
import { initQuickdraw, storageOf, type Principal } from "../server/index";
import { checkWhenDefined } from "../server/service";
import { createTestApp, DevWarningError, type TestApp } from "./index";

const qd = initQuickdraw<{ db: PrismaClient; principal: Principal }>();
const ids = z.object({ ids: z.array(z.string()) });
const scope = z.object({ projectId: z.string() });
const count = z.number();

const contract = defineContract("probeService", {
  methods: {
    oneByOne: query({ input: ids, output: count }),
    together: query({ input: ids, output: count }),
    batched: query({ input: ids, output: count }),
    everything: query({ input: scope, output: count }),
    page: query({ input: scope, output: count }),
    framework: query({ input: scope, output: count }),
    kit: query({ input: scope, output: count }),
    big: query({ input: z.object({ size: z.number() }), output: z.string() }),
    nested: mutation({ input: scope, output: z.string() }),
  },
});

/** A handler a kit made: framework code, whose statements are not checked. */
async function kitRead({ input, db }: { input: { projectId: string }; db: PrismaClient }) {
  return (await db.task.findMany({ where: { projectId: input.projectId } })).length;
}
checkWhenDefined(kitRead, () => undefined);

const service = qd.defineService(contract, {
  methods: {
    oneByOne: {
      access: "authenticated",
      handler: async ({ input, db }) => {
        let found = 0;
        for (const id of input.ids) {
          found += (await db.task.findUnique({ where: { id } })) === null ? 0 : 1;
        }
        return found;
      },
    },
    together: {
      access: "authenticated",
      handler: async ({ input, db }) =>
        (await db.task.findMany({ where: { id: { in: input.ids } } })).length,
    },
    batched: {
      access: "authenticated",
      handler: async ({ input, db }) =>
        (await db.$transaction(input.ids.map((id) => db.task.findUnique({ where: { id } }))))
          .length,
    },
    everything: {
      access: "authenticated",
      handler: async ({ input, db }) =>
        (await db.task.findMany({ where: { projectId: input.projectId } })).length,
    },
    page: {
      access: "authenticated",
      handler: async ({ input, db }) =>
        (await db.task.findMany({ where: { projectId: input.projectId }, take: 5 })).length,
    },
    framework: {
      access: "authenticated",
      handler: async ({ input, db }) =>
        (await storageOf(db)?.findMany("task", { where: { projectId: input.projectId } }))
          ?.length ?? 0,
    },
    kit: { access: "authenticated", handler: kitRead },
    big: { access: "authenticated", handler: ({ input }) => "x".repeat(input.size) },
    nested: {
      access: "authenticated",
      handler: async ({ input, db }) =>
        (
          await db.task.create({
            data: { projectId: input.projectId, title: "nested", labels: { create: [] } },
          })
        ).id,
    },
  },
});

const ada: Principal = { userId: "ada" };

let h: Harness;
let projectId: string;
let taskIds: string[];
const apps: TestApp[] = [];

beforeAll(async () => {
  h = await createHarness();
}, 60_000);

afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.database.reset();
  ({ projectId } = await h.seed());
  taskIds = [];
  for (let index = 0; index < 12; index += 1) {
    taskIds.push((await h.prisma.task.create({ data: { projectId, title: `T${index}` } })).id);
  }
});

afterEach(async () => {
  await Promise.all(apps.splice(0).map(async (app) => await app.close()));
});

interface StartOptions {
  readonly strictWarnings?: boolean;
  readonly maxResponseBytes?: number;
}

async function start(options: StartOptions = {}) {
  const logger = captureLogger();
  const records: string[] = [];
  const app = await createTestApp({
    services: [service],
    db: h.db,
    logger,
    onCall: (record) => records.push(`${record.method} ${record.outcome} ${record.bytes}`),
    ...options,
  });
  apps.push(app as unknown as TestApp);
  return { app, logger, records, probe: app.as(ada).probeService };
}

/** The size `app.as(...)` reports for a reply: its JSON. */
function replyBytes(data: unknown): number {
  return Buffer.byteLength(JSON.stringify({ ok: true, d: data }));
}

function devWarnings(logger: CapturingLogger): string[] {
  return logger
    .at("warn")
    .filter((entry) => entry.meta?.category === "quickdraw.dev")
    .map((entry) => entry.message);
}

describe("development warnings in a running app", () => {
  it("warn once about a query run once per item of a loop (N+1), naming the call", async () => {
    const { logger, probe } = await start();
    expect(await probe.oneByOne({ ids: taskIds })).toBe(12);
    expect(await probe.oneByOne({ ids: taskIds })).toBe(12);
    expect(devWarnings(logger)).toEqual([
      "[quickdraw:n-plus-one] probeService.oneByOne: task.findUnique by id ran 10 times in one call, once per item (N+1); read the rows in one query (findMany({ where: { id: { in: ids } } })), or write them together (createMany, updateMany, db.$transaction([...]))",
    ]);
  });

  it("raise nothing for a read by ids, a page, or reads sent together in a batch", async () => {
    const { logger, probe } = await start();
    expect(await probe.together({ ids: taskIds })).toBe(12);
    expect(await probe.page({ projectId })).toBe(5);
    expect(await probe.batched({ ids: taskIds })).toBe(12);
    expect(devWarnings(logger)).toEqual([]);
  });

  it("warn once about a findMany without take", async () => {
    const { logger, probe } = await start();
    expect(await probe.everything({ projectId })).toBe(12);
    expect(await probe.everything({ projectId })).toBe(12);
    expect(devWarnings(logger)).toEqual([
      "[quickdraw:unbounded-read] probeService.everything: task.findMany() without take reads every matching row, however many there are; add take (with a cursor to page), or serve the list as a collection or the read/write kit's list",
    ]);
  });

  it("leave the framework's own reads alone: the storage adapter's, and a kit's handlers", async () => {
    const { logger, probe } = await start();
    expect(await probe.framework({ projectId })).toBe(12);
    expect(await probe.kit({ projectId })).toBe(12);
    expect(devWarnings(logger)).toEqual([]);
  });

  it("warn once about a reply larger than maxResponseBytes", async () => {
    const { logger, probe } = await start({ maxResponseBytes: 256 });
    await probe.big({ size: 100 });
    expect(devWarnings(logger)).toEqual([]);
    await probe.big({ size: 400 });
    await probe.big({ size: 500 });
    expect(devWarnings(logger)).toEqual([
      `[quickdraw:oversized-response] probeService.big: replied with ${replyBytes("x".repeat(400))} bytes, more than maxResponseBytes (256); page the result (take and a cursor), return a leaner projection, or serve it as a collection`,
    ]);
  });

  it("name the call a write tracker warning was raised in", async () => {
    const { logger, probe } = await start();
    await probe.nested({ projectId });
    expect(devWarnings(logger)).toEqual([
      "[quickdraw:nested-write] probeService.nested: A nested write (task.labels: { create }) is not tracked; only the task row is. Write related rows through their own model",
    ]);
  });
});

describe("createTestApp({ strictWarnings: true })", () => {
  it("fails the call that ran a query once per item with the DevWarningError", async () => {
    const { logger, probe } = await start({ strictWarnings: true });
    const error: unknown = await probe
      .oneByOne({ ids: taskIds })
      .catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(QuickdrawError);
    expect(error).toMatchObject({ code: "INTERNAL" });
    const cause = (error as QuickdrawError).cause;
    expect(cause).toBeInstanceOf(DevWarningError);
    expect(cause).toMatchObject({
      warning: { kind: "n-plus-one", service: "probeService", method: "oneByOne" },
    });
    expect(devWarnings(logger)).toEqual([]);
    // Every time, not once: the next call fails too.
    await expect(probe.oneByOne({ ids: taskIds })).rejects.toMatchObject({ code: "INTERNAL" });
    expect(await probe.together({ ids: taskIds })).toBe(12);
  });

  it("rejects an in-process call whose reply was oversized, once it was recorded", async () => {
    const { probe, records } = await start({ strictWarnings: true, maxResponseBytes: 256 });
    const error: unknown = await probe.big({ size: 500 }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DevWarningError);
    expect(error).toMatchObject({
      warning: { kind: "oversized-response", service: "probeService", method: "big" },
    });
    expect(records).toEqual([`big ok ${replyBytes("x".repeat(500))}`]);
  });

  it("throws only under vitest or jest", async () => {
    const vitest = process.env.VITEST;
    delete process.env.VITEST;
    try {
      const { logger, probe } = await start({ strictWarnings: true });
      expect(await probe.oneByOne({ ids: taskIds })).toBe(12);
      expect(devWarnings(logger)).toHaveLength(1);

      process.env.JEST_WORKER_ID = "1";
      const jest = await start({ strictWarnings: true });
      await expect(jest.probe.oneByOne({ ids: taskIds })).rejects.toMatchObject({
        code: "INTERNAL",
      });
    } finally {
      process.env.VITEST = vitest;
      delete process.env.JEST_WORKER_ID;
    }
  });

  const AMBIENT =
    "[quickdraw:ambient-write] A tracked write to project ran outside any unit of work, so it flushes on its own; run jobs and scripts inside qd.run(...)";

  it("throws only in the app's own calls: seeding through the tracked client logs", async () => {
    const { logger } = await start({ strictWarnings: true });
    const { userId } = await h.seed();
    await h.db.project.create({ data: { name: "seeded", ownerId: userId } });
    expect(devWarnings(logger)).toEqual([AMBIENT]);
  });

  it("ends with the app: after close(), the tracked client logs and never throws", async () => {
    // The review's strictLeak case: a strict app runs and closes, then a test seeds.
    const { app, probe } = await start({ strictWarnings: true });
    await expect(probe.oneByOne({ ids: taskIds })).rejects.toMatchObject({ code: "INTERNAL" });
    await app.close();
    const { userId } = await h.seed();
    await expect(
      h.db.project.create({ data: { name: "after", ownerId: userId } }),
    ).resolves.toMatchObject({ name: "after" });
    expect(h.logger.warnings).toContain(AMBIENT);
  });

  it("is per app: an app sharing the tracked client warns, the strict one still throws", async () => {
    const strict = await start({ strictWarnings: true });
    const relaxed = await start();
    expect(await relaxed.probe.oneByOne({ ids: taskIds })).toBe(12);
    expect(devWarnings(relaxed.logger)).toHaveLength(1);
    await expect(strict.probe.oneByOne({ ids: taskIds })).rejects.toMatchObject({
      code: "INTERNAL",
    });

    // Closing the later app gives ambient writes back to the strict one, which logs them.
    await relaxed.app.close();
    const { userId } = await h.seed();
    await h.db.project.create({ data: { name: "back", ownerId: userId } });
    expect(devWarnings(strict.logger)).toEqual([AMBIENT]);
    expect(devWarnings(relaxed.logger)).toHaveLength(1);
  });
});
