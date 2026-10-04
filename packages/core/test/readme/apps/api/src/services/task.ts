import { crud, inherit } from "@fitzzero/quickdraw-core/server";
import { projectContract, taskContract } from "@project/shared";
import { qd } from "../quickdraw";

export const taskService = qd.defineService(taskContract, {
  // the Prisma model its rows live in
  model: "task",
  // the level on the task's project
  access: inherit({ from: projectContract, via: "projectId" }),
  // a board opens with Read on its project
  collections: { board: { anchor: projectContract } },
  methods: {
    // the kit implements get and create; each names who may call it
    ...crud.handlers(taskContract, {
      access: {
        get: { entry: "Read" },
        create: { scope: "Moderate", of: projectContract, id: "projectId" },
      },
    }),
    rename: {
      access: { entry: "Moderate" },
      // return the row: the framework sends the projection's fields, dates as ISO strings
      handler: ({ input, db }) =>
        db.task.update({ where: { id: input.id }, data: { title: input.title } }),
    },
    countOnBoard: {
      access: { scope: "Read", of: projectContract, id: "projectId" },
      // identical concurrent calls by one user run once
      share: "caller",
      handler: ({ input, db }) => db.task.count({ where: { projectId: input.projectId } }),
    },
  },
});
