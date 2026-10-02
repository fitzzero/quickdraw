import { defineConfig } from "vitest/config";

// Two projects: `.test.ts` runs under node, `.test.tsx` (React hooks and
// components) under jsdom. Only `src/` is collected; `legacy-src/` (the 4.1
// reference tree) and its tests are never run.
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
      exclude: ["**/*.test.ts", "**/*.test.tsx", "**/testing.ts"],
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
    ],
  },
});
