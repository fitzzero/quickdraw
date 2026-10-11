import { defineContract, search } from "@fitzzero/quickdraw-core";
import { cardSchema, taskSchema } from "../schemas";

export const task = defineContract("taskService", {
  describe: "Tasks on a project's board.",
  entity: taskSchema,
  projections: { card: cardSchema },
  methods: {
    // looks in title and notes; a call may keep to one scope of byProject
    ...search.contract({
      entity: taskSchema,
      // a scoped search's results are its collection's items
      item: cardSchema,
      fields: ["title", "notes"],
      scope: "byProject",
    }),
  },
  collections: {
    byProject: {
      describe: "A project's tasks, in board order.",
      scope: "projectId",
      item: "card",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
    },
  },
});
