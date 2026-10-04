# The migration guide's 4.x examples

The "before" code of `MIGRATION.md` (repository root): a small quickdraw 4.1
app whose files are copied into the guide by `bun run readme:sync` in
`packages/core`, like the README's examples. The codemod's tests typecheck it
against the published `@fitzzero/quickdraw-core` 4.1.0 and check that
`@fitzzero/quickdraw-lint`'s `no-v4-api` reports every file.
