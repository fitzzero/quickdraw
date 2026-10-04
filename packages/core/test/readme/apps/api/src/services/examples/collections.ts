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
      // a column holding the scope value
      scope: "projectId",
      // the projection each item is sent as
      item: "card",
      // membership: only open tasks
      where: { status: "open" },
      // ends in "id": the keyset cursor
      order: [
        ["ordinal", "asc"],
        ["id", "asc"],
      ],
      // sent for the whole scope
      index: ["ordinal", "assigneeId"],
      views: { mine: (row, who) => row.assigneeId === who.userId },
    },
    // each user's own
    assigned: { scope: "assigneeId", item: "card", order: [["id", "asc"]] },
  },
});
// #endregion

// #region service
import { inherit } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  // derived from the anchor
  access: inherit({ from: projectContract, via: "projectId" }),
  collections: {
    // Read on the project opens its scope
    byProject: { anchor: projectContract },
    // a user opens only the scope that is their id
    assigned: { scopeAccess: "self" },
  },
  // opens the service topic to Read grants; closed without it
  watchAccess: { service: "Read" },
  methods: {
    get: {
      access: { entry: "Read" },
      handler: ({ input, db }) => db.task.findUniqueOrThrow({ where: { id: input.id } }),
    },
  },
});
// #endregion
