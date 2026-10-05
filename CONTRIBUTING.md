# Contributing

## Branches

- Open pull requests against **`dev`**. It is the integration branch.
- **`main`** receives `dev` at each release.
- **`release/4.x`** holds 4.x (4.1.1 is `daf3d48`). 4.x hotfixes are cut from
  it, not from `dev` or `main`.
- Conveyor agents work on branches named `conveyor/<card-slug>`, or on a pack's
  feature branch, and follow the same rules.

## Layout

This is a bun workspace monorepo driven by turbo. The packages live in
`packages/` (`core`, `lint`, `skills`, `codemod`).

The design every 5.0 change implements is `docs/rfcs/0003-v5.md`.

Comments that explain what 5.0 replaced cite 4.1's code as
4.1 `src/<path>:<line>`: a line of the `release/4.x` branch, where 4.1's
sources live (4.1.1 is `daf3d48`). The lines are 4.1.0's too (`f767f68`),
since 4.1.1 changed only `src/server/rateLimit.ts`, which no comment cites.

## Before you push

```bash
bun install
bun run build && bun run typecheck && bun run lint && bun run test
bun run format:check
```

Husky runs `format:check` before each commit and `typecheck` plus `lint`
before each push. It does not run the tests, so run them yourself.

Always use `bun run <script>`, never bare `bun <script>`. Bare `bun test` and
`bun build` invoke bun's own tools instead of the package.json scripts. Never
use npm or pnpm to install.

## Commits

Conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `chore:`.

## Publishing

The owner publishes. Do not bump versions for release, push tags or run
`npm publish` in a pull request.
