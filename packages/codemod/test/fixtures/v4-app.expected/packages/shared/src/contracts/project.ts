// The contract of projectService, written by @fitzzero/quickdraw-codemod from
// ProjectServiceMethods and the defineMethod calls of ProjectService
// (apps/api/src/services/project.ts).
// Every marker below says what to check.

import { defineContract, listOf, mutation, nullable, query, todoSchema } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import type { ProjectDTO, ProjectMemberDTO } from "../types/project.js";
import { byIdSchema, cuidSchema, paginationSchema } from "./helpers.js";

const createProjectSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
});

const shareProjectSchema = z.object({
  id: cuidSchema("project ID"),
  userId: cuidSchema("user ID"),
  level: z.enum(["Read", "Moderate", "Admin"]),
});

export const projectContract = defineContract("projectService", {
  // quickdraw-migrate: review [contract] the entity is the 4.x DTO ProjectDTO: give it a real schema. Its keys are the fields subscribers receive, read from model "project": drop any that is not a column, or give it a projection select and map
  entity: todoSchema<ProjectDTO>({
    keys: [
      "id",
      "name",
      "ownerId",
      "acl",
      // ── quickdraw-archive:start ──
      "archived",
      // ── quickdraw-archive:end ──
    ]
  }),
  methods: {
    // quickdraw-migrate: review [contract] mutation, chosen from its name; output: todoSchema of the 4.x response type
    createProject: mutation({ input: createProjectSchema, output: todoSchema<{ id: string }>() }),
    // quickdraw-migrate: review [contract] query, chosen from its name
    getProject: query({ input: byIdSchema, output: nullable("entity") }),
    // quickdraw-migrate: review [contract] mutation, chosen from its name; output: "entity", where 4.x answered ProjectDTO | null (null for a missing row, which a tracked write answers with NOT_FOUND instead); only an exact "entity" output is optimistic by default. Use nullable("entity") if the handler still answers null
    renameProject: mutation({ input: z.object({ id: cuidSchema("project ID"), name: z.string().min(1).max(100) }), output: "entity" }),
    // quickdraw-migrate: review [contract] query, chosen from its name
    listMyProjects: query({ input: paginationSchema, output: listOf("entity") }),
    // quickdraw-migrate: review [contract] mutation, chosen from its name; input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
    archiveProject: mutation({ input: todoSchema<{ id: string }>(), output: todoSchema<{ id: string; archived: true }>() }),
    // quickdraw-migrate: review [contract] mutation, chosen from its name; output: todoSchema of the 4.x response type
    deleteProject: mutation({ input: byIdSchema, output: todoSchema<{ id: string; deleted: true }>() }),
    // quickdraw-migrate: review [contract] query, chosen from its name; output: todoSchema of the 4.x response type
    getMembers: query({ input: z.object({ projectId: cuidSchema("project ID") }), output: todoSchema<ProjectMemberDTO[]>() }),
    // quickdraw-migrate: review [contract] mutation, chosen from its name; output: todoSchema of the 4.x response type
    shareProject: mutation({ input: shareProjectSchema, output: todoSchema<{ id: string }>() }),
  },
});
