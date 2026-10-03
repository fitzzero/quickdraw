import { defineContract, search } from "@fitzzero/quickdraw-core";
import { cardSchema, taskSchema } from "../schemas";

export const task = defineContract("taskService", {
  entity: taskSchema,
  projections: { card: cardSchema },
  methods: {
    // looks in title and notes; a call may keep to one scope of byProject
    ...search.contract({
      entity: taskSchema,
      item: cardSchema, // a scoped search's results are its collection's items
      fields: ["title", "notes"],
      scope: "byProject",
    }),
  },
  collections: {
    byProject: {
      scope: "projectId",
      item: "card",
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
    },
  },
});
