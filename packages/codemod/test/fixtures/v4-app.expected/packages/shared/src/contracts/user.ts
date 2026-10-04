// The contract of userService, written by @fitzzero/quickdraw-codemod from
// UserServiceMethods and the defineMethod calls of UserService
// (apps/api/src/services/user.ts).
// Every marker below says what to check.

import { defineContract, mutation, nullable, query, todoSchema } from "@fitzzero/quickdraw-core";
import { z } from "zod";
import type { UserDTO } from "../types/user.js";
import { cuidSchema } from "./helpers.js";

const updateUserSchema = z.object({
  id: cuidSchema("user ID"),
  name: z.string().min(1).max(50),
});

export const userContract = defineContract("userService", {
  // quickdraw-migrate: review [contract] the entity is the 4.x DTO UserDTO: give it a real schema. Its keys are the fields subscribers receive, read from model "user": drop any that is not a column, or give it a projection select and map
  entity: todoSchema<UserDTO>({ keys: ["id", "email", "name", "serviceAccess"] }),
  methods: {
    // quickdraw-migrate: review [contract] query, chosen from its name
    getMe: query({ input: z.object({}), output: nullable("entity") }),
    // quickdraw-migrate: review [contract] mutation, chosen from its name; output: todoSchema of the 4.x response type
    updateUser: mutation({ input: updateUserSchema, output: todoSchema<{ id: string; name: string } | { error: "name_taken" }>() }),
  },
});
