import type { PrismaClient } from "@project/db";
import type { TaskService } from "../index.js";
import { assignTask } from "../rows.js";

// Handlers that delegate to a function of their method's own name, as
// Conveyor's method modules do: an implementation imported under it, a local
// helper, an exported helper the service file calls as well, and the
// service's own helper of that name.

// The handler body, named after its method
async function renameTask(db: PrismaClient, id: string, title: string) {
  return await db.task.update({ where: { id }, data: { title } });
}

/** A task's title: the method's body, and a helper the service file imports. */
export async function getTaskTitle(db: PrismaClient, id: string): Promise<string | null> {
  const task = await db.task.findUnique({ where: { id }, select: { title: true } });
  return task?.title ?? null;
}

export function registerDelegates(service: TaskService): void {
  service.defineMethod("assignTask", "Moderate", async (payload) => {
    const task = await assignTask(service.prisma, payload.id, payload.assigneeId);
    return service.toTaskDto(task);
  });

  service.defineMethod("renameTask", "Moderate", async (payload) => {
    const task = await renameTask(service.prisma, payload.id, payload.title);
    return service.toTaskDto(task);
  });

  service.defineMethod("getTaskTitle", "Read", async (payload) => ({
    title: await getTaskTitle(service.prisma, payload.id),
  }));

  service.defineMethod("countTasks", "Read", async (payload) => ({
    count: await service.countTasks(payload.projectId),
  }));
}
