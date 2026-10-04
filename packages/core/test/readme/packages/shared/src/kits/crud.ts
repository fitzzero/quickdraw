import { crud, defineContract, mutation } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import { cardSchema, taskSchema } from "../schemas";

const newTaskSchema = z.object({ projectId: z.string(), title: z.string() });
const taskPatch = z.object({ title: z.string(), status: z.string() }).partial(); // every field optional

export const task = defineContract("taskService", {
  entity: taskSchema,
  projections: { card: cardSchema },
  methods: {
    ...crud.contract({
      entity: taskSchema,
      get: true,
      getMany: true,
      list: { item: cardSchema, filter: ["projectId", "status"], sort: ["ordinal", "title"] },
      create: { input: newTaskSchema },
      update: { input: taskPatch }, // the kit adds `id`
      delete: true,
      reorder: { column: "ordinal", within: "projectId" },
      bulkUpdate: { input: taskPatch }, // the kit adds `ids`
      bulkDelete: true,
    }),
    archive: mutation({ input: z.object({ id: z.string() }), output: "entity" }),
  },
});
