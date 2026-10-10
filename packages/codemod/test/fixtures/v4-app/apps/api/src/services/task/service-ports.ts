import type { Prisma, PrismaClient, Task } from "@project/db";
import type { TaskCollections, TaskDTO, TaskServiceMethods } from "@project/shared";
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

export type TaskServicePort = Pick<TaskServiceBase, "defineMethod" | "emitUpdate"> & {
  readonly prisma: PrismaClient;
  toTaskDto(task: Task): TaskDTO;
};
