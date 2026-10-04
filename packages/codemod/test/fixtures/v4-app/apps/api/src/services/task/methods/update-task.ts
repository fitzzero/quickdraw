import { z } from "zod";
import { cuidSchema } from "../../shared/schemas.js";
import type { TaskService } from "../index.js";

const updateTaskSchema = z.object({
  id: cuidSchema("task ID"),
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(10_000).nullable().optional(),
});

export function registerUpdateTasks(service: TaskService): void {
  service.defineMethod(
    "updateTask",
    "Moderate",
    async (payload, _ctx) => {
      const task = await service.prisma.task.update({
        where: { id: payload.id },
        data: { title: payload.title, notes: payload.notes },
      });
      service.emitUpdate(task.id, service.toTaskDto(task));
      return service.toTaskDto(task);
    },
    { schema: updateTaskSchema },
  );

  // Moving a card changes its column: re-emit the card to the board
  service.defineMethod(
    "moveTask",
    "Moderate",
    async (payload) => {
      const task = await service.prisma.task.update({
        where: { id: payload.taskId },
        data: { status: payload.status, ordinal: payload.ordinal },
      });
      service.emitUpdate(task.id, service.toTaskDto(task));
      service.emitCollectionUpsert("byProject", task.projectId, service.toCard(task));
      return { id: task.id };
    },
    { resolveEntryId: (p) => p.taskId },
  );
}
