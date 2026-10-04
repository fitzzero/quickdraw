import { toTaskDto, toCard } from "../service-core.js";
import type { MethodOf } from "../../../quickdraw.js";
import type { taskContract } from "@project/shared";

export const updateTask = {
  access: { service: "Moderate", entry: "Moderate", id: "id" },
  // quickdraw-migrate: review [contract] the contract's output is "entity" (4.x answered TaskDTO | null): return the row, and let a missing one fail with NOT_FOUND (db.<model>.update throws it)
  handler: async ({ input, db }) => {
    const task = await db.task.update({
      where: { id: input.id },
      data: { title: input.title, notes: input.notes },
    });
    // quickdraw-migrate: review [emit] hand emit: 5.0 sends entity frames from tracked writes; delete this once the write goes through db
    service.emitUpdate(task.id, toTaskDto(task));
    return toTaskDto(task);
  },
} satisfies MethodOf<typeof taskContract, "updateTask">;

export const moveTask = {
  access: { service: "Moderate", entry: "Moderate", id: "taskId" },
  handler: async ({ input, db }) => {
    const task = await db.task.update({
      where: { id: input.taskId },
      data: { status: input.status, ordinal: input.ordinal },
    });
    // quickdraw-migrate: review [emit] hand emit: 5.0 sends entity frames from tracked writes; delete this once the write goes through db
    service.emitUpdate(task.id, toTaskDto(task));
    // quickdraw-migrate: review [emit] hand emit: 5.0 sends collection deltas from tracked writes; write through db and let the tracked write emit, then delete this hand emit once the collection is declared in the contract
    service.emitCollectionUpsert("byProject", task.projectId, toCard(task));
    return { id: task.id };
  },
} satisfies MethodOf<typeof taskContract, "moveTask">;
