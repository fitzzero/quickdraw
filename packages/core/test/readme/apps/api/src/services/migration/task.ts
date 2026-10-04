// MIGRATION.md's 5.0 task service: the 4.x TaskService of
// packages/codemod/test/guide-v4, migrated by hand to the end.

import { projectContract } from "@project/shared";
import { taskContract } from "../../../../../packages/shared/src/migration/contracts";
import { qd } from "../../quickdraw";

// #region service
import { inherit } from "@fitzzero/quickdraw-core/server";

export const taskService = qd.defineService(taskContract, {
  // was setDelegate(prisma.task)
  model: "task",
  // was checkEntryACL: the caller's role on the task's project, now one policy for every surface
  access: inherit({ from: projectContract, via: "projectId" }),
  // was afterUpdate touching the project: send the project row again after each flush
  affects: [{ service: projectContract, id: "projectId" }],
  // a board opens with Read on its project
  collections: { byProject: { anchor: projectContract } },
  methods: {
    // quickdraw: hand-written because it answers null for a missing task, as 4.x did
    getTask: {
      // 4.x read payload.id implicitly, and a service grant passed too
      access: { service: "Read", entry: "Read", id: "id" },
      handler: ({ input, db }) => db.task.findUnique({ where: { id: input.id } }),
    },
    renameTask: {
      access: { service: "Moderate", entry: "Moderate", id: "id" },
      // tracked: subscribers get the frame, the board its delta; NOT_FOUND where this.update returned null
      handler: ({ input, db }) =>
        db.task.update({ where: { id: input.id }, data: { title: input.title } }),
    },
    archiveAll: {
      // "Admin" with no row id needed the service grant in 4.x too
      access: { service: "Admin" },
      handler: async ({ input, ctx, db }) => {
        const { count } = await db.task.updateMany({
          where: { projectId: input.projectId },
          data: { status: "archived" },
        });
        // was this.emitToRoom(serviceRoom(...), "task:archived", ...)
        ctx.rooms.emit(`project:${input.projectId}`, taskContract, "archived", {
          projectId: input.projectId,
        });
        return { count };
      },
    },
  },
  channels: {
    // was defineChannel: relay each cursor to the project's room
    cursor: (payload, ctx) => {
      ctx.rooms.emit(`project:${payload.projectId}`, taskContract, "cursorMoved", payload);
    },
  },
});
// #endregion
