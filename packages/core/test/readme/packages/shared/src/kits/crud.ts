import { crud, defineContract, mutation } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { cardSchema, taskSchema } from "../schemas";

const newTaskSchema = z.object({ projectId: z.string(), title: z.string() });
// every field optional
const taskPatch = z.object({ title: z.string(), status: z.string() }).partial();

export const task = defineContract("taskService", {
  describe: "Tasks on a project's board.",
  entity: taskSchema,
  projections: { card: cardSchema },
  methods: {
    ...crud.contract({
      entity: taskSchema,
      get: true,
      getMany: true,
      list: { item: cardSchema, filter: ["projectId", "status"], sort: ["ordinal", "title"] },
      create: { input: newTaskSchema },
      // the kit adds `id`
      update: { input: taskPatch },
      delete: true,
      reorder: { column: "ordinal", within: "projectId" },
      // the kit adds `ids`
      bulkUpdate: { input: taskPatch },
      bulkDelete: true,
    }),
    archive: mutation({
      input: z.object({ id: z.string() }),
      output: "entity",
      describe: "Archives a task, which leaves its board.",
    }),
  },
});
