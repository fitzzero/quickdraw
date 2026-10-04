import { defineContract, mutation, query } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { cardSchema, taskSchema } from "../schemas";

export const taskContract = defineContract("taskService", {
  // the full row; it must contain `id: string`
  entity: taskSchema,
  // lean shapes of the row
  projections: { card: cardSchema },
  // only callers with Admin on the task receive notes
  fields: { notes: "Admin" },
  methods: {
    get: query({ input: z.object({ id: z.string() }), output: "entity" }),
    create: mutation({
      input: z.object({ projectId: z.string(), title: z.string() }),
      output: "entity",
    }),
    rename: mutation({
      input: z.object({ id: z.string(), title: z.string() }),
      output: "entity",
      describe: "Renames a task.",
    }),
    countOnBoard: query({
      input: z.object({ projectId: z.string() }),
      output: z.number(),
      // fetched again whenever the project's board changes
      watch: { collection: "board", scope: (input) => input.projectId },
    }),
  },
  collections: {
    // every task of a project, live, in board order
    board: {
      scope: "projectId",
      item: "card",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
      // sent for the whole board
      index: ["status", "ordinal", "assigneeId"],
      views: { mine: (row, who) => row.assigneeId === who.userId },
    },
  },
});
