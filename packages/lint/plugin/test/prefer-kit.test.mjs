import { SERVICE, SERVICE_TEST, run } from "./tester.mjs";

/** A service of model `model` whose `methods` hold `methods` (source text). */
function service(methods, model = "task") {
  return `
    export const s = qd.defineService(contract, {
      model: "${model}",
      access: inherit({ from: projectContract, via: "projectId" }),
      methods: {
        ${methods}
      },
    });
  `;
}

const GET = `{ access: { entry: "Read" }, handler: ({ input, db }) => db.task.findUniqueOrThrow({ where: { id: input.id } }) }`;
const LIST = `{ access: "authenticated", handler: ({ input, db }) => db.task.findMany({ where: { projectId: input.projectId }, take: 50 }) }`;
const CREATE = `{ access: { scope: "Moderate", of: projectContract, id: "projectId" }, handler: ({ input, db }) => db.task.create({ data: input }) }`;

run("prefer-kit", {
  valid: [
    // the read/write kit's names
    {
      name: "a service that spreads a kit's handlers chose what it hand-writes",
      filename: SERVICE,
      code: service(
        `...crud.handlers(contract, { access: { list: "authenticated" } }), get: ${GET}, create: ${CREATE}`,
      ),
    },
    {
      name: "a kit under another name counts: the e2e fixture app's crudKit",
      filename: SERVICE,
      code: service(
        `get: ${GET}, ...crudKit.handlers(contract, { access: { list: "authenticated" } })`,
      ),
    },
    {
      name: "a method that says why it is hand-written",
      filename: SERVICE,
      code: service(`
        // quickdraw: hand-written because it answers null for a missing task, as 4.x did
        get: ${GET},
      `),
    },
    {
      name: "the kit's own entry, changed: a spread of it, or the member itself",
      filename: SERVICE,
      code: service(
        `get: { ...taskKit.get, rowless: true }, list: taskKit.list, create: makeCreate()`,
      ),
    },
    // names formed from the model
    {
      name: "names of another model, and names that are not a kit's shape",
      filename: SERVICE,
      code: service(
        `getProject: ${GET}, listMyTasks: ${LIST}, getTasksByStatus: ${LIST}, rename: ${GET}`,
      ),
    },
    {
      name: "a service without a literal model cannot use a kit",
      filename: SERVICE,
      code: `
        export const health = qd.defineService(healthContract, { methods: { get: ${GET} } });
        export const dynamic = qd.defineService(contract, { model: modelName, methods: { getTask: ${GET} } });
      `,
    },
    {
      name: "a reason above every hand-written model method",
      filename: SERVICE,
      code: service(`
        // quickdraw: hand-written because it keeps the 4.x name its clients call
        getTask: ${GET},
        /* quickdraw: hand-written because the board pages by status */
        listTasks: ${LIST},
      `),
    },
    // the search kit
    {
      name: "a search beside the search kit's handlers",
      filename: SERVICE,
      code: service(`...search.handlers(contract, { access: "authenticated" }), search: ${LIST}`),
    },
    {
      name: "a search method named for what it finds",
      filename: SERVICE,
      code: service(`searchByTitle: ${LIST}, find: ${GET}`),
    },
    {
      name: "a search in a test file",
      filename: SERVICE_TEST,
      code: service(`search: ${LIST}`),
    },
    // the sharing kit
    {
      name: "sharing methods beside the sharing kit's handlers",
      filename: SERVICE,
      code: service(`...sharing.handlers(contract), share: ${CREATE}`, "project"),
    },
    {
      name: "sharing in a reason, and names that only look like sharing",
      filename: SERVICE,
      code: service(
        `
        // quickdraw: hand-written because invites go out by email first
        invite: ${CREATE},
        shareLink: ${CREATE},
        listMemberships: ${LIST},
      `,
        "project",
      ),
    },
    {
      name: "a defineService call without methods written out",
      filename: SERVICE,
      code: `export const s = qd.defineService(contract, { model: "project", methods: projectMethods });`,
    },
    // the admin kit
    {
      name: "admin methods beside the admin kit's handlers",
      filename: SERVICE,
      code: service(`...admin.handlers(contract), adminList: ${LIST}`),
    },
    {
      name: "an admin method with a reason",
      filename: SERVICE,
      code: service(`
        // quickdraw: hand-written because support staff list tasks across tenants
        adminList: ${LIST},
      `),
    },
    {
      name: "names that only start like the admin kit's",
      filename: SERVICE,
      code: service(`adminReport: ${LIST}, administer: ${GET}`),
    },
  ],
  invalid: [
    // the read/write kit's names
    {
      name: "a hand-written get, in a service that uses no kit",
      filename: SERVICE,
      code: service(`get: ${GET}`),
      errors: [
        {
          message:
            "`get` is written by hand, and the read/write kit's `get` implements it: `...crud.handlers(contract, { access })` (with `crud.contract` in the contract) checks access on every row it touches, pages and stays live. " +
            "Use the kit, or, if this method must be hand-written, say why in a `// quickdraw: hand-written because ...` comment above it.",
        },
      ],
    },
    {
      name: "list and create too, each reported at its name",
      filename: SERVICE,
      code: service(`list: ${LIST},\n create: ${CREATE},\n rename: ${GET}`),
      errors: [
        { messageId: "preferKit", line: 6 },
        { messageId: "preferKit", line: 7 },
      ],
    },
    {
      name: "a comment that gives no reason does not count",
      filename: SERVICE,
      code: service(`
        // quickdraw: hand-written
        update: ${CREATE},
        // hand-written because reasons
        delete: ${GET},
      `),
      errors: [{ messageId: "preferKit" }, { messageId: "preferKit" }],
    },
    // names formed from the model
    {
      name: "getTask, listTasks and createTask for model task",
      filename: SERVICE,
      code: service(`getTask: ${GET}, listTasks: ${LIST}, createTask: ${CREATE}`),
      errors: [{ messageId: "preferKit" }, { messageId: "preferKit" }, { messageId: "preferKit" }],
    },
    {
      name: "plurals: listCategories, listAddresses",
      filename: SERVICE,
      code: `
        export const a = qd.defineService(c, { model: "category", methods: { listCategories: ${LIST} } });
        export const b = qd.defineService(c, { model: "address", methods: { listAddresses: ${LIST} } });
      `,
      errors: [{ messageId: "preferKit" }, { messageId: "preferKit" }],
    },
    {
      name: "a method module's export, listed by name",
      filename: SERVICE,
      code: `
        import { getTask, renameTask } from "./methods";
        export const s = defineService(contract, { model: "task", methods: { getTask, renameTask } });
      `,
      errors: [{ messageId: "preferKit", line: 3 }],
    },
    // the search kit
    {
      name: "a hand-written search",
      filename: SERVICE,
      code: service(`search: ${LIST}`),
      errors: [
        {
          message:
            "`search` is written by hand, and the search kit's `search` implements it: `...search.handlers(contract, { access })` (with `search.contract` in the contract) checks access on every row it touches, pages and stays live. " +
            "Use the kit, or, if this method must be hand-written, say why in a `// quickdraw: hand-written because ...` comment above it.",
        },
      ],
    },
    {
      name: "a search on a project service",
      filename: SERVICE,
      code: service(`search: ${LIST}`, "project"),
      errors: [{ messageId: "preferKit" }],
    },
    {
      name: "a search listed by name",
      filename: SERVICE,
      code: `
        import { search } from "./search";
        export const s = qd.defineService(contract, { model: "task", methods: { search } });
      `,
      errors: [{ messageId: "preferKit" }],
    },
    // the sharing kit
    {
      name: "share, unshare and listMembers on a project",
      filename: SERVICE,
      code: service(`share: ${CREATE}, unshare: ${CREATE}, listMembers: ${LIST}`, "project"),
      errors: [
        {
          message:
            "`share` is written by hand, and the sharing kit's `share` implements it: `...sharing.handlers(contract)` (with `sharing.contract` in the contract) checks access on every row it touches, pages and stays live. " +
            "Use the kit, or, if this method must be hand-written, say why in a `// quickdraw: hand-written because ...` comment above it.",
        },
        { messageId: "preferKit" },
        { messageId: "preferKit" },
      ],
    },
    {
      name: "invite and remove",
      filename: SERVICE,
      code: service(`invite: ${CREATE}, remove: ${GET}`, "project"),
      errors: [{ messageId: "preferKit" }, { messageId: "preferKit" }],
    },
    {
      name: "a by-name invite",
      filename: SERVICE,
      code: service(`inviteByName: ${CREATE}`, "project"),
      errors: [{ messageId: "preferKit" }],
    },
    // the admin kit
    {
      name: "a hand-written adminList",
      filename: SERVICE,
      code: service(`adminList: ${LIST}`),
      errors: [
        {
          message:
            "`adminList` is written by hand, and the admin kit's `adminList` implements it: `...admin.handlers(contract)` (with `admin.contract` in the contract) checks access on every row it touches, pages and stays live. " +
            "Use the kit, or, if this method must be hand-written, say why in a `// quickdraw: hand-written because ...` comment above it.",
        },
      ],
    },
    {
      name: "adminGet and adminDelete",
      filename: SERVICE,
      code: service(`adminGet: ${GET}, adminDelete: ${GET}`),
      errors: [{ messageId: "preferKit" }, { messageId: "preferKit" }],
    },
    {
      name: "adminUpdate in any file but a test",
      filename: "apps/api/src/admin/tasks.ts",
      code: service(`adminUpdate: ${CREATE}`),
      errors: [{ messageId: "preferKit" }],
    },
  ],
});
