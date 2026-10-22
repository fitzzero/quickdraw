import type { PrismaClient } from "@project/db";
import { getTaskTitle } from "./methods/delegates.js";
import { defineTaskMethods } from "./methods/index.js";
import { assignTask } from "./rows.js";
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
      "assignTask",
      "renameTask",
      "getTaskTitle",
      "countTasks",
    ]);
  }
}

// Wrappers for jobs, which run outside a request, as Conveyor's cloud-build
// file keeps them beside its service: they share names with its methods.

/** Hands a task to someone: calls an implementation imported under a method's name. */
export async function handOver(db: PrismaClient, id: string, userId: string): Promise<void> {
  await assignTask(db, id, userId);
}

/** Renames a task for a job: a function of this file named after a method. */
export async function renameTask(db: PrismaClient, id: string, title: string): Promise<void> {
  await db.task.update({ where: { id }, data: { title } });
}

/** A task's title for a log line, through the helper the method module exports. */
export async function titleForLog(db: PrismaClient, id: string): Promise<string> {
  return (await getTaskTitle(db, id)) ?? id;
}

/** Counts a project's tasks, loading the implementations only when a job asks. */
export async function countProjectTasks(db: PrismaClient, projectId: string): Promise<number> {
  const { countTasks } = await import("./rows.js");
  return await countTasks(db, projectId);
}
