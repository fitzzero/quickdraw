import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

// Three projects: `.test.ts` runs under node, `.test.tsx` (React hooks and
// components) under jsdom, and `.test-d.ts` (type tests) is type-checked, never
// run. Tests are collected from `src/` and from `test/` (the end-to-end suite
// in `test/e2e/`, which renders the real client hooks against a real server
// in the test process; jsdom needs no setting for that: the server listens on
// a Node socket, and the client connects over jsdom's WebSocket).
// `legacy-src/` (the 4.1 reference tree) and its tests are never run.
//
// With QD_CLUSTER=1 (`bun run test:cluster`), and only then, two more
// projects run instead: `cluster` (node) and `cluster-dom` (jsdom). They run
// the end-to-end suite and the realtime, collection and revocation tests
// with every test app booted as two servers behind a real Valkey
// (`test/cluster/setup.ts`), plus the cluster's own tests in
// `test/cluster/`. They need the Valkey of `test/cluster/docker-compose.yml`
// (QD_VALKEY_URL, default redis://127.0.0.1:6399), which their global setup
// checks first. `bun run test` never runs them.

/** The node tests the cluster projects run split across two nodes, besides the end-to-end suite. */
const CLUSTER_NODE_TESTS = [
  "src/server/realtime/*.test.ts",
  "src/server/collections/*.test.ts",
  "src/server/emit/revocation.test.ts",
];

function clusterProject(
  name: string,
  environment: "node" | "jsdom",
  include: string[],
): TestProjectInlineConfiguration {
  return {
    extends: true,
    test: {
      name,
      include,
      environment,
      globalSetup: ["test/cluster/globalSetup.ts"],
      setupFiles: ["test/cluster/setup.ts"],
      env: { QD_CLUSTER: "1" },
      // Every test app is two servers and four Valkey connections.
      testTimeout: 20_000,
      hookTimeout: 60_000,
    },
  };
}

const clusterProjects: TestProjectInlineConfiguration[] =
  process.env.QD_CLUSTER === "1"
    ? [
        clusterProject("cluster", "node", [
          ...CLUSTER_NODE_TESTS,
          "test/e2e/*.test.ts",
          "test/cluster/*.test.ts",
        ]),
        clusterProject("cluster-dom", "jsdom", ["test/e2e/*.test.tsx", "test/cluster/*.test.tsx"]),
      ]
    : [];

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
          // The cluster's own tests need Valkey: they run in the cluster projects only.
          exclude: ["test/cluster/**"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "dom",
          include: ["src/**/*.test.tsx", "test/**/*.test.tsx"],
          exclude: ["test/cluster/**"],
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
      ...clusterProjects,
    ],
  },
});
