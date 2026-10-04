# quickdraw-core — Project Context

`@fitzzero/quickdraw-core` is an npm package providing typed real-time
fullstack services: contracts (`defineContract`), services
(`qd.defineService`) with declared access and row policies, tracked Prisma
writes that drive live entities, collections and change topics, kits
(read/write, search, sharing, admin, presence and streams, auth routes),
Socket.IO, HTTP, MCP and in-process transports, and a typed React client over
TanStack Query. The reference consumer is the `quickdraw-chat` template
(sibling checkout at `../quickdraw-chat`), still on 4.1.

## 5.0 in progress

`dev` is the 5.0 integration branch; `main` stays on 4.1 until 5.0 is
released. `docs/rfcs/0003-v5.md` is the design every 5.0 card implements, and
`docs/rfcs/0003-v5-audit.md` is the audit and rationale behind it. Where a
card's plan and the RFC disagree, follow the RFC and say so in the PR.

## Layout

A bun workspace monorepo driven by turbo (`turbo.json`). Packages per
`docs/rfcs/0003-v5.md` section 1:

```
packages/
├── core/        # @fitzzero/quickdraw-core — the framework (5.0)
│   ├── src/         # 5.0 sources; built by tsup → dist/ (one entry per export,
│   │                #   plus src/cli/quickdraw-docs.ts, the `quickdraw-docs` bin)
│   ├── test/        # e2e suite (test/e2e, fixture app test/fixtures/app.ts),
│   │                #   PGlite test schema (test/prisma), README examples (test/readme)
│   └── legacy-src/  # the 4.1 tree, kept as a porting reference (see below)
├── lint/        # @fitzzero/quickdraw-lint — oxlint plugin (plugin/, .mjs shipped
│                #   verbatim), oxlint.base.jsonc + oxlint.template.jsonc, `quickdraw-lint`
├── skills/      # @fitzzero/quickdraw-skills — agent rules (rules/*.md), skills
│                #   (skills/*/SKILL.md) and the `quickdraw-skills link` bin (bin/cli.mjs)
└── codemod/     # @fitzzero/quickdraw-codemod — the 4.x→5.0 codemod (ts-morph, src/ built by
                 #   tsup → dist/, the `quickdraw-codemod` bin); its tests run it on a 4.1
                 #   fixture app (test/fixtures/v4-app, snapshot in v4-app.expected) and
                 #   typecheck the guide's 4.x examples (test/guide-v4) against 4.1.0
bench/           # load harness (private workspace) + bench/apps/* + committed baselines;
                 #   a release tool, not a CI gate (bench/README.md, docs/benchmarks.md)
docs/rfcs/       # design records; 0003-v5.md is the 5.0 design
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

`packages/core/legacy-src/` keeps the exact relative paths and line numbers of
4.1 `src/`, so cards cite it by `legacy-src/<path>:<line>`. It is not built,
linted, typechecked, tested or published, and nothing may import it. Never
edit, reformat or lint-fix it; it is deleted at the 5.0 release. 4.x hotfixes
are cut from `main`.

The 4.1 tree's own layout (what `legacy-src/` holds):

```
legacy-src/
├── shared/    # Types exported from the package root (AccessLevel, ACL, ServiceResponse,
│              #   room helpers, QuickdrawEventMap, collection wire types, …)
├── server/    # ./server export: BaseService (+ BaseRpcService), ServiceRegistry,
│              #   createServer, collections (CollectionManager), channels,
│              #   auth/ (OAuth+JWT+mock provider), express/ (rate limits), mcp/, redis
└── client/    # ./client export: QuickdrawProvider, useService, useServiceQuery,
               #   useSubscription, useCollection (+ pure collectionCache),
               #   useChannelSend, useRoomEvents, inputs/ (socket-synced MUI)
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

In `packages/core`: `bun run readme:sync` (README examples, above) and
`bun run db:generate` (the gitignored test Prisma client; turbo runs it before
typecheck and test). `quickdraw-skills link --check` (from the root) checks
the committed `.claude/` links; CI runs it.

Husky hooks: pre-commit runs `bun run format:check`; pre-push runs
`bun run typecheck && bun run lint`. Node 24 (`.nvmrc`, `engines`).
CI (`.github/workflows/ci.yml`) runs the `quickdraw-skills link --check`,
lint, format:check, typecheck, build (plus the dist smoke test, publint and
arethetypeswrong), test and a secret scan on every pull request, whatever its
base branch, and on pushes to `main` and `dev`.

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
lets the README examples (`**/test/readme/**`) keep inline comments, and
ignores `**/legacy-src/**`. oxlint matches `overrides` and
`ignorePatterns` globs against paths as seen from where it runs, so keep them
`**/`-prefixed: lint runs from each package directory. When adding a lint rule
that all quickdraw apps should get, put it in `packages/lint/oxlint.base.jsonc`
(or a new rule in `packages/lint/plugin/`, with a test under
`packages/lint/plugin/test/`), not in downstream repos.

## Developing against quickdraw-chat

quickdraw-chat depends on the published npm version. For local iteration,
point the sibling checkout at this repo temporarily (e.g. `bun link`, or for
lint-config work just extend `../quickdraw/packages/lint/oxlint.base.jsonc`), but always
verify + commit against a published version.

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
