import { defineConfig } from "vitest/config";

// Three projects: `.test.ts` runs under node, `.test.tsx` (React hooks and
// components) under jsdom, and `.test-d.ts` (type tests) is type-checked, never
// run. Tests are collected from `src/` and from `test/` (the end-to-end suite
// in `test/e2e/`, which renders the real client hooks against a real server
// in the test process; jsdom needs no setting for that: the server listens on
// a Node socket, and the client connects over jsdom's WebSocket).
// `legacy-src/` (the 4.1 reference tree) and its tests are never run.
export default defineConfig({
  test: {
    // Kept from 4.1: @testing-library/react registers its automatic cleanup
    // only when `afterEach` is a global.
    globals: true,
    // The README's example app (test/readme/apps, test/readme/packages) is
    // typechecked, never run: its tests show how an app's tests read.
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "legacy-src/**",
      "test/readme/apps/**",
      "test/readme/packages/**",
    ],
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
          include: ["src/**/*.test.ts", "test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          include: ["src/**/*.test.tsx", "test/**/*.test.tsx"],
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
