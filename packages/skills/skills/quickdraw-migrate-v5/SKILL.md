---
name: quickdraw-migrate-v5
description: Move a quickdraw 4.x app to quickdraw 5.0 (BaseService classes, ServiceRegistry and useService hooks to contracts, defineService and the typed client). Use when asked to "upgrade quickdraw", "migrate to quickdraw 5", or when lint reports quickdraw/no-v4-api. A stub until the 5.0 migration guide and codemod ship.
---

# Migrate a quickdraw 4.x app to 5.0

**This skill is a stub.** The 5.0 migration guide and the codemod
(`@fitzzero/quickdraw-codemod`) are written after the 5.0 API settles; when
they ship, this skill walks through them. Until then, do not migrate a
production app by hand from this page: tell the user the guide is not out
yet, and offer the inventory below.

## What exists today

- **The removed-names table.** `@fitzzero/quickdraw-lint`'s `no-v4-api` rule
  lists every 4.x API 5.0 removed or moved, each with its replacement (the
  maps at the top of
  `node_modules/@fitzzero/quickdraw-lint/plugin/rules/no-v4-api.mjs`). It is
  the authoritative list until the guide replaces it.
- **An inventory.** With `@fitzzero/quickdraw-lint` installed and the app's
  `.oxlintrc.json` extending its `oxlint.base.jsonc`, `oxlint` reports each
  4.x use with its 5.0 replacement. Group the reports by file to size the
  work.
- **The 5.0 shape.** The rules `quickdraw-services.md`, `quickdraw-access.md`,
  `quickdraw-client.md` and `quickdraw-testing.md`, and the
  `quickdraw-new-service` skill, describe what each service becomes.
