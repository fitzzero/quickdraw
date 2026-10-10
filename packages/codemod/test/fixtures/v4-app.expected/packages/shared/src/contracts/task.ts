// The contract of taskService, written by @fitzzero/quickdraw-codemod from
// TaskServiceMethods and the defineMethod calls of TaskService
// (apps/api/src/services/task/methods/archive.ts, apps/api/src/services/task/methods/create-task.ts, apps/api/src/services/task/methods/queries.ts, apps/api/src/services/task/methods/update-task.ts).
// Every marker below says what to check.

import { defineContract, listOf, mutation, query, todoSchema } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import type { TaskCard, TaskDTO } from "../types/task.js";
import { cuidSchema } from "./helpers.js";

const byTaskIdSchema = z.object({ id: z.string().min(1) });

const createTaskSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(200),
});

const updateTaskSchema = z.object({
  id: cuidSchema("task ID"),
  title: z.string().min(1).max(200).optional(),
  notes: z.string().max(10_000).nullable().optional(),
});

export const taskContract = defineContract("taskService", {
  // quickdraw-migrate: review [contract] the entity is the 4.x DTO TaskDTO: give it a real schema. Its keys are the fields subscribers receive, read from model "task": drop any that is not a column, or give it a projection select and map
  entity: todoSchema<TaskDTO>({ keys: ["id", "projectId", "title", "status", "ordinal", "assigneeId", "notes", "createdAt", "updatedAt"] }),
  methods: {
    // quickdraw-migrate: review [contract] mutation, chosen from its name
    archiveTask: mutation({ input: byTaskIdSchema, output: "entity" }),
    // quickdraw-migrate: review [contract] query, chosen from its name
    listArchivedTasks: query({ input: z.object({ projectId: z.string() }), output: listOf("entity") }),
    // quickdraw-migrate: review [contract] mutation, chosen from its name
    createTask: mutation({ input: createTaskSchema, output: "entity" }),
    // quickdraw-migrate: review [contract] query, chosen from its name; output: todoSchema of the 4.x response type
    listTasks: query({ input: z.object({ projectId: z.string() }), output: todoSchema<TaskCard[]>() }),
    // quickdraw-migrate: review [contract] mutation, chosen from its name; input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
    reindexProject: mutation({ input: todoSchema<{ projectId: string }>({ keys: ["projectId"] }), output: todoSchema<{ count: number }>() }),
    // quickdraw-migrate: review [contract] mutation, chosen from its name; output: "entity", where 4.x answered TaskDTO | null (null for a missing row, which a tracked write answers with NOT_FOUND instead); only an exact "entity" output is optimistic by default. Use nullable("entity") if the handler still answers null
    updateTask: mutation({ input: updateTaskSchema, output: "entity" }),
    // quickdraw-migrate: review [contract] mutation, chosen from its name; input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
    moveTask: mutation({ input: todoSchema<{ taskId: string; status: string; ordinal: number }>({ keys: ["taskId", "status", "ordinal"] }), output: todoSchema<{ id: string }>() }),
  },
});
