// The README's access control example.

import { defineContract, mutation, query } from "@fitzzero/quickdraw-core";
import { projectSchema, taskSchema } from "@project/shared";
import { z } from "zod";
import { qd } from "../../quickdraw";

const project = defineContract("projectService", {
  entity: projectSchema,
  methods: { get: query({ input: z.object({ id: z.string() }), output: "entity" }) },
});

const task = defineContract("taskService", {
  entity: taskSchema,
  methods: {
    rename: mutation({ input: z.object({ id: z.string(), title: z.string() }), output: "entity" }),
    create: mutation({
      input: z.object({ projectId: z.string(), title: z.string() }),
      output: "entity",
    }),
    archiveAll: mutation({ input: z.undefined(), output: z.number() }),
    claim: mutation({ input: z.object({ id: z.string() }), output: "entity" }),
  },
});

// #region access
import { anyOf, custom, inherit, jsonAcl, members } from "@fitzzero/quickdraw-core/server";

export const projectService = qd.defineService(project, {
  model: "project", // the Prisma model the rows live in
  access: anyOf(
    jsonAcl("acl", { owner: "ownerId" }), // [{ userId, level }] plus Admin for the owner
    members({ model: "projectMember", entry: "projectId", user: "userId", level: "role" }),
  ),
  methods: {
    get: {
      access: { entry: "Read" },
      handler: ({ input, db }) => db.project.findUniqueOrThrow({ where: { id: input.id } }),
    },
  },
});

export const taskService = qd.defineService(task, {
  model: "task",
  access: inherit({ from: project, via: "projectId" }), // the level on the task's project
  methods: {
    rename: {
      access: { entry: "Moderate" },
      handler: ({ input, db }) =>
        db.task.update({ where: { id: input.id }, data: { title: input.title } }),
    },
    create: {
      access: { scope: "Moderate", of: project, id: "projectId" },
      handler: ({ input, db }) => db.task.create({ data: input }),
    },
    archiveAll: {
      access: { service: "Admin" },
      handler: async ({ db }) => (await db.task.updateMany({ data: { status: "archived" } })).count,
    },
    claim: {
      access: custom((ctx, input) => input.id.length > 0 && ctx.principal.kind === "user"),
      handler: ({ input, ctx, db }) =>
        db.task.update({ where: { id: input.id }, data: { assigneeId: ctx.principal.userId } }),
    },
  },
});
// #endregion
