import { projectContract } from "@project/shared";
import { task } from "../../../../../packages/shared/src/kits/admin";
import { qd } from "../../quickdraw";

// #region service
import { admin, inherit } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  methods: {
    ...admin.handlers(task, {
      // the default: from the service name
      displayName: "Tasks",
      // never shown, returned or written
      hiddenFields: ["notes"],
      // the only fields adminCreate and adminUpdate write; the rest are read-only
      editable: ["title", "status"],
      fieldOverrides: { assigneeId: { type: "relation", relationService: "userService" } },
    }),
  },
});
// #endregion

// #region prepare
import type { TrackedTransaction } from "@fitzzero/quickdraw-core/prisma";
import { nextOrdinal } from "@fitzzero/quickdraw-core/server";
import type { PrismaClient } from "@project/db";

export const taskAdmin = admin.handlers(task, {
  editable: ["projectId", "title", "status"],
  // runs before each write, in its transaction: `db` is that transaction's tracked client
  prepare: async (call, _ctx, db: TrackedTransaction<PrismaClient>) => {
    if (call.method === "adminCreate" && call.data.projectId !== undefined) {
      // written over the caller's data, a read-only column too: the new task goes last
      return { ordinal: await nextOrdinal(db, "task", { projectId: call.data.projectId }) };
    }
    if (call.method === "adminDelete") {
      // the database deletes the task's label links and clears its subtasks' parent,
      // unseen: do both here, tracked, so the rows and lists open on them are told
      await db.taskLabel.deleteMany({ where: { taskId: call.id } });
      await db.task.updateMany({ where: { parentTaskId: call.id }, data: { parentTaskId: null } });
    }
    return undefined;
  },
});
// #endregion
