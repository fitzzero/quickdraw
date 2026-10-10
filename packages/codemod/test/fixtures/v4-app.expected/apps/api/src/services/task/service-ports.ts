import type { Prisma, PrismaClient, Task } from "@project/db";
import type { TaskCollections, TaskDTO, TaskServiceMethods } from "@project/shared";
// quickdraw-migrate: review [v4-api] 4.x API BaseService (removed): lint's no-v4-api names each replacement
import type { BaseService } from "@fitzzero/quickdraw-core/server";

// services/task/service-ports.ts: a split service hands its method modules a
// port, the members they use, instead of the class itself.
type TaskServiceBase = BaseService<
  Task,
  Prisma.TaskUncheckedCreateInput,
  Prisma.TaskUpdateInput,
  TaskServiceMethods,
  Record<string, never>,
  TaskDTO,
  TaskCollections
>;

// quickdraw-migrate: review [this] TaskServicePort was a port of the 4.x TaskService instance, the type its method modules took: those modules export method objects now, and the service object taskService has none of the instance's members. Delete it, or keep only what the helpers that still take it use
export type TaskServicePort = Pick<TaskServiceBase, "defineMethod" | "emitUpdate"> & {
  readonly prisma: PrismaClient;
  toTaskDto(task: Task): TaskDTO;
};
