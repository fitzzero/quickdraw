// The read/write kit tests' app, on the access tests' board
// (`../../../access/__tests__/board.ts`) and the live-data tests' project
// service (`../../../emit/__tests__/live.ts`): a task service made only of
// the kit's nine methods, with an indexed board collection so writes show up
// as deltas.
//
//            owner   access list    members                 level on its tasks
//   P1       ada     di: Read       bo: Moderate, cy: Read  ada Admin, bo Moderate, cy and di Read
//   P2       ed      -              -                       ed Admin
//   T1 in P1, T2 in P2

import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../../../../test/prisma/setup";
import { defineContract } from "../../../../index";
import { createHarness, type Harness } from "../../../../prisma/__tests__/harness";
import { createTestApp, type TestApp } from "../../../../testing/index";
import { as, seedBoard, type Board } from "../../../access/__tests__/board";
import { projectContract, projectService, qd } from "../../../emit/__tests__/live";
import { crud, inherit, nextOrdinal } from "../../../index";

export { as };

export const taskEntity = z.object({
  id: z.string(),
  projectId: z.string(),
  parentTaskId: z.string().nullable(),
  title: z.string(),
  status: z.string(),
  ordinal: z.number(),
  assigneeId: z.string().nullable(),
  notes: z.string().nullable(),
  updatedAt: z.string(),
});

export const cardSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.string(),
  ordinal: z.number(),
});

/** A card's keys, in schema order: what a list item holds. */
export const CARD_KEYS = Object.keys(cardSchema.shape);

/** The entity's keys, in schema order. */
export const ENTITY_KEYS = Object.keys(taskEntity.shape);

export const kitMethods = crud.contract({
  entity: taskEntity,
  get: true,
  getMany: true,
  list: {
    item: cardSchema,
    filter: ["projectId", "status", "assigneeId"],
    sort: ["ordinal", "title", "updatedAt"],
  },
  create: {
    input: z.object({
      id: z.string().optional(),
      projectId: z.string(),
      title: z.string().min(1),
      status: z.string().optional(),
    }),
  },
  update: {
    input: z
      .object({ title: z.string().min(1), status: z.string(), assigneeId: z.string().nullable() })
      .partial(),
  },
  delete: true,
  reorder: { column: "ordinal", within: "projectId" },
  bulkUpdate: {
    input: z.object({ status: z.string(), assigneeId: z.string().nullable() }).partial(),
  },
  bulkDelete: true,
});

export const taskContract = defineContract("taskService", {
  entity: taskEntity,
  projections: { card: cardSchema },
  fields: { notes: "Admin" },
  methods: { ...kitMethods },
  collections: {
    board: {
      scope: "projectId",
      item: "card",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
      index: ["status", "ordinal"],
    },
  },
});

/** Options of {@link defineTaskService}. */
export interface TaskServiceOptions {
  /** The board's bulk threshold, for the reset tests. */
  readonly bulkThreshold?: number;
}

/** The kit's task service: every method of the kit, nothing else. */
export function defineTaskService(options: TaskServiceOptions = {}) {
  return qd.defineService(taskContract, {
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    collections: { board: { anchor: projectContract, bulkThreshold: options.bulkThreshold } },
    methods: {
      ...crud.handlers(taskContract, {
        access: {
          get: { entry: "Read" },
          getMany: "authenticated",
          list: "authenticated",
          create: { scope: "Moderate", of: projectContract, id: "projectId" },
          update: { entry: "Moderate" },
          delete: { entry: "Moderate" },
          reorder: { entry: "Moderate" },
          bulkUpdate: "authenticated",
          bulkDelete: "authenticated",
        },
        prepare: async (input, ctx, db) => ({
          ...input,
          assigneeId: ctx.principal.userId,
          ordinal: await nextOrdinal(db, "task", { projectId: input.projectId }),
        }),
      }),
    },
  });
}

/** Tasks of `projectId` with ordinals `ordinals`, written untracked; their ids in that order. */
export async function addTasks(
  prisma: PrismaClient,
  projectId: string,
  ordinals: readonly number[],
  data: { readonly status?: string; readonly title?: string } = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (const ordinal of ordinals) {
    const task = await prisma.task.create({
      data: { projectId, title: data.title ?? `Task ${ordinal}`, ordinal, ...data },
    });
    ids.push(task.id);
  }
  return ids;
}

/**
 * The suite's harness: call once per test file. Each file gets a PGlite
 * database, each test a freshly seeded board; apps started with `start` are
 * closed after the test.
 */
export function kitApp() {
  let harness: Harness | undefined;
  let seeded: Board | undefined;
  const apps: TestApp[] = [];

  beforeAll(async () => {
    harness = await createHarness();
  }, 60_000);
  afterAll(async () => {
    await harness?.close();
  });
  beforeEach(async () => {
    await harness?.database.reset();
    seeded = harness === undefined ? undefined : await seedBoard(harness.prisma);
  });
  afterEach(async () => {
    await Promise.all(apps.splice(0).map(async (app) => await app.close()));
  });

  const current = (): Harness => {
    if (harness === undefined) {
      throw new Error("the kit harness has no database yet");
    }
    return harness;
  };

  return {
    harness: current,
    /** The board seeded for this test. */
    board(): Board {
      if (seeded === undefined) {
        throw new Error("the board is seeded before each test");
      }
      return seeded;
    },
    /** Starts an app serving the project service and the kit's task service. */
    async start(options: TaskServiceOptions = {}) {
      const h = current();
      const service = defineTaskService(options);
      const app = await createTestApp({ services: [projectService, service], db: h.db });
      apps.push(app as unknown as TestApp);
      return { app, service };
    },
    /** Closes `app` after the test. */
    track(app: TestApp): void {
      apps.push(app);
    },
  };
}
