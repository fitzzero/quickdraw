// Type tests for the tracked client's type (`tracked.ts`, RFC 0003 section
// 5.2), on the Prisma 7 client generated from the test schema. `bun run
// typecheck` checks this file, and vitest's typecheck mode reports each
// block as a test. Each `@ts-expect-error` sits on the line the compiler
// reports, so a rule that stops failing breaks the typecheck.

import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../test/prisma/setup";
import {
  admin as adminContract,
  defineContract,
  query,
  type Tracked as RootTracked,
  type TrackedTransaction as RootTrackedTransaction,
} from "../index";
import { admin, inherit, initQuickdraw, type Principal } from "../server/index";
import { trackPrisma, type Tracked, type TrackedTransaction } from "./index";

declare const prisma: PrismaClient;
const db = trackPrisma(prisma);
type Db = typeof db;

/** Prisma's own client of an interactive transaction on the untracked client. */
type PrismaTransaction = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0];

/** A helper that writes outside transactions: it asks for the tracked client. */
async function archive(client: Tracked<PrismaClient>, id: string): Promise<void> {
  await client.project.update({ where: { id }, data: { archived: true } });
}

/** A helper that writes inside a transaction or outside one. */
async function rename(
  client: TrackedTransaction<PrismaClient>,
  id: string,
  title: string,
): Promise<string> {
  const task = await client.task.update({ where: { id }, data: { title } });
  return task.title;
}

describe("Tracked", () => {
  test("trackPrisma returns the client's type, tracked, which the root export names too", () => {
    expectTypeOf(db).toEqualTypeOf<Tracked<PrismaClient>>();
    expectTypeOf<RootTracked<PrismaClient>>().toEqualTypeOf<Tracked<PrismaClient>>();
    expectTypeOf<RootTrackedTransaction<PrismaClient>>().toEqualTypeOf<
      TrackedTransaction<PrismaClient>
    >();
  });

  test("a tracked client is a client, but the untracked client is no tracked one", () => {
    const client: PrismaClient = db;
    expectTypeOf(client).toEqualTypeOf<PrismaClient>();
    expectTypeOf(prisma).not.toExtend<Tracked<PrismaClient>>();
    // the app's client type, already tracked, is a tracked client's type too
    expectTypeOf(db).toExtend<Tracked<Db>>();
    expectTypeOf(prisma).not.toExtend<Tracked<Db>>();
    void archive(db, "p1");
    // @ts-expect-error the untracked client is not tracked
    void archive(prisma, "p1");
    // @ts-expect-error nor is it a tracked transaction's client
    void rename(prisma, "t1", "Renamed");
  });

  test("model delegates and the client's own members infer as before", async () => {
    expectTypeOf(db.task).toEqualTypeOf<PrismaClient["task"]>();
    expectTypeOf(db.$queryRaw).toEqualTypeOf<PrismaClient["$queryRaw"]>();
    const row = await db.task.findUniqueOrThrow({ where: { id: "t1" }, select: { title: true } });
    expectTypeOf(row).toEqualTypeOf<{ title: string }>();
  });

  test("an interactive transaction's tx is tracked, a nested one's too, with Prisma's options", async () => {
    const title = await db.$transaction(async (tx) => {
      expectTypeOf(tx).toEqualTypeOf<TrackedTransaction<PrismaClient>>();
      expectTypeOf(tx.task).toEqualTypeOf<PrismaTransaction["task"]>();
      await tx.$transaction(async (inner) => {
        expectTypeOf(inner).toEqualTypeOf<TrackedTransaction<PrismaClient>>();
      });
      // @ts-expect-error a transaction's client is not the whole client: it has no $connect
      void archive(tx, "p1");
      return await rename(tx, "t1", "Renamed");
    });
    expectTypeOf(title).toEqualTypeOf<string>();
    // the tracked client is a tracked transaction's client too
    expectTypeOf(await rename(db, "t1", "Renamed")).toEqualTypeOf<string>();
    const count = await db.$transaction(async (tx) => await tx.task.count(), {
      isolationLevel: "Serializable",
      timeout: 5_000,
    });
    expectTypeOf(count).toEqualTypeOf<number>();
    // @ts-expect-error not an isolation level
    await db.$transaction(async (tx) => await tx.task.count(), { isolationLevel: "Sometimes" });
  });

  test("the array form is Prisma's own", async () => {
    const [count, users] = await db.$transaction([
      db.task.count(),
      db.user.findMany({ select: { id: true } }),
    ]);
    expectTypeOf(count).toEqualTypeOf<number>();
    expectTypeOf(users).toEqualTypeOf<{ id: string }[]>();
  });

  test("the untracked client's transaction is Prisma's, not tracked", async () => {
    await prisma.$transaction(async (tx) => {
      expectTypeOf(tx).toEqualTypeOf<PrismaTransaction>();
      // @ts-expect-error the untracked client's transaction is not tracked
      await rename(tx, "t1", "Renamed");
    });
  });

  test("TrackedTransaction is one type, from the client tracked or not and from a transaction's", () => {
    expectTypeOf<TrackedTransaction<Db>>().toEqualTypeOf<TrackedTransaction<PrismaClient>>();
    expectTypeOf<TrackedTransaction<PrismaTransaction>>().toEqualTypeOf<
      TrackedTransaction<PrismaClient>
    >();
    expectTypeOf<TrackedTransaction<TrackedTransaction<PrismaClient>>>().toEqualTypeOf<
      TrackedTransaction<PrismaClient>
    >();
  });

  test("a client with extensions keeps them when tracked, in its transactions too", async () => {
    const extended = prisma.$extends({
      model: {
        task: {
          async retitle(id: string, title: string) {
            return await Promise.resolve({ id, title });
          },
        },
      },
      client: { greeting: () => "hello" as const },
    });
    const tracked = trackPrisma(extended);
    expectTypeOf(tracked).toEqualTypeOf<Tracked<typeof extended>>();
    expectTypeOf(tracked.greeting()).toEqualTypeOf<"hello">();
    expectTypeOf(tracked.task.retitle).toEqualTypeOf<typeof extended.task.retitle>();
    await tracked.$transaction(async (tx) => {
      expectTypeOf(tx).toEqualTypeOf<TrackedTransaction<typeof extended>>();
      expectTypeOf(tx.task.retitle).toEqualTypeOf<typeof extended.task.retitle>();
    });
    // an extension applied after trackPrisma (which should be the last) still infers
    const later = db.$extends({ client: { farewell: () => "bye" as const } });
    expectTypeOf(later.farewell()).toEqualTypeOf<"bye">();
  });
});

describe("the app's db, as handlers and the kits' callbacks see it", () => {
  const taskRow = z.object({
    id: z.string(),
    projectId: z.string(),
    title: z.string(),
    ordinal: z.number(),
  });
  const project = defineContract("projectService", {
    entity: z.object({ id: z.string(), name: z.string() }),
  });
  const task = defineContract("taskService", {
    entity: taskRow,
    methods: {
      ...adminContract.contract({ entity: taskRow }),
      get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    },
  });
  const rows = { model: "task", access: inherit({ from: project, via: "projectId" }) } as const;
  const qd = initQuickdraw<{ db: Db; principal: Principal }>();

  test("a handler's db is the tracked client, which a writer takes", () => {
    qd.defineService(task, {
      ...rows,
      methods: {
        ...admin.handlers(task),
        get: {
          access: { entry: "Read" },
          handler: async ({ input, db: client }) => {
            expectTypeOf(client).toEqualTypeOf<Db>();
            await rename(client, input.id, "Renamed");
            return await client.task.findUniqueOrThrow({ where: { id: input.id } });
          },
        },
      },
    });
  });

  test("a kit's callback may annotate db as the tracked client, its transaction's, or the client", () => {
    const get = {
      access: { entry: "Read" },
      handler: ({ input, db: client }: { input: { id: string }; db: Db }) =>
        client.task.findUniqueOrThrow({ where: { id: input.id } }),
    } as const;
    // the kit passes its transaction's client: TrackedTransaction<Db> says so
    qd.defineService(task, {
      ...rows,
      methods: {
        ...admin.handlers(task, {
          prepare: async (call, _ctx, client: TrackedTransaction<Db>) => {
            if (call.method === "adminUpdate") {
              await rename(client, call.id, "Renamed");
            }
            return undefined;
          },
          onWrite: async (write, _ctx, client: TrackedTransaction<Db>) => {
            await rename(client, write.id, "Renamed");
          },
        }),
        get,
      },
    });
    qd.defineService(task, {
      ...rows,
      methods: {
        ...admin.handlers(task, {
          onWrite: async (write, _ctx, client: Db) => {
            await archive(client, write.id);
          },
        }),
        get,
      },
    });
    qd.defineService(task, {
      ...rows,
      methods: {
        ...admin.handlers(task, { onWrite: (_write, _ctx, client: PrismaClient) => void client }),
        get,
      },
    });
    qd.defineService(task, {
      ...rows,
      // @ts-expect-error -- onWrite's db is not the app's client
      methods: {
        ...admin.handlers(task, {
          onWrite: (_write, _ctx, client: { readonly other: true }) => void client,
        }),
        get,
      },
    });
  });

  test("an app typed with the untracked client cannot give a kit callback the tracked one", () => {
    const untracked = initQuickdraw<{ db: PrismaClient; principal: Principal }>();
    untracked.defineService(task, {
      ...rows,
      // @ts-expect-error -- the app's client is not tracked
      methods: {
        ...admin.handlers(task, { onWrite: (_write, _ctx, client: Db) => void client }),
        get: {
          access: { entry: "Read" },
          handler: ({ input, db: client }) =>
            client.task.findUniqueOrThrow({ where: { id: input.id } }),
        },
      },
    });
  });
});
