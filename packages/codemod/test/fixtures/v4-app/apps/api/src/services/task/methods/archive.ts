import { z } from "zod";
import type { TaskServicePort } from "../service-ports.js";

const byTaskIdSchema = z.object({ id: z.string().min(1) });

// A helper that takes the port, which a handler calls
async function findTask(service: TaskServicePort, id: string) {
  return await service.prisma.task.findUnique({ where: { id } });
}

export function registerArchive(service: TaskServicePort): void {
  service.defineMethod(
    "archiveTask",
    "Moderate",
    async (payload) => {
      const task = await findTask(service, payload.id);
      if (!task) throw new Error("Task not found");
      const archived = await service.prisma.task.update({
        where: { id: task.id },
        data: { status: "archived" },
      });
      service.emitUpdate(archived.id, service.toTaskDto(archived));
      return service.toTaskDto(archived);
    },
    { schema: byTaskIdSchema, resolveEntryId: (p) => p.id },
  );

  service.defineMethod(
    "listArchivedTasks",
    "Read",
    async (payload) => {
      const tasks = await service.prisma.task.findMany({
        where: { projectId: payload.projectId, status: "archived" },
        orderBy: { updatedAt: "desc" },
        take: 100,
      });
      return tasks.map((task) => service.toTaskDto(task));
    },
    { schema: z.object({ projectId: z.string() }), resolveEntryId: (p) => p.projectId },
  );
}
