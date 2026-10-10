import { crud, defineContract, mutation, query } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { cardSchema, taskSchema } from "../schemas";

export const taskContract = defineContract("taskService", {
  // what the service is for: MCP tools and the generated docs show it
  describe: "Tasks on a project's board.",
  // the full row; it must contain `id: string`
  entity: taskSchema,
  // lean shapes of the row
  projections: { card: cardSchema },
  // only callers with Admin on the task receive notes
  fields: { notes: "Admin" },
  methods: {
    // the read/write kit's get (one task by id) and create
    ...crud.contract({
      entity: taskSchema,
      get: true,
      // `id`: one the client may make (`newId()`), which the create keeps
      create: {
        input: z.object({ id: z.string().optional(), projectId: z.string(), title: z.string() }),
      },
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
      describe: "Counts the tasks on a project's board.",
    }),
  },
  collections: {
    // every task of a project, live, in board order
    board: {
      describe: "A project's tasks, in board order.",
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
