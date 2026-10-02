# quickdraw-core — Project Context

`@fitzzero/quickdraw-core` is an npm package providing typed real-time
fullstack patterns: Socket.IO services with ACL (`BaseService` +
`ServiceRegistry`), fire-and-forget channels, OAuth/JWT auth utilities
(including a dev-only mock provider), Express helpers (rate limits), an MCP
bridge, and React client hooks (TanStack Query). The reference consumer is
the `quickdraw-chat` template (sibling checkout at `../quickdraw-chat`).

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
├── core/        # @fitzzero/quickdraw-core — the framework (5.0, being rebuilt)
│   ├── src/         # 5.0 sources; built by tsup → dist/. Holds the 4.1 modules
│   │                #   5.0 keeps unchanged until packs B–E add the new core
│   └── legacy-src/  # the 4.1 tree, kept as a porting reference (see below)
├── lint/        # @fitzzero/quickdraw-lint — oxlint plugin (plugin/, .mjs shipped
│                #   verbatim) + oxlint.base.jsonc, the shared base config
├── skills/      # @fitzzero/quickdraw-skills — private placeholder
└── codemod/     # @fitzzero/quickdraw-codemod — private placeholder
docs/rfcs/       # design records; 0003-v5.md is the 5.0 design
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

Large consumer services split as abstract `*ServiceCore` + method modules
wired by a thin concrete subclass — documented in README "Splitting Large
Services" (4.1); keep that section accurate when touching `defineMethod`.

Each package's export map lives in its own `package.json`. Core's has `.`,
`./server`, `./server/auth`, `./server/express`, `./client` and
`./testing/prisma` so far, with one tsup entry per export and shared chunks
(`splitting`); `packages/core/scripts/dist-smoke.mjs` checks the built output,
including the `"use client"` that must open `dist/client/index.js`. Tests sit
next to sources (`*.test.ts(x)`) and are typechecked.
Core's vitest config has two projects: `node` (`*.test.ts`) and `dom`
(`*.test.tsx`, jsdom).

## Commands (bun, never npm/pnpm)

Run from the repo root; turbo fans out to the packages that define the script.

```bash
bun install            # workspace install; `prepare` runs husky + conveyor-skills link
bun run build          # turbo: tsup → packages/core/dist/ (ESM + d.ts + sourcemaps)
bun run typecheck      # turbo: tsgo --noEmit per package (src + tests)
bun run lint           # turbo: oxlint -c ../../.oxlintrc.json src per package
bun run test           # turbo: vitest run per package
bun run format         # oxfmt --write . (repo-wide, not through turbo)
bun run format:check   # oxfmt --check . (repo-wide)
```

Husky hooks: pre-commit runs `bun run format:check`; pre-push runs
`bun run typecheck && bun run lint`. Node 24 (`.nvmrc`, `engines`).
CI (`.github/workflows/ci.yml`) runs lint, format:check, typecheck, build
(plus the dist smoke test, publint and arethetypeswrong), test and a secret
scan on every pull request, whatever its base branch, and on pushes to `main`
and `dev`.

## Linting

`packages/lint/oxlint.base.jsonc` is the framework's shipped lint baseline —
consumers extend it from `node_modules/@fitzzero/quickdraw-lint/` (see README
"Linting"). This repo dogfoods it via the root `.oxlintrc.json`, which
downgrades currently-violated rules to `warn` (tracked debt — fix over time,
then re-tighten), exempts `**/src/client/**` from the raw-socket rules (the
framework layer is the sanctioned home of raw `socket.emit`), and ignores
`**/legacy-src/**`. oxlint matches `overrides` and `ignorePatterns` globs
against paths as seen from where it runs, so keep them `**/`-prefixed: lint
runs from each package directory. When adding a lint rule that all quickdraw
apps should get, put it in `packages/lint/oxlint.base.jsonc` (or a new rule in
`packages/lint/plugin/`), not in downstream repos.

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

Service/hook patterns (BaseService, defineMethod, ACL, client hooks) are in
`.claude/rules/` with path-targeted scoping — they load automatically when you
work on matching files.
