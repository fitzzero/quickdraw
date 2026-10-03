import { admin, defineContract } from "@fitzzero/quickdraw-core";
import { taskSchema } from "../schemas";

export const task = defineContract("taskService", {
  entity: taskSchema, // Zod 4.2 or later: the fields come from its JSON Schema
  methods: {
    // adminList, adminGet, adminCreate, adminUpdate, adminDelete,
    // adminMeta, adminSubscribers, adminReemit; `expose` picks fewer
    ...admin.contract({ entity: taskSchema, filter: ["status"], sort: ["ordinal", "title"] }),
  },
});
