import { run } from "./tester.mjs";

const CONTRACT = "packages/shared/src/contracts/project.ts";

run("require-describe", {
  valid: [
    {
      name: "a contract whose every member says what it is for",
      filename: CONTRACT,
      code: `
        import { defineContract, mutation, query } from "@fitzzero/quickdraw-core";
        export const project = defineContract("projectService", {
          describe: "Projects and the boards they hold.",
          entity: projectSchema,
          methods: {
            get: query({ input: id, output: "entity", describe: "Reads one project by id." }),
            rename: mutation({ input: rename, output: "entity", describe: \`Renames a project, keeping its slug.\` }),
          },
          collections: {
            mine: { describe: "The projects a user owns.", scope: "ownerId", item: "entity", order: [["id", "asc"]] },
          },
          streams: { log: { item: line, describe: "The project's activity log." } },
          channels: { cursor: { payload: cursor, describe: "Where a member's cursor is." } },
          events: { archived: { payload: id, describe: "The project was archived." } },
        });
      `,
    },
    {
      name: "spreads and definitions built elsewhere, which may hold their own describe",
      filename: CONTRACT,
      code: `
        import { crud, defineContract, query } from "@fitzzero/quickdraw-core";
        export const project = defineContract("projectService", {
          ...shared,
          entity: projectSchema,
          methods: {
            ...crud.contract({ entity: projectSchema }),
            get: query({ ...readOne, input: id }),
            find: query(findDef),
          },
          collections: { mine: mineCollection, theirs: { ...theirsCollection } },
        });
        export const other = defineContract("otherService", definition);
      `,
    },
    {
      name: "a describe that is not a static string, and a short one under minWords 1",
      filename: CONTRACT,
      code: `
        import { defineContract, query } from "@fitzzero/quickdraw-core";
        export const project = defineContract("projectService", {
          describe: DESCRIPTIONS.project,
          methods: {
            get: query({ input: id, output: "entity", describe: \`Reads \${what}\` }),
            list: query({ input: id, output: "entity", describe: "Lists" }),
          },
        });
      `,
      options: [{ minWords: 1 }],
    },
    {
      name: "builders of an app's own, not quickdraw's",
      filename: CONTRACT,
      code: `
        import { defineContract, query } from "./builders";
        export const project = defineContract("projectService", { methods: { get: query({ input: id }) } });
      `,
    },
    {
      name: "a test file",
      filename: "packages/shared/src/contracts/__tests__/project.test.ts",
      code: `
        import { defineContract, query } from "@fitzzero/quickdraw-core";
        export const project = defineContract("projectService", { methods: { get: query({ input: id, output: "entity" }) } });
      `,
    },
  ],
  invalid: [
    {
      name: "every member of a migrated contract",
      filename: CONTRACT,
      code: `
        import { defineContract, mutation, query } from "@fitzzero/quickdraw-core";
        export const project = defineContract("projectService", {
          entity: projectSchema,
          methods: {
            get: query({ input: id, output: "entity" }),
            rename: mutation({ input: rename, output: "entity" }),
          },
          collections: {
            mine: { scope: "ownerId", item: "entity", order: [["id", "asc"]] },
          },
          streams: { log: { item: line } },
          channels: { cursor: { payload: cursor } },
          events: { archived: { payload: id } },
        });
      `,
      errors: [
        {
          message:
            "contract \"projectService\" has no `describe`. Say what it is for in a sentence or two: the MCP bridge uses a method's describe as its tool's description, and quickdraw-docs leads the member's section with it.",
          line: 3,
        },
        { message: /^method "get" has no `describe`/, line: 6 },
        { message: /^method "rename" has no `describe`/, line: 7 },
        { message: /^collection "mine" has no `describe`/, line: 10 },
        { message: /^stream "log" has no `describe`/, line: 12 },
        { message: /^channel "cursor" has no `describe`/, line: 13 },
        { message: /^event "archived" has no `describe`/, line: 14 },
      ],
    },
    {
      name: "a describe shorter than minWords",
      filename: CONTRACT,
      code: `
        import { defineContract, query } from "@fitzzero/quickdraw-core";
        export const project = defineContract("projectService", {
          describe: "Projects.",
          methods: { get: query({ input: id, output: "entity", describe: "Reads  one" }) },
        });
      `,
      errors: [
        {
          message:
            'contract "projectService"\'s `describe` has 1 word(s); write at least 3, a sentence an agent can act on.',
          line: 4,
        },
        { message: /^method "get"'s `describe` has 2 word\(s\); write at least 3/, line: 5 },
      ],
    },
    {
      name: "under local names, through a namespace import, and outside a contract",
      filename: "apps/api/src/methods.ts",
      code: `
        import { query as read } from "@fitzzero/quickdraw-core";
        import * as quickdraw from "@fitzzero/quickdraw-core";
        export const get = read({ input: id, output: "entity" });
        export const c = quickdraw.defineContract(name, { describe: "Something with a name." });
        export const m = quickdraw.mutation({ input: id, output: "entity" });
      `,
      errors: [{ message: /^this query has no/ }, { message: /^this mutation has no/ }],
    },
    {
      name: "a test file, when the app checks tests too",
      filename: "packages/shared/src/contracts/__tests__/project.test.ts",
      code: `
        import { defineContract } from "@fitzzero/quickdraw-core";
        export const project = defineContract("projectService", {});
      `,
      options: [{ ignore: [] }],
      errors: [{ messageId: "missing" }],
    },
  ],
});
