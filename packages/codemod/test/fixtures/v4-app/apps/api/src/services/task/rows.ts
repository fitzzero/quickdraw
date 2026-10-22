import type { PrismaClient, Task } from "@project/db";

// services/task/rows.ts: implementation functions named after the methods that
// call them, as Conveyor's split services keep them. A method module's handlers
// import them, and so do the service file's wrappers.
export async function assignTask(
  db: PrismaClient,
  id: string,
  assigneeId: string | null,
): Promise<Task> {
  return await db.task.update({ where: { id }, data: { assigneeId } });
}

export async function countTasks(db: PrismaClient, projectId: string): Promise<number> {
  return await db.task.count({ where: { projectId } });
}
