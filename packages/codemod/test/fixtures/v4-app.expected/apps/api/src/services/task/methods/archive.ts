import type { TaskServicePort } from "../service-ports.js";
import { toTaskDto } from "../service-core.js";
import type { MethodOf } from "../../../quickdraw.js";
import type { taskContract } from "@project/shared";

// A helper that takes the port, which a handler calls
async function findTask(service: TaskServicePort, id: string) {
  return await service.prisma.task.findUnique({ where: { id } });
}

export const archiveTask = {
  access: { service: "Moderate", entry: "Moderate", id: "id" },
  handler: async ({ input, db }) => {
    // quickdraw-migrate: review [this] uses the 4.x service instance itself, which no longer exists: pass what this code needs instead
    const task = await findTask(service, input.id);
    // quickdraw-migrate: review [error] 4.x sent this error's message to the caller; 5.0 answers an error that is not a QuickdrawError with INTERNAL and a generic message: throw new QuickdrawError(code, message) with the code that fits (NOT_FOUND, FORBIDDEN, CONFLICT, VALIDATION) if the caller should see it
    if (!task) throw new Error("Task not found");
    const archived = await db.task.update({
      where: { id: task.id },
      data: { status: "archived" },
    });
    // quickdraw-migrate: review [emit] hand emit: 5.0 sends entity frames from tracked writes; delete this once the write goes through db
    service.emitUpdate(archived.id, toTaskDto(archived));
    return toTaskDto(archived);
  },
} satisfies MethodOf<typeof taskContract, "archiveTask">;

export const listArchivedTasks = {
  access: { service: "Read", entry: "Read", id: "projectId" },
  handler: async ({ input, db }) => {
    const tasks = await db.task.findMany({
      where: { projectId: input.projectId, status: "archived" },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return tasks.map((task) => toTaskDto(task));
  },
} satisfies MethodOf<typeof taskContract, "listArchivedTasks">;
