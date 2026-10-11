// The README's handler example.

import { defineContract, mutation, QuickdrawError } from "@fitzzero/quickdraw-core";
import { taskSchema } from "@project/shared";
import { z } from "zod";
import { qd } from "../../quickdraw";

const task = defineContract("taskService", {
  describe: "Tasks on a project's board.",
  entity: taskSchema,
  methods: {
    assign: mutation({
      input: z.object({ id: z.string(), assigneeId: z.string().nullable() }),
      output: "entity",
      describe: "Assigns a task to a user, or to nobody.",
    }),
  },
});

// #region handler
export const taskService = qd.defineService(task, {
  model: "task",
  methods: {
    assign: {
      access: { service: "Moderate" },
      // instead of the dispatcher's callTimeoutMs (30 s)
      timeoutMs: 5_000,
      handler: async ({ input, ctx, db }) => {
        const found = await db.task.findUnique({ where: { id: input.id } });
        if (found === null) {
          // the caller receives the code
          throw new QuickdrawError("NOT_FOUND", "No such task");
        }
        ctx.log.info("assigning", { by: ctx.principal.userId, transport: ctx.transport });
        return db.task.update({ where: { id: input.id }, data: { assigneeId: input.assigneeId } });
      },
    },
  },
});
// #endregion
