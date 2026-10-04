// MIGRATION.md's split service: the 4.1 README's "Splitting Large Services"
// (an abstract *ServiceCore plus method modules) in 5.0 terms, as the codemod
// writes it. Three files, shown as one.

import type { AnyContract, MethodName } from "@fitzzero/quickdraw-core";
import type { MethodImplementation } from "@fitzzero/quickdraw-core/server";
import type { contracts } from "@project/shared";
import { projectContract } from "@project/shared";
import { taskContract } from "../../../../../packages/shared/src/migration/contracts";
import type { db } from "../../db";
import { type AppPrincipal, qd } from "../../quickdraw";

type AppTypes = { db: typeof db; principal: AppPrincipal; contracts: typeof contracts };

// #region split
// apps/api/src/quickdraw.ts (the codemod writes MethodOf there): any form but "public"
export type MethodOf<C extends AnyContract, M extends MethodName<C>> = MethodImplementation<
  AppTypes,
  C,
  M,
  "authenticated"
>;

// apps/api/src/services/task/methods/rename.ts: one module per method, or per cluster
export const renameTask = {
  access: { service: "Moderate", entry: "Moderate", id: "id" },
  handler: ({ input, db }) =>
    db.task.update({ where: { id: input.id }, data: { title: input.title } }),
} satisfies MethodOf<typeof taskContract, "renameTask">;

// apps/api/src/services/task/index.ts: the service lists them
import { inherit } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(taskContract, {
  model: "task",
  access: inherit({ from: projectContract, via: "projectId" }),
  collections: { byProject: { anchor: projectContract } },
  channels: { cursor: () => undefined },
  methods: {
    renameTask,
    getTask: {
      access: { service: "Read", entry: "Read", id: "id" },
      handler: ({ input, db }) => db.task.findUnique({ where: { id: input.id } }),
    },
    archiveAll: {
      access: { service: "Admin" },
      handler: async ({ input, db }) => {
        const { count } = await db.task.updateMany({
          where: { projectId: input.projectId },
          data: { status: "archived" },
        });
        return { count };
      },
    },
  },
});
// #endregion
