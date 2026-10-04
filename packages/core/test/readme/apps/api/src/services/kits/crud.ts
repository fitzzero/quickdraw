import { projectContract } from "@project/shared";
import { task } from "../../../../../packages/shared/src/kits/crud";
import { qd } from "../../quickdraw";

// #region service
import { crud, inherit, nextOrdinal } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  methods: {
    ...crud.handlers(task, {
      access: {
        get: { entry: "Read" },
        getMany: "authenticated",
        list: "authenticated",
        create: { scope: "Moderate", of: projectContract, id: "projectId" },
        update: { entry: "Moderate" },
        delete: { entry: "Admin" },
        reorder: { entry: "Moderate" },
        bulkUpdate: "authenticated",
        bulkDelete: "authenticated",
      },
      // what `create` writes: columns from the principal, the next ordinal
      prepare: async (input, ctx, db) => ({
        ...input,
        assigneeId: ctx.principal.userId,
        ordinal: await nextOrdinal(db, "task", { projectId: input.projectId }),
      }),
    }),
    archive: {
      access: { entry: "Admin" },
      handler: ({ input, db }) =>
        db.task.update({ where: { id: input.id }, data: { status: "archived" } }),
    },
  },
});
// #endregion
