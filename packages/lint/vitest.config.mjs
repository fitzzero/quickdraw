// The plugin's tests run the oxlint CLI, several times for some
// (`check.test.mjs`, `oxlint.test.mjs`): more than vitest's 5 s default when
// the root's `bun run test` runs every package's suite at once.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { testTimeout: 30_000 },
});
