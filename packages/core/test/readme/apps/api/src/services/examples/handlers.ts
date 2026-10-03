// The README's handler example.

import { defineContract, mutation, QuickdrawError } from "@fitzzero/quickdraw-core";
import { taskSchema } from "@project/shared";
import { z } from "zod";
import { qd } from "../../quickdraw";

const task = defineContract("taskService", {
  entity: taskSchema,
  methods: {
    assign: mutation({
      input: z.object({ id: z.string(), assigneeId: z.string().nullable() }),
      output: "entity",
    }),
  },
});

// #region handler
export const taskService = qd.defineService(task, {
  model: "task",
  methods: {
    assign: {
      access: { service: "Moderate" },
      timeoutMs: 5_000, // instead of the dispatcher's callTimeoutMs (30 s)
      handler: async ({ input, ctx, db }) => {
        const found = await db.task.findUnique({ where: { id: input.id } });
        if (found === null) {
          throw new QuickdrawError("NOT_FOUND", "No such task"); // the caller receives the code
        }
        ctx.log.info("assigning", { by: ctx.principal.userId, transport: ctx.transport });
        return db.task.update({ where: { id: input.id }, data: { assigneeId: input.assigneeId } });
      },
    },
  },
});
// #endregion
