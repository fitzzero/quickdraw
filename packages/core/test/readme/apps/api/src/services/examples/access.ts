// The README's access control example.

import { defineContract, listOf, mutation, query } from "@fitzzero/quickdraw-core";
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
    triage: mutation({
      input: z.object({ id: z.string(), status: z.string() }),
      output: "entity",
      describe: "Sets a task's status, for a token that may triage.",
    }),
    assigned: query({
      input: z.object({ projectId: z.string().optional() }),
      output: listOf("entity"),
      describe: "Lists the caller's tasks, in one project when it names one.",
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
      access: { entry: "Moderate" },
      // users only: an agent acting for one is refused, whatever its grants
      kinds: ["user"],
      handler: ({ input, ctx, db }) =>
        db.task.update({ where: { id: input.id }, data: { assigneeId: ctx.principal.userId } }),
    },
    triage: {
      // Moderate on the task's project, from a token that may triage: claims add to the form
      access: { entry: "Moderate" },
      claims: (claims, input) => claims?.scope === "triage" && input.status !== "archived",
      handler: ({ input, db }) =>
        db.task.update({ where: { id: input.id }, data: { status: input.status } }),
    },
    assigned: {
      // Read on the project the input names, asked through ctx.access; none named, the caller's own
      access: custom(
        async (ctx, input) =>
          input.projectId === undefined || (await ctx.access.can(project, input.projectId, "Read")),
      ),
      handler: ({ input, ctx, db }) =>
        db.task.findMany({
          where: { assigneeId: ctx.principal.userId, projectId: input.projectId },
          take: 100,
        }),
    },
  },
});
// #endregion
