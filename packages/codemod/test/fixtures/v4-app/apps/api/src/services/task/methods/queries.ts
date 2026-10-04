import { z } from "zod";
import type { TaskService } from "../index.js";

export function registerTaskQueries(service: TaskService): void {
  service.defineMethod(
    "listTasks",
    "Read",
    async (payload, ctx) => {
      if (!ctx.userId || !(await service.checkProjectAccess(ctx.userId, payload.projectId, "Read"))) {
        throw new Error("Access denied to project");
      }
      const tasks = await service.prisma.task.findMany({
        where: { projectId: payload.projectId },
        orderBy: { ordinal: "asc" },
        take: 500,
      });
      return tasks.map((task) => service.toCard(task));
    },
    { schema: z.object({ projectId: z.string() }) },
  );

  // Renumber a whole board, then tell its subscribers to re-snapshot
  service.defineMethod("reindexProject", "Moderate", async (payload) => {
    const count = await service.prisma.$executeRaw`
      UPDATE "Task" SET "ordinal" = "ordinal" * 1024 WHERE "projectId" = ${payload.projectId}`;
    service.emitCollectionReset("byProject", payload.projectId);
    return { count };
  });
}
