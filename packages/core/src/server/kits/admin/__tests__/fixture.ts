// The admin kit tests' app, on the access tests' board
// (`../../../access/__tests__/board.ts`) and the live-data tests' project
// service (`../../../emit/__tests__/live.ts`): a task service with the admin
// kit's eight methods, the read/write kit's `get` and `update` (an ordinary
// update, to compare an admin update's frames with), and an indexed board
// collection, so writes show up as deltas. Its entity has a field of every
// admin field type: strings, a number, a boolean, dates, an enum and JSON,
// and an `Admin`-only `notes` field.
//
//            owner   access list    members                 level on its tasks
//   P1       ada     di: Read       bo: Moderate, cy: Read  ada Admin, bo Moderate, cy and di Read
//   P2       ed      -              -                       ed Admin
//   T1 in P1, T2 in P2
//
// Nobody on the board holds a service-wide grant: `as(id, { taskService:
// "Admin" })` makes a service administrator.

import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../../../../test/prisma/setup";
import { admin as adminContract, crud as crudContract, defineContract } from "../../../../index";
import { createHarness, type Harness } from "../../../../prisma/__tests__/harness";
import { createTestApp, type TestApp } from "../../../../testing/index";
import { as, seedBoard, type Board } from "../../../access/__tests__/board";
import { projectContract, projectService, qd } from "../../../emit/__tests__/live";
import { admin, crud, inherit, type AdminOnCommitted, type AdminOnWrite } from "../../../index";
import type { EntityOf } from "../../../../contract/infer";
import type { Logger } from "../../../../contract/logger";

export { as };

export const taskEntity = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string().min(1),
  status: z.enum(["open", "doing", "done"]),
  ordinal: z.number().int(),
  pinned: z.boolean(),
  details: z.json(),
  assigneeId: z.string().nullable(),
  notes: z.string().nullable(),
  createdAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

export const cardSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  title: z.string(),
  status: z.string(),
  ordinal: z.number(),
});

/** The entity's keys, in schema order. */
export const ENTITY_KEYS = Object.keys(taskEntity.shape);

export const adminMethods = adminContract.contract({
  entity: taskEntity,
  filter: ["projectId", "status", "pinned"],
  sort: ["createdAt", "title", "ordinal"],
});

export const taskContract = defineContract("taskService", {
  entity: taskEntity,
  projections: { card: cardSchema },
  fields: { notes: "Admin" },
  methods: {
    ...crudContract.contract({
      entity: taskEntity,
      get: true,
      update: { input: z.object({ title: z.string().min(1), status: z.string() }).partial() },
    }),
    ...adminMethods,
  },
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
  /** The admin kit's `hiddenFields`. */
  readonly hiddenFields?: readonly ("notes" | "details" | "assigneeId" | "pinned")[];
  /** The admin kit's `displayName`. */
  readonly displayName?: string;
  /** The service's `adminBypass`; default `true`. */
  readonly adminBypass?: boolean;
  /** The admin kit's `onWrite`. */
  readonly onWrite?: AdminOnWrite<EntityOf<typeof taskContract>, PrismaClient>;
  /** The admin kit's `onCommitted`. */
  readonly onCommitted?: AdminOnCommitted<EntityOf<typeof taskContract>>;
  /** The test app's logger. */
  readonly logger?: Logger;
}

/** The kit's task service: the admin kit under its default forms, and the read/write kit's get and update. */
export function defineTaskService(options: TaskServiceOptions = {}) {
  return qd.defineService(taskContract, {
    model: "task",
    access: inherit({ from: projectContract, via: "projectId" }),
    collections: { board: { anchor: projectContract } },
    adminBypass: options.adminBypass ?? true,
    methods: {
      ...crud.handlers(taskContract, {
        access: { get: { entry: "Read" }, update: { entry: "Moderate" } },
      }),
      ...admin.handlers(taskContract, {
        ...(options.hiddenFields === undefined ? {} : { hiddenFields: options.hiddenFields }),
        ...(options.displayName === undefined ? {} : { displayName: options.displayName }),
        ...(options.onWrite === undefined ? {} : { onWrite: options.onWrite }),
        ...(options.onCommitted === undefined ? {} : { onCommitted: options.onCommitted }),
      }),
    },
  });
}

/** Tasks of `projectId` titled `titles`, written untracked; their ids in that order. */
export async function addTasks(
  prisma: PrismaClient,
  projectId: string,
  titles: readonly string[],
  data: { readonly status?: string; readonly pinned?: boolean } = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, title] of titles.entries()) {
    const task = await prisma.task.create({
      data: { projectId, title, ordinal: (index + 1) * 10, ...data },
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
export function adminApp() {
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
      throw new Error("the admin harness has no database yet");
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
      const service = defineTaskService(options);
      const app = await createTestApp({
        services: [projectService, service],
        db: current().db,
        ...(options.logger === undefined ? {} : { logger: options.logger }),
      });
      apps.push(app as unknown as TestApp);
      return { app, service };
    },
    /** Closes `app` after the test. */
    track(app: TestApp): void {
      apps.push(app);
    },
  };
}

/** A service administrator: `userId` with a service-wide `Admin` grant on the task service. */
export function serviceAdmin(userId: string) {
  return as(userId, { taskService: "Admin" });
}
