import type { PrismaClient } from "@project/db";
import { defineTaskMethods } from "./methods/index.js";
import { TaskServiceCore } from "./service-core.js";
import type { TaskServicePort } from "./service-ports.js";

// services/task/index.ts: the concrete subclass wires the method modules.
export class TaskService extends TaskServiceCore implements TaskServicePort {
  constructor(prisma: PrismaClient) {
    super(prisma);
    defineTaskMethods(this);
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
