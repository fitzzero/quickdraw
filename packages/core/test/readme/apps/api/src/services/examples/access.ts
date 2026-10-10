// The README's access control example.

import { defineContract, mutation, query } from "@fitzzero/quickdraw-core";
import { projectSchema, taskSchema } from "@project/shared";
import { z } from "zod";
import { qd } from "../../quickdraw";

const project = defineContract("projectService", {
  describe: "Projects and who may see them.",
  entity: projectSchema,
  methods: {
    ...crud.contract({ entity: projectSchema, get: true }),
    title: query({
      input: z.object({ id: z.string() }),
      output: z.object({ name: z.string() }),
      describe: "Reads a project's name alone.",
    }),
  },
});

const task = defineContract("taskService", {
  describe: "Tasks on a project's board.",
  entity: taskSchema,
  methods: {
    rename: mutation({
      input: z.object({ id: z.string(), title: z.string() }),
      output: "entity",
      describe: "Renames a task.",
    }),
    ...crud.contract({
      entity: taskSchema,
      create: { input: z.object({ projectId: z.string(), title: z.string() }) },
    }),
    archiveAll: mutation({
      input: z.undefined(),
      output: z.number(),
      describe: "Archives every task, and counts them.",
    }),
    claim: mutation({
      input: z.object({ id: z.string() }),
      output: "entity",
      describe: "Assigns a task to the caller.",
    }),
  },
});

// #region access
import { anyOf, crud, custom, inherit, jsonAcl, members } from "@fitzzero/quickdraw-core/server";

export const projectService = qd.defineService(project, {
  // the Prisma model the rows live in
  model: "project",
  access: anyOf(
    // [{ userId, level }] plus Admin for the owner
    jsonAcl("acl", { owner: "ownerId" }),
    members({ model: "projectMember", entry: "projectId", user: "userId", level: "role" }),
  ),
  methods: {
    // the read/write kit's get: Read on the project itself
    ...crud.handlers(project, { access: { get: { entry: "Read" } } }),
    title: {
      // anyone may read any project's name by its id: the form is the whole check, on purpose
      access: "public",
      rowless: true,
      handler: async ({ input, db }) =>
        await db.project.findUniqueOrThrow({ where: { id: input.id }, select: { name: true } }),
    },
  },
});

export const taskService = qd.defineService(task, {
  model: "task",
  // the level on the task's project
  access: inherit({ from: project, via: "projectId" }),
  methods: {
    rename: {
      access: { entry: "Moderate" },
      handler: ({ input, db }) =>
        db.task.update({ where: { id: input.id }, data: { title: input.title } }),
    },
    // the kit's create: Moderate on the project the task goes into
    ...crud.handlers(task, {
      access: { create: { scope: "Moderate", of: project, id: "projectId" } },
    }),
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
