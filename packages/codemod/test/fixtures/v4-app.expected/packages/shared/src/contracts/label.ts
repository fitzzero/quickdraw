// The contract of labelService, written by @fitzzero/quickdraw-codemod from
// LabelServiceMethods and the defineMethod calls of LabelService
// (apps/api/src/services/label.ts).
// Every marker below says what to check.

import { defineContract, listOf, mutation, nullable, query, todoSchema } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import type { LabelDTO } from "../types/label.js";

export const labelContract = defineContract("labelService", {
  // quickdraw-migrate: review [contract] the entity is the 4.x DTO LabelDTO: give it a real schema. Its keys are the fields subscribers receive, read from model "label": drop any that is not a column, or give it a projection select and map
  entity: todoSchema<LabelDTO>({ keys: ["id", "projectId", "name"] }),
  methods: {
    // quickdraw-migrate: review [contract] query, chosen from its name; input: todoSchema, as 4.x had no schema
    getLabel: query({ input: todoSchema<{ id: string }>(), output: nullable("entity") }),
    // quickdraw-migrate: review [contract] mutation, chosen from its name; input: todoSchema, as 4.x had no schema
    renameLabel: mutation({ input: todoSchema<{ labelId?: string; name: string }>(), output: "entity" }),
    // quickdraw-migrate: review [contract] query, chosen from its name
    listLabels: query({ input: z.object({ projectId: z.string() }), output: listOf("entity") }),
    // quickdraw-migrate: review [contract] mutation, chosen from its name; input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
    deleteAllLabels: mutation({ input: todoSchema<{ projectId: string }>(), output: todoSchema<{ count: number }>() }),
  },
});
