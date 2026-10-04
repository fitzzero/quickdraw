import { z } from "zod";
import type { TaskService } from "../index.js";

const createTaskSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(200),
});

// One module per method (or cluster): defineMethod is public precisely so
// modules can register on the instance.
export function registerCreateTask(service: TaskService): void {
  service.defineMethod(
    "createTask",
    "Read",
    async (payload, ctx) => {
      if (!ctx.userId) throw new Error("Authentication required");
      const allowed = await service.checkProjectAccess(ctx.userId, payload.projectId, "Moderate");
      if (!allowed) throw new Error("Access denied to project");

      const task = await service.prisma.task.create({
        data: { projectId: payload.projectId, title: payload.title },
      });
      service.emitCollectionUpsert("byProject", payload.projectId, service.toCard(task));
      return service.toTaskDto(task);
    },
    { schema: createTaskSchema },
  );
}
