import { inherit } from "@fitzzero/quickdraw-core/server";
import { projectContract, taskContract } from "@project/shared";
import { qd } from "../quickdraw";

export const taskService = qd.defineService(taskContract, {
  model: "task", // the Prisma model its rows live in
  access: inherit({ from: projectContract, via: "projectId" }), // the level on the task's project
  collections: { board: { anchor: projectContract } }, // a board opens with Read on its project
  methods: {
    get: {
      access: { entry: "Read" },
      // return the row: the framework sends the projection's fields, dates as ISO strings
      handler: ({ input, db }) => db.task.findUniqueOrThrow({ where: { id: input.id } }),
    },
    create: {
      access: { scope: "Moderate", of: projectContract, id: "projectId" },
      handler: ({ input, db }) => db.task.create({ data: input }),
    },
    rename: {
      access: { entry: "Moderate" },
      handler: ({ input, db }) =>
        db.task.update({ where: { id: input.id }, data: { title: input.title } }),
    },
    countOnBoard: {
      access: { scope: "Read", of: projectContract, id: "projectId" },
      share: "caller", // identical concurrent calls by one user run once
      handler: ({ input, db }) => db.task.count({ where: { projectId: input.projectId } }),
    },
  },
});
