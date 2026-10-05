import { crud, inherit } from "@fitzzero/quickdraw-core/server";
import { labelContract, projectContract } from "@project/shared";
import { qd } from "../../quickdraw";

export const labelService = qd.defineService(labelContract, {
  model: "label",
  access: inherit({ from: projectContract, via: "projectId" }),
  collections: { byProject: { anchor: projectContract } },
  methods: {
    ...crud.handlers(labelContract, {
      access: {
        get: { entry: "Read" },
        create: { scope: "Moderate", of: projectContract, id: "projectId" },
      },
    }),
    rename: {
      access: { entry: "Moderate" },
      handler: ({ input, db }) =>
        db.label.update({ where: { id: input.id }, data: { name: input.name } }),
    },
  },
});
