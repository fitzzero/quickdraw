// The README's projections example.

import { defineContract, query } from "@fitzzero/quickdraw-core";
import { projectContract, taskSchema } from "@project/shared";
import { z } from "zod";
import { qd } from "../../quickdraw";

const cardSchema = z.object({
  id: z.string(),
  title: z.string(),
  status: z.string(),
  // computed: not a column
  labelCount: z.number(),
});

const task = defineContract("taskService", {
  entity: taskSchema,
  projections: { card: cardSchema },
  methods: {
    ...crud.contract({ entity: taskSchema, get: true }),
    card: query({ input: z.object({ id: z.string() }), output: "card" }),
  },
});

// #region projections
import { crud, inherit } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  // answers "not modified" from the row's own time
  versionColumn: "updatedAt",
  // a write to a subtask sends its parent again
  affects: [{ service: task, id: "parentTaskId" }],
  project: {
    // a relation count: read with select, built by a pure, synchronous map. Read the relation's
    // ids, which Prisma fetches for the rows read only; its _count aggregates the whole TaskLabel
    // table (a GROUP BY over every row) on every snapshot and flush
    card: {
      select: { title: true, status: true, labels: { select: { id: true } } },
      map: (row: { id: string; title: string; status: string; labels: { id: string }[] }) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        labelCount: row.labels.length,
      }),
    },
  },
  methods: {
    // the kit's get reads the entity's keys only, and sends dates as ISO strings
    ...crud.handlers(task, { access: { get: { entry: "Read" } } }),
    // returns the database row `map` takes: the framework builds the card from it
    card: {
      access: { entry: "Read" },
      handler: ({ input, db }) =>
        db.task.findUniqueOrThrow({
          where: { id: input.id },
          select: { id: true, title: true, status: true, labels: { select: { id: true } } },
        }),
    },
  },
});
// #endregion
