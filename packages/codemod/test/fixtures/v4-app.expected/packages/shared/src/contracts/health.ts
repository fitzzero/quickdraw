// The contract of healthService, written by @fitzzero/quickdraw-codemod from
// HealthServiceMethods and the defineMethod calls of HealthService
// (apps/api/src/services/health.ts).
// Every marker below says what to check.

import { defineContract, mutation, query, todoSchema } from "@fitzzero/quickdraw-core";

export const healthContract = defineContract("healthService", {
  methods: {
    // quickdraw-migrate: review [contract] query, since the web app reads it with useServiceQuery (its name reads as a mutation); input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
    ping: query({ input: todoSchema<Record<string, never>>(), output: todoSchema<{ ok: true; at: string }>() }),
    // quickdraw-migrate: review [contract] mutation, chosen from its name; input: todoSchema, as 4.x had no schema; output: todoSchema of the 4.x response type
    stats: mutation({ input: todoSchema<Record<string, never>>(), output: todoSchema<{ projects: number; tasks: number }>() }),
  },
});
