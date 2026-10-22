import type { PrismaClient } from "@project/db";
import { getTaskTitle, assignTask, renameTask as renameTaskMethod, getTaskTitleMethod, countTasks } from "./methods/delegates.js";
import { assignTask as assignTaskImpl } from "./rows.js";
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
    assignTask,
    renameTask: renameTaskMethod,
    getTaskTitle: getTaskTitleMethod,
    countTasks,
    // quickdraw-migrate: review [kit] listTasks has the shape of the read/write kit's list, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)
    listTasks,
    reindexProject,
    // quickdraw-migrate: review [kit] updateTask has the shape of the read/write kit's update, which checks access on every row it touches, pages and stays live: replace it with crud.handlers (crud.contract in the contract), or keep it with a "// quickdraw: hand-written because <reason>" comment above it (lint: prefer-kit)
    updateTask,
    moveTask,
  },
});

// Wrappers for jobs, which run outside a request, as Conveyor's cloud-build
// file keeps them beside its service: they share names with its methods.

/** Hands a task to someone: calls an implementation imported under a method's name. */
export async function handOver(db: PrismaClient, id: string, userId: string): Promise<void> {
  await assignTaskImpl(db, id, userId);
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
  const { countTasks: countTasksImpl } = await import("./rows.js");
  return await countTasksImpl(db, projectId);
}
