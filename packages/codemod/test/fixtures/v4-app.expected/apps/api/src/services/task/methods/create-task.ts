import { checkProjectAccess, toCard, toTaskDto } from "../service-core.js";
import type { MethodOf } from "../../../quickdraw.js";
import type { taskContract } from "@project/shared";

// One module per method (or cluster): defineMethod is public precisely so
// modules can register on the instance.

export const createTask = {
  // quickdraw-migrate: review [access] "Read" with no row id let every signed-in user call this in 4.x, and "authenticated" keeps that; narrow it ({ service: "Read" }, { entry: "Read", id } or a scope form) if that was not meant
  access: "authenticated",
  handler: async ({ input, ctx, db }) => {
    const allowed = await checkProjectAccess(ctx.principal.userId, input.projectId, "Moderate");
    // quickdraw-migrate: review [error] 4.x sent this error's message to the caller; 5.0 answers an error that is not a QuickdrawError with INTERNAL and a generic message: throw new QuickdrawError(code, message) with the code that fits (NOT_FOUND, FORBIDDEN, CONFLICT, VALIDATION) if the caller should see it
    if (!allowed) throw new Error("Access denied to project");

    const task = await db.task.create({
      data: { projectId: input.projectId, title: input.title },
    });
    // quickdraw-migrate: review [emit] hand emit: 5.0 sends collection deltas from tracked writes; write through db and let the tracked write emit, then delete this hand emit once the collection is declared in the contract
    service.emitCollectionUpsert("byProject", input.projectId, toCard(task));
    return toTaskDto(task);
  },
} satisfies MethodOf<typeof taskContract, "createTask">;
