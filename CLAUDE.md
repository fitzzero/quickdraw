# quickdraw-core — Project Context

`@fitzzero/quickdraw-core` is an npm package providing typed real-time
fullstack services: contracts (`defineContract`), services
(`qd.defineService`) with declared access and row policies, tracked Prisma
writes that drive live entities, collections and change topics, kits
(read/write, search, sharing, admin, presence and streams, auth routes),
Socket.IO, HTTP, MCP and in-process transports, and a typed React client over
TanStack Query. The reference consumer is the `quickdraw-chat` template
(sibling checkout at `../quickdraw-chat`), migrated to 5.0 on the release
candidates.

## Branches and design

`dev` is the integration branch; a release merges it into `main`. 4.x lives
on `release/4.x` (4.1.1 is `daf3d48`): 4.x hotfixes are cut from there, and
source comments cite 4.1's code as 4.1 `src/<path>:<line>`, a line of that
tree. `docs/rfcs/0003-v5.md` is the 5.0 design, and
`docs/rfcs/0003-v5-audit.md` is the audit and rationale behind it. Where a
card's plan and the RFC disagree, follow the RFC and say so in the PR.

## Layout

A bun workspace monorepo driven by turbo (`turbo.json`). Packages per
`docs/rfcs/0003-v5.md` section 1:

```
packages/
├── core/        # @fitzzero/quickdraw-core — the framework (5.0)
│   ├── src/         # 5.0 sources; built by tsup → dist/ (one entry per export,
│   │                #   plus src/cli/quickdraw-docs.ts, the `quickdraw-docs` bin;
│   │                #   src/cli/quickdraw-protocol.ts writes docs/protocol-v5.md, not built)
│   └── test/        # e2e suite (test/e2e, fixture app test/fixtures/app.ts),
│                    #   PGlite test schema (test/prisma), README examples (test/readme)
├── lint/        # @fitzzero/quickdraw-lint — oxlint plugin (plugin/, .mjs shipped
│                #   verbatim), oxlint.base.jsonc + oxlint.template.jsonc, `quickdraw-lint`
├── skills/      # @fitzzero/quickdraw-skills — agent rules (rules/*.md), skills
│                #   (skills/*/SKILL.md) and the `quickdraw-skills link` bin (bin/cli.mjs)
└── codemod/     # @fitzzero/quickdraw-codemod — the 4.x→5.0 codemod (ts-morph, src/ built by
                 #   tsup → dist/, the `quickdraw-codemod` bin); its tests run it on a 4.1
                 #   fixture app (test/fixtures/v4-app, snapshot in v4-app.expected) and
                 #   typecheck the guide's 4.x examples (test/guide-v4) against 4.1.0
examples/godot/  # the GDScript reference client for protocol v5 (private workspace, never
                 #   published): addons/quickdraw/quickdraw_client.gd, its Node wire test
                 #   (`test`) and its Godot check (`check:godot`, CI's godot job)
bench/           # load harness (private workspace) + bench/apps/* + committed baselines;
                 #   a release tool, not a CI gate (bench/README.md, docs/benchmarks.md)
docs/rfcs/       # design records; 0003-v5.md is the 5.0 design
docs/protocol-v5.md  # the wire specification for non-JS clients, generated from
                 #   packages/core/src/protocol/envelope.ts (`bun run protocol:sync` in
                 #   packages/core; never edited by hand); docs/clients.md, the ways in
README.md        # the core package's README (5.0); its code examples are copies
                 #   of packages/core/test/readme (see "README examples" below);
                 #   packages/core/README.md and each package's LICENSE are copies
MIGRATION.md     # the 4.x→5.0 guide; examples copied the same way (5.0 from
                 #   test/readme, 4.x from packages/codemod/test/guide-v4); its
                 #   removed-names appendix comes from `bun run guide:sync` in
                 #   packages/codemod; packages/codemod/MIGRATION.md is a copy
UPGRADE-PROMPT.md  # the 5.0 upgrade procedure for agents (codemod, report, order)
tsconfig.base.json  # shared compiler flags; each package's tsconfig.json extends it
```

Each package's export map lives in its own `package.json`. Core's has `.`
(contracts, kits' contract halves, errors, protocol types; browser-safe and
dependency-free), `./server`, `./server/auth`, `./server/express`,
`./server/mcp`, `./server/otel`, `./prisma`, `./client` (opens with
`"use client"`), `./utils` (isomorphic: `createServerCaller`, cache keys,
formatting), `./parser` (the JSON-only Socket.IO parser, kept out of the
root), `./testing`, `./testing/client` and `./testing/prisma`, with one tsup
entry per export and shared chunks (`splitting`), plus the `quickdraw-docs`
bin (`src/cli/`). `packages/core/scripts/dist-smoke.mjs` checks the built
output, including the `"use client"` that must open `dist/client/index.js`.
Tests sit next to sources (`*.test.ts(x)`) and are typechecked. Core's vitest
config has three projects: `node` (`*.test.ts`), `dom` (`*.test.tsx`, jsdom)
and `types` (`*.test-d.ts`).

### README examples

Every TypeScript block in `README.md` and in the
`quickdraw-new-service` skill is a copy of a file (or a `// #region <name>`
of one) under `packages/core/test/readme/`, a small app in the template's
layout that `bun run typecheck` compiles through
`packages/core/test/readme/tsconfig.json` (it maps the package's own name to
`src/`, `@project/db` to a client over the test schema). A block follows a
`<!-- example: <file>[#region] -->` marker. Edit the source file, then run
`bun run readme:sync` in `packages/core` and `bun run format`;
`test/readme/readme.test.ts` fails on a stale copy or an unmarked
TypeScript block. Vitest never runs the example app itself. The same
command writes the copies the packages ship (`npm pack` adds a package's
own README.md and LICENSE): `packages/core/README.md` (the root README with
its relative links made relative to `packages/core`) and the `LICENSE` of
core, lint and skills (`test/readme/packageFiles.ts`); the test checks them
too, so run it after any README change.

## Commands (bun, never npm/pnpm)

Run from the repo root; turbo fans out to the packages that define the script.

```bash
bun install            # workspace install; `prepare` runs husky, conveyor-skills link
                       #   and quickdraw-skills link
bun run build          # turbo: tsup → packages/core/dist/ (ESM + d.ts + sourcemaps)
bun run typecheck      # turbo: tsgo --noEmit per package (core: src + tests, then test/readme)
bun run lint           # turbo: oxlint -c ../../.oxlintrc.json per package (core: src test)
bun run test           # turbo: vitest run per package; node --test for packages/skills
                       #   (the two-node cluster suite is separate: `bun run test:cluster` in
                       #   packages/core, QD_CLUSTER=1, Valkey from test/cluster/docker-compose.yml)
bun run format         # oxfmt --write . (repo-wide, not through turbo)
bun run format:check   # oxfmt --check . (repo-wide)
```

In `packages/core`: `bun run readme:sync` (README examples, above),
`bun run protocol:sync` (rewrites `docs/protocol-v5.md` from the protocol's
sources; `protocol:check` fails when it is stale, and a test does too) and
`bun run db:generate` (the gitignored test Prisma client; turbo runs it before
typecheck and test). `quickdraw-skills link --check` (from the root) checks
the committed `.claude/` links; CI runs it. In `examples/godot`:
`bun run check:godot` runs the GDScript client in Godot 4 (on the PATH, or
`GODOT`) against a real server, after `bun run build`.

Husky hooks: pre-commit runs `bun run format:check`; pre-push runs
`bun run typecheck && bun run lint`. Node 24 (`.nvmrc`, `engines`).
CI (`.github/workflows/ci.yml`) runs the `quickdraw-skills link --check`,
`protocol:check` (in `packages/core`), lint, format:check, typecheck, build
(plus the dist smoke test, publint and arethetypeswrong), test and a secret
scan on every pull request, whatever its base branch, and on pushes to `main`
and `dev`. Two more jobs are path-gated on pull requests (a `*-changes` job
decides; on pushes they always run, and a skipped one counts as passed): the
`godot` job runs `check:godot` with the official Godot build when a pull
request touches `examples/godot`, core's protocol, realtime, transport or
testing code, `docs/protocol-v5.md`, the dependencies or the workflow; the
`cluster` job runs `test:cluster` behind a Valkey service when it touches
core's sources or tests, its vitest config or manifest, the lockfile, the
root `package.json` or `tsconfig.base.json`, or the workflow.

## Linting

`packages/lint/oxlint.base.jsonc` is the framework's shipped lint baseline —
consumers extend it from `node_modules/@fitzzero/quickdraw-lint/` (see
`packages/lint/README.md`; the design-system rules are in
`oxlint.template.jsonc`). This repo dogfoods it via the root `.oxlintrc.json`,
which downgrades currently-violated rules to `warn` (tracked debt — fix over
time, then re-tighten), exempts `**/src/client/**` from the client rules
(`no-raw-socket`, `no-untyped-client`, `no-manual-refetch`,
`no-await-void-mutate`: the framework's client is the sanctioned home of raw
sockets and TanStack calls; these rules find client code by its imports as
well as by path), exempts `**/src/testing/**` and bench's `**/src/drivers/**`
from `no-raw-socket` (the test helpers and the load harness drive sockets by
hand), exempts the framework's own `*.test.ts(x)` from
`no-nested-write` and `no-foreign-write` (they make those writes on purpose),
and lets the README examples (`**/test/readme/**`) keep inline comments.
oxlint matches `overrides` and `ignorePatterns` globs against paths as seen
from where it runs, so keep them `**/`-prefixed: lint runs from each package
directory. When adding a lint rule
that all quickdraw apps should get, put it in `packages/lint/oxlint.base.jsonc`
(or a new rule in `packages/lint/plugin/`, with a test under
`packages/lint/plugin/test/`), not in downstream repos.

## Developing against quickdraw-chat

quickdraw-chat depends on the published npm version. For local iteration,
point the sibling checkout at this repo temporarily (e.g. `bun link`, or for
lint-config work just extend `../quickdraw/packages/lint/oxlint.base.jsonc`), but always
verify + commit against a published version.

## Conveyor pods

A card on the Conveyor `quickdraw` project runs in a pod that boots from an
image Conveyor bakes from `dev` on the repository's self-hosted runner. The
bake's setup command is `bash scripts/bake-setup.sh`: the frozen install CI
makes, then `turbo run db:generate build`. Change what a pod starts with
there; on `dev`, a change under `scripts/`, to a `package.json` or to
`bun.lock` starts a new bake. `.github/workflows/conveyor-prebake.yml` and
`.devcontainer/conveyor/` are generated by Conveyor from the project's
settings and committed by it to `main` and `dev`: never edit them (Conveyor
overwrites an edit), and keep them in `.oxfmtrc.json`'s `ignorePatterns`,
because Conveyor does not run the formatter. A pod has the bake image's Node
and bun, which are newer than `.nvmrc` and `packageManager`, and no Docker,
Valkey or Godot: `test:cluster` and `check:godot` run in CI only.

## Publishing (done by the owner)

Publishing is owner-triggered; agents never bump for release, push tags or
publish. The owner pushes a `<package>-v<version>` tag (printed by
`scripts/release-tag.sh`) and `.github/workflows/publish.yml` publishes that
package with npm trusted publishing. The steps, the dist-tag rule and the
one-time npm setup are in `docs/releasing.md`.

## Domain-Specific Context

The 5.0 usage guidance ships in `@fitzzero/quickdraw-skills` (`packages/skills`)
and is linked into this repo the way consumers get it: `.claude/rules/quickdraw-*.md`
and `.claude/skills/quickdraw-*` are committed symlinks into
`node_modules/@fitzzero/quickdraw-skills` (which here is `packages/skills`), made
by `quickdraw-skills link` in `prepare`. Edit the files in `packages/skills`,
never the links; a new rule or skill needs `quickdraw-skills link` and its new
link committed. The rules' `paths` follow an app's layout (`apps/api/**`,
`apps/web/**`, `packages/shared/**` from the repo root), which no file of this
repo matches, so they never load here on their own: when you change how apps
use the framework, read the matching `packages/skills/rules/*.md` and keep it,
the skills and the README accurate. `docs/rfcs/0003-v5.md` section 17 records
what each 5.0 card actually built.
