---
name: quickdraw-api-docs
description: Keep a quickdraw 5.0 app's API docs (the quickdraw-docs pages, which MCP clients and agents read) current - write a describe on every contract member, then either commit the pages and check them in pull-request CI, or install the docs-on-push workflow that regenerates them on every push to the base branch. Use when asked to "set up API docs", "document the MCP tools", "keep docs/api up to date", when generated docs conflict in merges, or when lint reports quickdraw/require-describe.
---

# Keep the API docs current

`quickdraw-docs` writes one Markdown page per service from its contract, and
an index. A page leads with the contract's `describe`; each method shows its
`describe`, its kind, its default MCP tool name (`{service}_{method}`; an
app's registry can rename tools, and `bind` can take arguments out of a
tool's schema, which the docs cannot see) and, for a query, the MCP
read-only hint; with `--services`, also who may call it. The
command and its options are in the README's "API docs from contracts"
section (`node_modules/@fitzzero/quickdraw-core/README.md`).

## 1. Write the describes

The docs and the MCP tools are only as useful as the prose in the contract.
Give every member a `describe` of a sentence or two that says what it is
for: the contract, each `query` and `mutation`, each collection, stream,
channel and event. The MCP bridge uses a method's describe as its tool's
description; without one an agent sees only `taskService.rename (mutation)`.

```ts
export const taskContract = defineContract("taskService", {
  describe: "Tasks on a project's board.",
  methods: {
    rename: mutation({ input: renameInput, output: "entity", describe: "Renames a task." }),
  },
  collections: {
    board: {
      describe: "A project's tasks, in board order.",
      scope: "projectId",
      item: "entity",
      order: [["id", "asc"]],
    },
  },
});
```

Lint's `quickdraw/require-describe` (a warning in the base config) lists
each member without one, and each static describe under 3 words. The 4.x
codemod writes none, so a migrated app starts with one warning per member.
Once the list is empty, set the rule to `"error"` in the app's
`.oxlintrc.json` so new members cannot land without one. Kits' contract
halves (`...crud.contract(...)`) write their own.

## 2. Pick where the pages live

| The repo                                                         | Do this                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Few pull requests at a time                                      | Commit the pages (`--out docs/api`) and run `quickdraw-docs ... --check` in pull-request CI |
| Many pull requests at a time, or agents that each change methods | Install the docs-on-push workflow below, and never commit the pages by hand                 |

A committed generated file changes in every pull request that touches a
contract, so two such pull requests conflict on it even when their
contracts do not. The workflow moves the pages out of pull requests: they
are regenerated after each push to the base branch.

## 3. Install the docs-on-push workflow

1. Copy `node_modules/@fitzzero/quickdraw-skills/skills/quickdraw-api-docs/docs-api.yml`
   to `.github/workflows/docs-api.yml`. GitHub reads only committed
   workflows, so `quickdraw-skills link` cannot install it.
2. Set it to the app:
   - `on.push.branches`: the base branch pull requests merge into.
   - `on.push.paths`: where the contracts and services live, and the
     workflow itself.
   - `env`: `CONTRACTS` (the module exporting the contracts), `SERVICES`
     (the module exporting the services) and `OUT` (the pages' folder).
   - The build step: the packages the services module imports, by the
     names in their `package.json` (the template's are `@project/db`, with
     its Prisma client, and `@project/shared`).
3. Remove any `quickdraw-docs --check` step from pull-request CI, and remove
   `OUT` from `.gitignore` if it is there.
4. Merge it, then run it once from the Actions tab (`workflow_dispatch`): the
   first run commits the pages.

### Rules

- **Never commit the pages by hand once the workflow is installed.** They
  belong to the workflow; a hand edit conflicts with its next commit and is
  overwritten by it. Change the contract instead.
- **The services module imports without secrets.** The `generate` job has
  none: importing the module must not read a required environment
  variable, connect to the database or start the server. Move such work
  into the function that starts the server.
- **Keep the two jobs.** The job that can write (`commit`, with
  `contents: write`) runs no dependency code: no install, no build, only
  git. The job that runs dependency code (`generate`) has a read-only token. Never
  trigger it with `pull_request_target`, and never give `generate` a secret.
- **Keep `GITHUB_TOKEN` for the push.** A push made with it starts no
  workflow run, so the docs commit never starts CI or this workflow again.
  On a protected branch that `GITHUB_TOKEN` cannot push to, mint a GitHub
  App token in the `commit` job only (`actions/create-github-app-token`),
  give it to that job's checkout, and add `[skip ci]` to the commit
  message: a push made with an app token does start workflows.

## 4. Check it

After the merge, the Actions tab shows an "API docs" run for each push that
touched a contract or a service. A run commits only when a page changed,
as `github-actions[bot]`. A failing `generate` step prints what
`quickdraw-docs` refused: usually a module that needs a build or a secret
at import.
