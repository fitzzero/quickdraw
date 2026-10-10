import { run } from "./tester.mjs";

const CONTRACT = "packages/shared/src/contracts/project.ts";

run("no-todo-schema", {
  valid: [
    {
      name: "a contract with real schemas",
      filename: CONTRACT,
      code: `
        import { defineContract, mutation } from "@fitzzero/quickdraw-core";
        import { z } from "zod";
        export const project = defineContract("projectService", {
          methods: { rename: mutation({ input: z.object({ id: z.string(), name: z.string() }), output: z.null() }) },
        });
      `,
    },
    {
      name: "a todoSchema of the app's own, not quickdraw's",
      filename: CONTRACT,
      code: `
        import { todoSchema } from "./placeholders";
        export const input = todoSchema();
      `,
    },
    {
      name: "the name imported from another entry, and a member of another object",
      filename: CONTRACT,
      code: `
        import { todoSchema } from "@fitzzero/quickdraw-core/server";
        import * as schemas from "./schemas";
        export const a = todoSchema();
        export const b = schemas.todoSchema();
      `,
    },
    {
      name: "imported but never called",
      filename: CONTRACT,
      code: `
        import { todoSchema } from "@fitzzero/quickdraw-core";
        export { todoSchema };
      `,
    },
  ],
  invalid: [
    {
      name: "every placeholder of a migrated contract",
      filename: CONTRACT,
      code: `
        import { defineContract, mutation, query, todoSchema } from "@fitzzero/quickdraw-core";
        export const project = defineContract("projectService", {
          entity: todoSchema<ProjectDTO>({ keys: ["id", "name"] }),
          methods: {
            get: query({ input: todoSchema<{ id: string }>(), output: "entity" }),
            rename: mutation({ input: renameSchema, output: todoSchema<{ id: string }>() }),
          },
        });
      `,
      errors: [
        {
          message:
            "`todoSchema()` is a placeholder left by the 4.x migration: it validates nothing, so any value passes as its type. Replace it with a real schema (Zod 4.2 or later where JSON Schema is read: MCP tools, admin metadata, projection keys).",
          line: 4,
        },
        {
          message:
            "`todoSchema()` is a placeholder left by the 4.x migration: it validates nothing, so any value passes as its type. Without `keys`, it also hides this input's keys from defineService's id-reach (rowless) check, which refuses an `id` input under an access form that checks no row; give it keys (`todoSchema<T>({ keys: [\"id\", ...] })`) until a real schema (Zod 4.2 or later) replaces it.",
          line: 6,
        },
        { messageId: "todoSchema", line: 7 },
      ],
    },
    {
      name: "a keyless placeholder input, under local names, a namespace and an assertion",
      filename: CONTRACT,
      code: `
        import { mutation as m, query, todoSchema as later } from "@fitzzero/quickdraw-core";
        import * as quickdraw from "@fitzzero/quickdraw-core";
        export const a = query({ input: later<{ id: string }>({}), output: "entity" });
        export const b = m({ output: "entity", input: later({ keys: [] }) as never });
        export const c = quickdraw.mutation({ input: quickdraw.todoSchema<{ id: string }>() });
      `,
      errors: [
        { messageId: "keylessInput", line: 4 },
        { messageId: "keylessInput", line: 5 },
        { messageId: "keylessInput", line: 6 },
      ],
    },
    {
      name: "the first message where keys are named or cannot be read, or the placeholder is no method input",
      filename: CONTRACT,
      code: `
        import { defineContract, mutation, query, todoSchema } from "@fitzzero/quickdraw-core";
        import { query as local } from "./methods";
        export const project = defineContract("projectService", {
          methods: {
            get: query({ input: todoSchema<{ id: string }>({ keys: ["id"] }), output: "entity" }),
            find: query({ input: todoSchema<{ id: string }>({ keys }), output: "entity" }),
            rename: mutation({ input: todoSchema<{ id: string }>(options), output: "entity" }),
            spread: mutation({ input: todoSchema<{ id: string }>({ ...options }), output: "entity" }),
            mine: local({ input: todoSchema<{ id: string }>() }),
            output: query({ input: z.null(), output: todoSchema<{ id: string }>() }),
          },
        });
        export const loose = { input: todoSchema<{ id: string }>() };
      `,
      errors: [
        { messageId: "todoSchema", line: 6 },
        { messageId: "todoSchema", line: 7 },
        { messageId: "todoSchema", line: 8 },
        { messageId: "todoSchema", line: 9 },
        { messageId: "todoSchema", line: 10 },
        { messageId: "todoSchema", line: 11 },
        { messageId: "todoSchema", line: 14 },
      ],
    },
    {
      name: "under a local name, and through a namespace import",
      filename: CONTRACT,
      code: `
        import { todoSchema as later } from "@fitzzero/quickdraw-core";
        import * as quickdraw from "@fitzzero/quickdraw-core";
        export const a = later<string>();
        export const b = quickdraw.todoSchema<number>();
      `,
      errors: [{ messageId: "todoSchema" }, { messageId: "todoSchema" }],
    },
    {
      name: "outside the shared package too",
      filename: "apps/api/src/services/project.ts",
      code: `
        import { todoSchema } from "@fitzzero/quickdraw-core";
        export const output = todoSchema();
      `,
      errors: [{ messageId: "todoSchema" }],
    },
  ],
});
