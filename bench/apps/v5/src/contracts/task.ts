import { crud, defineContract, mutation, query } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { cardSchema, columnSchema, taskChangesSchema, taskSchema } from "./schemas";

/**
 * Tasks: the board the 4.1 app serves, declared for 5.0. The live board is
 * the `cardsByProject` collection (cards without the plan, the whole
 * project's index on the first page); `getTasksByStatus` is the board query
 * Conveyor's board makes (full rows, 20 per column, plus a count), fetched
 * again whenever the collection changes; `updateTask` writes a task, and
 * everyone watching it sees the change without a hand-written event.
 */
export const taskContract = defineContract("taskService", {
  entity: taskSchema,
  projections: { card: cardSchema },
  methods: {
    ...crud.contract({
      entity: taskSchema,
      get: true,
      list: { item: cardSchema, filter: ["projectId", "status"], sort: ["ordinal"] },
      update: { input: taskChangesSchema.partial() },
    }),
    getTasksByStatus: query({
      input: z.object({ projectId: z.string() }),
      output: z.array(columnSchema),
      watch: { collection: "cardsByProject", scope: (input) => input.projectId },
      describe: "The board: each column's first 20 tasks as full rows, and the column's count.",
    }),
    updateTask: mutation({
      input: taskChangesSchema.partial().extend({ id: z.string() }),
      output: "entity",
      describe: "Changes a task's title, column, position or assignee.",
    }),
  },
  collections: {
    cardsByProject: {
      scope: "projectId",
      item: "card",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
      index: ["status", "ordinal", "assigneeId"],
      views: {
        mine: (row, who) => row.assigneeId === who.userId,
        unassigned: (row) => row.assigneeId === null,
      },
    },
  },
});
