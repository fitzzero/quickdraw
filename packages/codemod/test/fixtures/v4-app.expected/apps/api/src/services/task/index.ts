import { createTask } from "./methods/create-task.js";
import { listTasks, reindexProject } from "./methods/queries.js";
import { updateTask, moveTask } from "./methods/update-task.js";
import { qd } from "../../quickdraw.js";
import { taskContract } from "@project/shared";
import { resolver } from "@fitzzero/quickdraw-core/server";

// services/task/index.ts: the concrete subclass wires the method modules.
export const taskService = qd.defineService(taskContract, {
  model: "task",
  // quickdraw-migrate: review [access-override] 4.x decided row access in checkEntryACL (now functions in this file): port them to a policy (owner, jsonAcl, members, inherit, anyOf or resolver). Until then this policy grants no row, so only service grants pass
  access: resolver({ levelsFor: () => ({}) }),
  methods: {
    createTask,
    listTasks,
    reindexProject,
    updateTask,
    moveTask,
  },
});
