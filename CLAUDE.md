# quickdraw-core — Project Context

`@fitzzero/quickdraw-core` is an npm package providing typed real-time
fullstack patterns: Socket.IO services with ACL (`BaseService` +
`ServiceRegistry`), fire-and-forget channels, OAuth/JWT auth utilities
(including a dev-only mock provider), Express helpers (rate limits), an MCP
bridge, and React client hooks (TanStack Query). The reference consumer is
the `quickdraw-chat` template (sibling checkout at `../quickdraw-chat`).

## Layout

```
src/
├── shared/    # Types exported from the package root (AccessLevel, ACL, ServiceResponse, …)
├── server/    # ./server export: BaseService, ServiceRegistry, createServer, channels,
│              #   auth/ (OAuth+JWT+mock provider), express/ (rate limits), mcp/, redis
└── client/    # ./client export: QuickdrawProvider, useService, useServiceQuery,
               #   useSubscription, useChannelSend, useRoomEvents, inputs/ (socket-synced MUI)
eslint-plugin-quickdraw/  # ./eslint-plugin export — framework lint rules (.mjs, shipped verbatim)
oxlint.base.jsonc         # Shared oxlint base config consumers extend (shipped verbatim)
eslint-config/            # Legacy ESLint flat config export — prefer oxlint.base.jsonc
```

Export map lives in `package.json` (`.` / `./server` / `./client` /
`./server/testing` / `./server/testing/prisma` / `./server/express` /
`./client/testing` / `./eslint-plugin` / `./eslint-config`). Tests sit next
to sources (`*.test.ts(x)`), run by vitest.

## Commands (bun, never npm/pnpm)

```bash
bun run build          # tsup → dist/ (ESM + d.ts + sourcemaps)
bun run dev            # tsup --watch
bun run test           # vitest run
bun run typecheck      # tsgo --noEmit
bun run lint           # oxlint src (extends ./oxlint.base.jsonc via .oxlintrc.json)
bun run format         # oxfmt --write .
```

## Linting

`oxlint.base.jsonc` is the framework's shipped lint baseline — consumers
extend it from `node_modules` (see README "Linting"). This repo dogfoods it
via `.oxlintrc.json`, which downgrades currently-violated rules to `warn`
(tracked debt — fix over time, then re-tighten) and exempts `src/client/**`
from the raw-socket rules (the framework layer is the sanctioned home of raw
`socket.emit`). When adding a lint rule that all quickdraw apps should get,
put it in `oxlint.base.jsonc` (or a new rule in `eslint-plugin-quickdraw/`),
not in downstream repos.

## Developing against quickdraw-chat

quickdraw-chat depends on the published npm version. For local iteration,
point the sibling checkout at this repo temporarily (e.g. `bun link`, or for
lint-config work just extend `../quickdraw/oxlint.base.jsonc`), but always
verify + commit against a published version.

## Publishing (manual, done by the user)

1. Bump `version` in package.json + CHANGELOG entry.
2. `npm publish` (runs `prepublishOnly` → `bun run build`; `files` ships
   `dist`, `eslint-plugin-quickdraw`, `eslint-config`, `oxlint.base.jsonc`).
3. Consumers: `bun update @fitzzero/quickdraw-core` and bump `^` ranges.

## Domain-Specific Context

Service/hook patterns (BaseService, defineMethod, ACL, client hooks) are in
`.claude/rules/` with path-targeted scoping — they load automatically when you
work on matching files.
