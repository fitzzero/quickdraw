// The README's collections and change topics example.

import { defineContract, query } from "@fitzzero/quickdraw-core";
import { cardSchema, projectContract, taskSchema } from "@project/shared";
import { z } from "zod";
import { qd } from "../../quickdraw";

// #region contract
export const task = defineContract("taskService", {
  entity: taskSchema,
  projections: { card: cardSchema },
  methods: { get: query({ input: z.object({ id: z.string() }), output: "entity" }) },
  collections: {
    byProject: {
      scope: "projectId", // a column holding the scope value
      item: "card", // the projection each item is sent as
      where: { status: "open" }, // membership: only open tasks
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ], // ends in "id": the keyset cursor
      index: ["ordinal", "assigneeId"], // sent for the whole scope
      views: { mine: (row, who) => row.assigneeId === who.userId },
    },
    assigned: { scope: "assigneeId", item: "card", order: [["id", "asc"]] }, // each user's own
  },
});
// #endregion

// #region service
import { inherit } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }), // derived from the anchor
  collections: {
    byProject: { anchor: projectContract }, // Read on the project opens its scope
    assigned: { scopeAccess: "self" }, // a user opens only the scope that is their id
  },
  watchAccess: { service: "Read" }, // opens the service topic to Read grants; closed without it
  methods: {
    get: {
      access: { entry: "Read" },
      handler: ({ input, db }) => db.task.findUniqueOrThrow({ where: { id: input.id } }),
    },
  },
});
// #endregion
