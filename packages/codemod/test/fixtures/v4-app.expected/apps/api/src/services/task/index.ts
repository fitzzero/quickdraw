import { qd } from "../../quickdraw.js";
import { taskContract } from "@project/shared";
import { resolver } from "@fitzzero/quickdraw-core/server";
import { archiveTask, listArchivedTasks } from "./methods/archive.js";
import { createTask } from "./methods/create-task.js";
import { listTasks, reindexProject } from "./methods/queries.js";
import { updateTask, moveTask } from "./methods/update-task.js";

// services/task/index.ts: the concrete subclass wires the method modules.
export const taskService = qd.defineService(taskContract, {
  model: "task",
  // quickdraw-migrate: review [access-override] 4.x decided row access in checkEntryACL (now functions in this file): port them to a policy (owner, jsonAcl, members, inherit, everyone, anyOf or resolver). Until then this policy grants no row, so only service grants pass
  access: resolver({ levelsFor: () => ({}) }),
  methods: {
    archiveTask,
    listArchivedTasks,
    // quickdraw-migrate: review [kit] createTask has the shape of the read/write kit's create, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)
    createTask,
    // quickdraw-migrate: review [kit] listTasks has the shape of the read/write kit's list, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)
    listTasks,
    reindexProject,
    // quickdraw-migrate: review [kit] updateTask has the shape of the read/write kit's update, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)
    updateTask,
    moveTask,
  },
});
