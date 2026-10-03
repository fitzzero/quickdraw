import { crud, defineContract, mutation } from "@fitzzero/quickdraw-core";
import { z } from "zod";

const label = z.object({ id: z.string(), projectId: z.string(), name: z.string() });

export const labelContract = defineContract("labelService", {
  entity: label,
  methods: {
    ...crud.contract({ entity: label, get: true, create: { input: label.omit({ id: true }) } }),
    rename: mutation({
      input: z.object({ id: z.string(), name: z.string() }),
      output: "entity",
      describe: "Renames a label.",
    }),
  },
  collections: {
    byProject: {
      scope: "projectId",
      item: "entity",
      order: [
        ["name", "asc"],
        ["id", "asc"],
      ],
    },
  },
});
