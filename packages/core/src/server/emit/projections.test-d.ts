// Type tests for projections in `defineService` (RFC 0003 sections 3 and 6),
// against the test schema's generated Prisma client: a projection handler
// returns the database row (dates and extra columns allowed), a mapped
// projection's handler returns what its `map` takes, and `project`,
// `affects`, `versionColumn` and `writes` are checked against the contract
// and the model. Each `@ts-expect-error` sits on the line the compiler
// reports.

import { describe, expectTypeOf, test } from "vitest";
import { z } from "zod";
import type { PrismaClient } from "../../../test/prisma/setup";
import { defineContract, listOf, nullable, query } from "../../index";
import { initQuickdraw, type HandlerRow, type RowFor } from "../index";

const qd = initQuickdraw<{ db: PrismaClient }>();

const taskEntity = z.object({
  id: z.string(),
  title: z.string(),
  notes: z.string().nullable(),
  updatedAt: z.string(),
});

const id = z.object({ id: z.string() });

const task = defineContract("taskService", {
  entity: taskEntity,
  projections: { card: z.object({ id: z.string(), title: z.string(), label: z.string() }) },
  methods: {
    get: query({ input: id, output: "entity" }),
    find: query({ input: id, output: nullable("entity") }),
    list: query({ input: z.object({}), output: listOf("entity") }),
    card: query({ input: id, output: "card" }),
  },
});

type Wire = z.output<typeof taskEntity>;

interface CardSource {
  readonly id: string;
  readonly title: string;
  readonly status: string;
}

const plain = {
  get: { access: "public", handler: () => ({ id: "t1", title: "T", notes: null, updatedAt: "" }) },
  find: { access: "public", handler: () => null },
  list: { access: "public", handler: () => [] },
  card: { access: "public", handler: () => ({ id: "t1", title: "T", label: "L" }) },
} as const;

const cardProject = {
  card: {
    select: { title: true, status: true },
    map: (row: CardSource) => ({
      id: row.id,
      title: row.title,
      label: `${row.status}: ${row.title}`,
    }),
  },
} as const;

describe("a projection handler's result", () => {
  test("is the database row: a Date where the wire has a string, extra columns allowed", () => {
    expectTypeOf<RowFor<Wire>>().toEqualTypeOf<{
      readonly id: string | Date;
      readonly title: string | Date;
      readonly notes: string | Date | null;
      readonly updatedAt: string | Date;
    }>();
    qd.defineService(task, {
      model: "task",
      methods: {
        ...plain,
        get: {
          access: "public",
          handler: ({ db }) => db.task.findUniqueOrThrow({ where: { id: "t1" } }),
        },
        find: {
          access: "public",
          handler: ({ db }) => db.task.findUnique({ where: { id: "t1" } }),
        },
        list: { access: "public", handler: ({ db }) => db.task.findMany({ take: 10 }) },
      },
    });
  });

  test("still needs every key of the projection", () => {
    qd.defineService(task, {
      model: "task",
      methods: {
        ...plain,
        // @ts-expect-error -- the row has no updatedAt
        get: { access: "public", handler: () => ({ id: "t1", title: "T", notes: null }) },
      },
    });
  });

  test("is what map takes for a projection with one", () => {
    type CardRow = HandlerRow<typeof task, "card", typeof cardProject>;
    expectTypeOf<CardRow>().toEqualTypeOf<CardSource>();
    qd.defineService(task, {
      model: "task",
      project: cardProject,
      methods: {
        ...plain,
        card: {
          access: "public",
          handler: ({ db }) =>
            db.task.findUniqueOrThrow({
              where: { id: "t1" },
              select: { id: true, title: true, status: true },
            }),
        },
      },
    });
    qd.defineService(task, {
      model: "task",
      project: cardProject,
      methods: {
        ...plain,
        // @ts-expect-error -- map takes a status, which the wire shape does not have
        card: { access: "public", handler: () => ({ id: "t1", title: "T", label: "L" }) },
      },
    });
  });
});

describe("the project option", () => {
  test("names projections of the contract, with their keys", () => {
    qd.defineService(task, { project: { entity: { keys: ["id", "title"] } }, methods: plain });
    qd.defineService(task, {
      // @ts-expect-error -- cards is not a projection of taskService
      project: { cards: { keys: ["id"] } },
      methods: plain,
    });
    qd.defineService(task, {
      // @ts-expect-error -- ownerId is not a key of the entity projection
      project: { entity: { keys: ["id", "ownerId"] } },
      methods: plain,
    });
  });
});

describe("affects, versionColumn and writes", () => {
  test("name columns and models of the app's client", () => {
    qd.defineService(task, {
      model: "task",
      writes: ["taskLabel"],
      affects: [
        { service: task, id: "parentTaskId" },
        { service: task, id: (row) => row.parentTaskId as string, columns: ["parentTaskId"] },
      ],
      versionColumn: "updatedAt",
      methods: plain,
    });
    qd.defineService(task, {
      model: "task",
      // @ts-expect-error -- parent is not a column of task
      affects: [{ service: task, id: "parent" }],
      methods: plain,
    });
    // @ts-expect-error -- modifiedAt is not a column of task
    qd.defineService(task, { model: "task", versionColumn: "modifiedAt", methods: plain });
    // @ts-expect-error -- tag is not a model of the app's client
    qd.defineService(task, { model: "task", writes: ["tag"], methods: plain });
  });

  test("affects and versionColumn need a model", () => {
    qd.defineService(task, {
      // @ts-expect-error -- without a model there are no written rows to follow
      affects: [{ service: task, id: "parentTaskId" }],
      methods: plain,
    });
    // @ts-expect-error -- without a model there is no version column
    qd.defineService(task, { versionColumn: "updatedAt", methods: plain });
  });
});
