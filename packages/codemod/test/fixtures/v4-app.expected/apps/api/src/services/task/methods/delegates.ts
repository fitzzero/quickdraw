import type { PrismaClient } from "@project/db";
import { assignTask as assignTaskImpl, countTasks as countTasksImpl } from "../rows.js";
import { toTaskDto } from "../service-core.js";
import type { MethodOf } from "../../../quickdraw.js";
import type { taskContract } from "@project/shared";

// Handlers that delegate to a function of their method's own name, as
// Conveyor's method modules do: an implementation imported under it, a local
// helper, and an exported helper the service file calls as well.

// The handler body, named after its method
async function renameTaskBody(db: PrismaClient, id: string, title: string) {
  return await db.task.update({ where: { id }, data: { title } });
}

/** A task's title: the method's body, and a helper the service file imports. */
export async function getTaskTitle(db: PrismaClient, id: string): Promise<string | null> {
  const task = await db.task.findUnique({ where: { id }, select: { title: true } });
  return task?.title ?? null;
}

export const assignTask = {
  access: { service: "Moderate", entry: "Moderate", id: "id" },
  handler: async ({ input, db }) => {
    const task = await assignTaskImpl(db, input.id, input.assigneeId);
    return toTaskDto(task);
  },
} satisfies MethodOf<typeof taskContract, "assignTask">;

export const renameTask = {
  access: { service: "Moderate", entry: "Moderate", id: "id" },
  handler: async ({ input, db }) => {
    const task = await renameTaskBody(db, input.id, input.title);
    return toTaskDto(task);
  },
} satisfies MethodOf<typeof taskContract, "renameTask">;

export const getTaskTitleMethod = {
  access: { service: "Read", entry: "Read", id: "id" },
  handler: async ({ input, db }) => ({
    title: await getTaskTitle(db, input.id),
  }),
} satisfies MethodOf<typeof taskContract, "getTaskTitle">;

export const countTasks = {
  // quickdraw-migrate: review [access] "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
  access: "authenticated",
  handler: async ({ input, db }) => ({
    count: await countTasksImpl(db, input.projectId),
  }),
} satisfies MethodOf<typeof taskContract, "countTasks">;
