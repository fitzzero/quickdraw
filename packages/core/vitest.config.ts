import { defineConfig } from "vitest/config";

// Three projects: `.test.ts` runs under node, `.test.tsx` (React hooks and
// components) under jsdom, and `.test-d.ts` (type tests) is type-checked, never
// run. Only `src/` is collected; `legacy-src/` (the 4.1 reference tree) and its
// tests are never run.
export default defineConfig({
  test: {
    // Kept from 4.1: @testing-library/react registers its automatic cleanup
    // only when `afterEach` is a global.
    globals: true,
    exclude: ["**/node_modules/**", "**/dist/**", "legacy-src/**"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**"],
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/*.test-d.ts", "**/testing.ts"],
    },
    projects: [
      {
        extends: true,
        test: {
          name: "node",
          include: ["src/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          include: ["src/**/*.test.tsx"],
          environment: "jsdom",
        },
      },
      {
        extends: true,
        test: {
          name: "types",
          typecheck: {
            enabled: true,
            only: true,
            include: ["src/**/*.test-d.ts"],
            tsconfig: "./tsconfig.json",
          },
        },
      },
    ],
  },
});
