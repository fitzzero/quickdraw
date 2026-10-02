import { defineConfig } from "vitest/config";

// Unit tests for the harness itself. They never start a server or touch
// Docker; the benchmark runs are a release tool, not a CI gate.
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
