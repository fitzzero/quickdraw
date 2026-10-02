# Contributing

## Branches

- Open pull requests against **`dev`**. It is the 5.0 integration branch.
- **`main`** stays on 4.1 until 5.0 is released. 4.x hotfixes are cut from
  `main`, not `dev`.
- Conveyor agents work on branches named `conveyor/<card-slug>`, or on a pack's
  feature branch, and follow the same rules.

## Layout

This is a bun workspace monorepo driven by turbo. The packages live in
`packages/` (`core`, `lint`, `skills`, `codemod`). `packages/core/legacy-src/`
is the 4.1 source kept as a porting reference: it is not built, linted,
typechecked or tested, and nothing may import it. Do not edit it.

The design every 5.0 change implements is `docs/rfcs/0003-v5.md`.

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
