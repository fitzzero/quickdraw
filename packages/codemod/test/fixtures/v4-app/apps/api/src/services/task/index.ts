import type { PrismaClient } from "@project/db";
import { registerArchive } from "./methods/archive.js";
import { registerCreateTask } from "./methods/create-task.js";
import { registerTaskQueries } from "./methods/queries.js";
import { registerUpdateTasks } from "./methods/update-task.js";
import { TaskServiceCore } from "./service-core.js";
import type { TaskServicePort } from "./service-ports.js";

// services/task/index.ts: the concrete subclass wires the method modules.
export class TaskService extends TaskServiceCore implements TaskServicePort {
  constructor(prisma: PrismaClient) {
    super(prisma);
    registerCreateTask(this);
    registerUpdateTasks(this);
    registerTaskQueries(this);
    registerArchive(this);
    this.verifyAllMethods([
      "createTask",
      "updateTask",
      "moveTask",
      "listTasks",
      "reindexProject",
      "archiveTask",
      "listArchivedTasks",
    ]);
  }
}
