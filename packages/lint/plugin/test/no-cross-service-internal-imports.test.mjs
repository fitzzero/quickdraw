import { run } from "./tester.mjs";

const TASK = "apps/api/src/services/task/index.ts";
const RENAME = "apps/api/src/services/task/methods/rename.ts";

run("no-cross-service-internal-imports", {
  valid: [
    {
      name: "another service's index, by file or by directory",
      filename: TASK,
      code: `
        import { projectContract } from "../project/index.js";
        import { projectService } from "../project";
        export { labelService } from "../label/index.ts";
      `,
    },
    {
      name: "the service's own files, the shared directory and packages",
      filename: RENAME,
      code: `
        import { toCard } from "../card.js";
        import { qd } from "../../../quickdraw.js";
        import { requireRow } from "../../shared/rows.js";
        import { inherit } from "@fitzzero/quickdraw-core/server";
      `,
    },
    {
      name: "an allowlisted edge",
      filename: TASK,
      options: [{ allow: { task: ["project/queries.js"] } }],
      code: `import { projectsOf } from "../project/queries.js";`,
    },
    {
      name: "the composition root is not inside one service",
      filename: "apps/api/src/services/build-services.ts",
      code: `import { taskService } from "./task/methods/rename.js";`,
    },
  ],
  invalid: [
    {
      name: "another service's internal file",
      filename: TASK,
      code: `import { helper } from "../project/helpers.js";`,
      errors: [
        {
          message:
            '"../project/helpers.js" reaches into the `project` service\'s internal files from `task`. Import what `project` exports from its index, call it through `ctx.services`, or move the shared code to a `shared` directory.',
        },
      ],
    },
    {
      name: "re-exports and dynamic imports are the same edge",
      filename: TASK,
      code: `
        export { members } from "../project/members.js";
        export * from "../project/internal/acl.js";
        const lazy = () => import("../project/internal/acl.js");
      `,
      errors: [
        {
          messageId: "internalImport",
          data: { specifier: "../project/members.js", target: "project", source: "task" },
        },
        {
          messageId: "internalImport",
          data: { specifier: "../project/internal/acl.js", target: "project", source: "task" },
        },
        {
          messageId: "internalImport",
          data: { specifier: "../project/internal/acl.js", target: "project", source: "task" },
        },
      ],
    },
    {
      name: "from a nested file, and leaving the services directory to come back in",
      filename: RENAME,
      code: `
        import { projectsOf } from "../../project/queries.js";
        import { secret } from "../../../services/project/secret.js";
      `,
      errors: [
        {
          messageId: "internalImport",
          data: { specifier: "../../project/queries.js", target: "project", source: "task" },
        },
        {
          messageId: "internalImport",
          data: {
            specifier: "../../../services/project/secret.js",
            target: "project",
            source: "task",
          },
        },
      ],
    },
  ],
});
