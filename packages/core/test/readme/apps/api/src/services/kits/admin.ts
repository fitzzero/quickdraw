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
      displayName: "Tasks", // the default: from the service name
      hiddenFields: ["notes"], // never shown, returned or written
      fieldOverrides: { assigneeId: { type: "relation", relationService: "userService" } },
    }),
  },
});
// #endregion
