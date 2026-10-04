import { defineConfig } from "vitest/config";

// The tests run the codemod on copies of the fixture app (test/fixtures), so
// they parse and typecheck whole projects: give them time.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/.test-output/**", "test/fixtures/**"],
    testTimeout: 180_000,
    hookTimeout: 180_000,
  },
});
