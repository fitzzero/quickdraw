// The README's collections and change topics example.

import { defineContract } from "@fitzzero/quickdraw-core";
import { cardSchema, projectContract, taskSchema } from "@project/shared";
import { qd } from "../../quickdraw";

// #region contract
export const task = defineContract("taskService", {
  entity: taskSchema,
  projections: { card: cardSchema },
  methods: { ...crud.contract({ entity: taskSchema, get: true }) },
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
import { crud, inherit } from "@fitzzero/quickdraw-core/server";

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
  methods: { ...crud.handlers(task, { access: { get: { entry: "Read" } } }) },
});
// #endregion
