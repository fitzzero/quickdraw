import { checkProjectAccess, toCard } from "../service-core.js";
import type { MethodOf } from "../../../quickdraw.js";
import type { taskContract } from "@project/shared";

export const listTasks = {
  // quickdraw-migrate: review [access] "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
  access: "authenticated",
  handler: async ({ input, ctx, db }) => {
    // quickdraw-migrate: review [context] inline auth guard: the access form already requires a principal, so the !ctx.principal.userId part never holds; drop it (lint: no-inline-auth-guard)
    if (!ctx.principal.userId || !(await checkProjectAccess(ctx.principal.userId, input.projectId, "Read"))) {
      // quickdraw-migrate: review [error] 4.x sent this error's message to the caller; 5.0 answers an error that is not a QuickdrawError with INTERNAL and a generic message: throw new QuickdrawError(code, message) with the code that fits (NOT_FOUND, FORBIDDEN, CONFLICT, VALIDATION) if the caller should see it
      throw new Error("Access denied to project");
    }
    const tasks = await db.task.findMany({
      where: { projectId: input.projectId },
      orderBy: { ordinal: "asc" },
      take: 500,
    });
    return tasks.map((task) => toCard(task));
  },
} satisfies MethodOf<typeof taskContract, "listTasks">;

export const reindexProject = {
  access: { service: "Moderate" },
  handler: async ({ input, db }) => {
    // quickdraw-migrate: review [raw-sql] raw SQL write: tracked writes cannot see it, so subscribers would miss it; record the rows with ctx.touch(model, ids), or reset a scope with qd.collections.reset (lint: no-raw-sql-write)
    const count = await db.$executeRaw`
      UPDATE "Task" SET "ordinal" = "ordinal" * 1024 WHERE "projectId" = ${input.projectId}`;
    // quickdraw-migrate: review [emit] hand emit: send a reset with qd.collections.reset(contract, collection, scope), if one is still needed
    service.emitCollectionReset("byProject", input.projectId);
    return { count };
  },
} satisfies MethodOf<typeof taskContract, "reindexProject">;
