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
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    card: query({ input: z.object({ id: z.string() }), output: "card" }),
  },
});

// #region projections
import { inherit } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  // answers "not modified" from the row's own time
  versionColumn: "updatedAt",
  // a write to a subtask sends its parent again
  affects: [{ service: task, id: "parentTaskId" }],
  project: {
    // a relation count: read with select, built by a pure, synchronous map
    card: {
      select: { title: true, status: true, _count: { select: { labels: true } } },
      map: (row: { id: string; title: string; status: string; _count: { labels: number } }) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        labelCount: row._count.labels,
      }),
    },
  },
  methods: {
    // returns the database row: the projection's keys are sent, dates as ISO strings
    get: {
      access: { entry: "Read" },
      handler: ({ input, db }) => db.task.findUniqueOrThrow({ where: { id: input.id } }),
    },
    // returns what `map` takes
    card: {
      access: { entry: "Read" },
      handler: ({ input, db }) =>
        db.task.findUniqueOrThrow({
          where: { id: input.id },
          select: { id: true, title: true, status: true, _count: { select: { labels: true } } },
        }),
    },
  },
});
// #endregion
